/** module.yml.rules 的唯一读取与局部写事务；所有候选共享引擎编译校验。 */
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { isMap, isSeq, isScalar, parseDocument } from 'yaml'
import type { Node, Scalar, YAMLMap, YAMLSeq } from 'yaml'
import type { RuleDefinition, RuleEdit } from '../shared/rules.ts'
import { RULE_OWNED_MODEL_PARAMS } from '../shared/rules.ts'
import { LEGACY_PROMPT_PARAM_KEYS } from '../shared/legacy-prompt-params.ts'
import { assertModuleDirectory } from './module-install.ts'
import { MODULE_DEFINITION_FILE } from './paths.ts'
import { atomicWriteTextFile } from './text-file.ts'
import { invalidateModuleSpec } from './manifest.ts'
// @ts-expect-error 引擎纯 ESM 是规则形状和互斥校验的唯一实现。
import { compileRules } from '../../engine/rule-spec.mjs'

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const revisionOf = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex')
export class ModuleRulesError extends Error {
  readonly status: 400 | 403 | 409
  readonly code: string
  constructor(message: string, status: 400 | 403 | 409 = 400, code = 'rules-invalid') {
    super(message)
    this.name = 'ModuleRulesError'
    this.status = status
    this.code = code
  }
}

/** 旧源只能离线迁移；不得在读取、物化或运行时隐式双读。 */
export function assertCanonicalRuleSource(source: unknown): asserts source is Record<string, unknown> {
  if (!record(source)) throw new ModuleRulesError('module.yml 必须是对象')
  const old = ['promptConfigs', 'triggers'].filter(key => Object.hasOwn(source, key))
  if (Array.isArray(source.modules)) for (const name of source.modules) if (name === 'prompt-config-engine' || name === 'declared-triggers') old.push(String(name))
  const parameterSources = [source.params, ...(record(source.layerSettings) ? Object.values(source.layerSettings) : [])]
  for (const values of parameterSources) if (record(values)) for (const key of [...LEGACY_PROMPT_PARAM_KEYS, ...RULE_OWNED_MODEL_PARAMS]) if (Object.hasOwn(values, key)) old.push(key)
  if (old.length > 0) throw new ModuleRulesError(`模块仍含旧规则来源（${[...new Set(old)].join(', ')}）；请先运行 migrate:rules 离线迁移`, 409, 'rules-migration-required')
  if (source.rules !== undefined && !Array.isArray(source.rules)) throw new ModuleRulesError('module.yml.rules 必须是数组')
}

export function rulePromptConfigOptions(directory: string, strategy?: unknown) {
  const templateBaseUrl = pathToFileURL(join(directory, 'rules.yml'))
  const strategyDir = typeof strategy !== 'string' || strategy.length === 0 ? undefined
    : isAbsolute(strategy) ? pathToFileURL(strategy).href : new URL(strategy, templateBaseUrl).href
  return { templateBaseUrl, templatePresetRoot: pathToFileURL(directory.replace(/[\\/]?$/, '/')), strategyDir }
}

function readDocument(directory: string) {
  const dir = assertModuleDirectory(dirname(directory), basename(directory))
  const file = join(dir, MODULE_DEFINITION_FILE)
  const bytes = readFileSync(file)
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  const doc = parseDocument(text, { logLevel: 'silent' })
  if (doc.errors.length > 0) throw new ModuleRulesError(`模块 YAML 无法解析：${doc.errors[0]!.message}`)
  const source: unknown = doc.toJS()
  assertCanonicalRuleSource(source)
  for (const [index, rule] of ((source.rules ?? []) as unknown[]).entries()) {
    if (!record(rule) || typeof rule.id !== 'string' || rule.id.trim().length === 0 || !Array.isArray(rule.do)
      || rule.do.some(action => !record(action) || typeof action.id !== 'string' || action.id.trim().length === 0
        || typeof action.kind !== 'string' || action.kind.trim().length === 0)) throw new ModuleRulesError(`规则 rules[${index}] 的身份或动作数组结构无效，请修复模块定义`)
  }
  return { dir, file, bytes, doc, source, revision: revisionOf(bytes) }
}

/** 只读取磁盘规则身份；编辑、装配与物化分别在其候选边界调用同一个 compileRules。 */
export function readModuleRules(directory: string): { rules: RuleDefinition[]; revision: string } {
  const snapshot = readDocument(directory)
  return { rules: structuredClone((snapshot.source.rules ?? []) as RuleDefinition[]), revision: snapshot.revision }
}

/** 递归更新被编辑规则，保留未改动节点的注释；动作以稳定 id 对齐，不按新位置误认。 */
function replaceNode(doc: ReturnType<typeof parseDocument>, original: unknown, value: unknown): Node {
  if (isScalar(original) && (value === null || typeof value !== 'object')) {
    const node = original.clone() as Scalar; node.value = value; return node
  }
  if (record(value) && isMap(original)) {
    const node = original.clone() as YAMLMap
    for (const pair of original.items) if (!Object.hasOwn(value, String(pair.key))) node.delete(pair.key)
    for (const [key, child] of Object.entries(value)) node.set(key, replaceNode(doc, original.get(key, true), child))
    return node
  }
  if (Array.isArray(value) && isSeq(original)) {
    const node = original.clone() as YAMLSeq
    node.items = value.map((child, index) => {
      const previous = record(child) && typeof child.id === 'string'
        ? original.items.find(item => isMap(item) && item.get('id') === child.id) : original.items[index]
      return replaceNode(doc, previous, child)
    })
    return node
  }
  const node = doc.createNode(value)
  if (record(original)) {
    if (typeof original.comment === 'string') node.comment = original.comment
    if (typeof original.commentBefore === 'string') node.commentBefore = original.commentBefore
  }
  return node
}

export interface ModuleRuleEditRequest {
  expectedRevision: string
  edits?: RuleEdit[]
  activateRuleId?: string
  validateOnly?: boolean
}

export function editModuleRules(directory: string, request: ModuleRuleEditRequest): { rules: RuleDefinition[]; revision: string } {
  const snapshot = readDocument(directory)
  if (!record(request) || typeof request.expectedRevision !== 'string' || !/^[a-f0-9]{64}$/i.test(request.expectedRevision)
    || Object.keys(request).some(key => !['expectedRevision', 'edits', 'activateRuleId', 'validateOnly'].includes(key))
    || (request.validateOnly !== undefined && typeof request.validateOnly !== 'boolean')
    || (request.edits !== undefined && !Array.isArray(request.edits))
    || (request.activateRuleId !== undefined && (typeof request.activateRuleId !== 'string' || request.activateRuleId.length === 0))) throw new ModuleRulesError('规则事务字段或版本格式不合法')
  if (snapshot.revision !== request.expectedRevision) throw new ModuleRulesError('模块文件已变化，请重新读取规则', 409, 'rules-conflict')
  if (!Array.isArray(snapshot.source.modules)) throw new ModuleRulesError('当前组合没有可编辑的 modules 清单')
  const previous = (snapshot.source.rules ?? []) as RuleDefinition[]
  const rules = structuredClone(previous)
  const originalRules = snapshot.doc.get('rules', true)
  const ruleNodes = (isSeq(originalRules) ? originalRules.clone() : snapshot.doc.createNode([])) as YAMLSeq
  const originalOrder = snapshot.doc.get('configOrder', true)
  const orderNodes = (isMap(originalOrder) ? originalOrder.clone() : snapshot.doc.createNode({})) as YAMLMap
  const order = record(snapshot.source.configOrder) ? { ...snapshot.source.configOrder } : {}
  if (snapshot.source.configOrder !== undefined && !record(snapshot.source.configOrder)) throw new ModuleRulesError('configOrder 必须是对象')
  const touched = new Set<string>()
  for (const edit of request.edits ?? []) {
    if (!record(edit) || Object.keys(edit).some(key => !['previousId', 'rule'].includes(key))
      || (edit.previousId !== null && (typeof edit.previousId !== 'string' || edit.previousId.length === 0))
      || (edit.rule !== null && !record(edit.rule)) || (edit.previousId === null && edit.rule === null)) throw new ModuleRulesError('规则修改项不合法')
    if (edit.previousId !== null && touched.has(edit.previousId)) throw new ModuleRulesError('同一规则不能在一次事务中重复修改')
    const index = edit.previousId === null ? -1 : rules.findIndex(rule => rule.id === edit.previousId)
    if (edit.previousId !== null && index < 0) throw new ModuleRulesError(`规则 ${edit.previousId} 已不存在`, 409, 'rules-conflict')
    if (edit.previousId !== null) touched.add(edit.previousId)
    if (edit.rule === null) { rules.splice(index, 1); ruleNodes.items.splice(index, 1); delete order[edit.previousId!]; continue }
    if (rules.some((rule, at) => at !== index && rule.id === edit.rule!.id)) throw new ModuleRulesError(`重复规则标识：${edit.rule.id}`)
    if (index < 0) { rules.push(structuredClone(edit.rule)); ruleNodes.items.push(snapshot.doc.createNode(edit.rule)) }
    else {
      rules[index] = structuredClone(edit.rule)
      // index 仍对应 previousId；先原位更新，避免新身份找不到旧节点而丢失深层注释。
      ruleNodes.items[index] = replaceNode(snapshot.doc, ruleNodes.items[index], edit.rule)
      if (edit.previousId !== edit.rule.id && Object.hasOwn(order, edit.previousId!)) {
        order[edit.rule.id] = order[edit.previousId!]; delete order[edit.previousId!]
        const pair = orderNodes.items.find(item => String(item.key) === edit.previousId)
        if (pair) pair.key = replaceNode(snapshot.doc, pair.key, edit.rule.id)
      }
    }
  }
  if (request.activateRuleId !== undefined) {
    const target = rules.find(rule => rule.id === request.activateRuleId)
    if (target === undefined) throw new ModuleRulesError('要启用的规则不存在')
    target.enabled = true
    if (typeof target.group === 'string' && target.group.trim().length > 0) {
      const peers = rules.filter(rule => rule.group === target.group)
      if (peers.some(rule => rule.exclusive === true)) for (const peer of peers) if (peer !== target) peer.enabled = false
    }
  }
  const moduleConfigs = record(snapshot.source.moduleConfigs) ? snapshot.source.moduleConfigs : {}
  const engineOptions = record(moduleConfigs['rule-engine']) ? moduleConfigs['rule-engine'] : {}
  try {
    compileRules(rules, { moduleId: basename(snapshot.dir), configOrder: order, variables: snapshot.source.variables, variablesEnabled: snapshot.source.variablesEnabled, personaComplete: record(snapshot.source.persona) && snapshot.source.persona.complete === true, promptConfigOptions: rulePromptConfigOptions(snapshot.dir, engineOptions.strategyDir) })
  }
  catch (error) { throw new ModuleRulesError(String((error as Error).message ?? error)) }
  if (JSON.stringify(previous) === JSON.stringify(rules) && JSON.stringify(snapshot.source.configOrder ?? {}) === JSON.stringify(order)) return { rules, revision: snapshot.revision }
  snapshot.doc.set('rules', replaceNode(snapshot.doc, ruleNodes, rules))
  if (Object.keys(order).length > 0) snapshot.doc.set('configOrder', replaceNode(snapshot.doc, orderNodes, order))
  else snapshot.doc.delete('configOrder')
  const expected = { ...snapshot.source, rules, configOrder: order } as Record<string, unknown>
  if (Object.keys(order).length === 0) delete expected.configOrder
  try {
    if (!isDeepStrictEqual(snapshot.doc.toJS(), expected)) throw new Error('shared alias changed')
  } catch {
    throw new ModuleRulesError('YAML 共享引用会改变其他定义；请先解除相关引用后再编辑')
  }
  if (request.validateOnly) return { rules, revision: snapshot.revision }
  const next = snapshot.doc.toString()
  atomicWriteTextFile(snapshot.file, next, { mode: statSync(snapshot.file).mode, beforeReplace: () => {
    if (assertModuleDirectory(dirname(snapshot.dir), basename(snapshot.dir)) !== snapshot.dir
      || revisionOf(readFileSync(snapshot.file)) !== snapshot.revision) throw new ModuleRulesError('写入前模块再次变化，请重新读取', 409, 'rules-conflict')
  } })
  invalidateModuleSpec(snapshot.dir)
  return { rules, revision: revisionOf(next) }
}
