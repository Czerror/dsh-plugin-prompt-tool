/**
 * tool-scope — 工具面的作用域快照，避免各消费方把全局视图当成模型可见面。
 *
 * 返回两个字段，各自只服务一个调用方：
 * - visible：带 agent 的 `tools.schemas(agent)`，包含预设/祖先/本层候选；发现目录。
 * - globalNames：不带 scope 的 `tools.schemas()` 名字集合，保留既有快照契约。
 *
 * 全局原始 schema 与 visible-only 差集不外露；等真实诊断消费方出现再加字段。
 */

import { symbols } from '@deepseek-ai/cordis'
import { SDK_SECTION_NAME, sdkToolNames } from './sdk-strip.mjs'

const schemaList = (tools, scope) => {
  if (typeof tools?.schemas !== 'function') return []
  const schemas = tools.schemas(scope)
  return Array.isArray(schemas) ? schemas : []
}

// 原集合和包装集合是同一步骤的两个身份；Agent 身份不同不能借用快照。
const steps = new WeakMap()
const selections = new WeakMap()
const assemblies = new WeakMap()
const catalogs = new WeakMap()
const standaloneWire = new WeakMap()
export const hasToolStep = toolSet => toolSet != null && steps.has(toolSet)
export const toolStepOf = (toolSet, agent) => toolSet != null && agent != null ? steps.get(toolSet)?.get(agent) : undefined
export function toolStepFor(context, agent = context?.agent) {
  if (context?.toolSet != null) return toolStepOf(context.toolSet, agent)
  const selection = context?.modelSelection
  return selection != null && typeof selection === 'object' && agent != null ? selections.get(selection)?.get(agent) : undefined
}
export function associateToolSelection(selection, agent, step) {
  if (selection == null || typeof selection !== 'object') return
  let agents = selections.get(selection)
  if (agents === undefined) selections.set(selection, agents = new WeakMap())
  const previous = agents.get(agent)
  // 歧义不随 dispose 恢复：同一旧选择不能在释放后意外指向另一步。
  if (previous === undefined) agents.set(agent, step)
  else if (previous !== step) agents.set(agent, null)
}
export function toolStepContext(context) {
  const step = toolStepFor(context)
  return step == null ? context : { ...context, toolSet: step.toolSet, modelSelection: step.modelSelection }
}
export function associateToolAssembly(assembly, agent, step) { assemblies.set(assembly, { agent, step }) }
export function toolAssemblyContext(assembly, context) {
  const entry = assemblies.get(assembly)
  if (entry === undefined) return context
  if (entry.agent !== context.agent || entry.step.status !== 'sealed') return undefined
  return { ...context, toolSet: entry.step.toolSet, modelSelection: entry.step.modelSelection }
}
// 目录正文只读，等所有工具面动作结算后重算；其它模板不重复求值。
export function beginToolCatalog(context) { catalogs.set(context, { pending: [] }) }
/** 独立动作可从原服务装配，连同从 Cordis 属性获取的受管入口一起复用当前投影。 */
export function installStandaloneToolWire(ctx) {
  const dependency = ctx.inject(['systemPrompt'], child => {
    const service = child.systemPrompt[symbols.original] ?? child.systemPrompt
    let state = standaloneWire.get(service)
    if (state === undefined) {
      const original = service.assemble
      state = { owners: 0 }
      const current = state
      const assemble = function (context = {}) {
        if (current.owners === 0 || catalogs.has(context)) return Reflect.apply(original, this, [context])
        const captured = { ...context }
        beginToolCatalog(captured)
        return Promise.resolve(Reflect.apply(original, this, [captured])).then(assembly => settleToolWire(assembly, captured))
      }
      state.release = () => { if (service.assemble === assemble) service.assemble = original }
      service.assemble = assemble
      standaloneWire.set(service, state)
    }
    state.owners++
    return () => {
      if (--state.owners !== 0) return
      standaloneWire.delete(service)
      state.release()
    }
  })
  return () => dependency.dispose()
}
export function deferToolWire(context, project) {
  const frame = catalogs.get(context)
  if (frame !== undefined) (frame.wire ??= []).push(project)
}
export function settleToolWire(assembly, context) {
  const frame = catalogs.get(context)
  const projections = frame?.wire
  if (projections === undefined) return assembly
  frame.wire = undefined
  for (const project of projections) assembly = project(assembly)
  return assembly
}
export function deferToolCatalog(context, render) {
  const frame = catalogs.get(context)
  if (frame === undefined) return false
  frame.pending.push(render)
  return true
}
export async function settleToolCatalog(assembly, context) {
  const frame = catalogs.get(context)
  if (frame === undefined) return
  // 裸装配的 SDK 只用于展示；步骤权限仍只取原集合，不从 SDK 文本反推。
  frame.visible = new Set([...(assembly.tools?.map(tool => tool.name) ?? []),
    ...assembly.sections.filter(section => section.name === SDK_SECTION_NAME).flatMap(section => sdkToolNames(section.text)),
  ])
  for (const render of frame.pending) await render(assembly)
  frame.pending.length = 0
}
export function toolCatalogNames(context) {
  if (Object.hasOwn(context ?? {}, 'toolCatalogNames')) return context.toolCatalogNames
  const step = toolStepFor(context)
  if (catalogs.get(context)?.visible !== undefined) return step?.allowed ?? catalogs.get(context).visible
  if (step !== undefined) return step?.status === 'sealed' ? step.allowed : null
  return undefined
}
export function associateToolStep(original, wrapped, agent, step) {
  for (const identity of [original, wrapped]) {
    let agents = steps.get(identity)
    if (agents === undefined) steps.set(identity, agents = new WeakMap())
    agents.set(agent, step)
  }
}

export function toolScopeSnapshot(tools, agent) {
  const global = schemaList(tools)
  const visible = agent === undefined ? global : schemaList(tools, agent)
  const globalNames = new Set(global.map((schema) => schema?.name).filter((name) => typeof name === 'string'))
  return { visible, globalNames }
}
