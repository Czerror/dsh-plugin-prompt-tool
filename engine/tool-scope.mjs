/**
 * tool-scope — 工具面的作用域快照，避免各消费方把全局视图当成模型可见面。
 *
 * 返回两个字段，各自只服务一个调用方：
 * - visible：带 agent 的 `tools.schemas(agent)`，包含预设/祖先/本层工具；模型可见面。
 * - globalNames：不带 scope 的 `tools.schemas()` 名字集合；只供 `restrict` 过滤已知名。
 *
 * 全局原始 schema 与 visible-only 差集不外露；等真实诊断消费方出现再加字段。
 */

const schemaList = (tools, scope) => {
  if (typeof tools?.schemas !== 'function') return []
  const schemas = tools.schemas(scope)
  return Array.isArray(schemas) ? schemas : []
}

// 原集合和包装集合是同一步骤的两个身份；Agent 身份不同不能借用快照。
const steps = new WeakMap()
export const hasToolStep = toolSet => toolSet != null && steps.has(toolSet)
export const toolStepOf = (toolSet, agent) => toolSet != null && agent != null ? steps.get(toolSet)?.get(agent) : undefined
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
