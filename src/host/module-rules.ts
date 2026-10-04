/** 经验证规则切片的局部事务；正文和状态各有独立 CAS。 */
import { isDeepStrictEqual } from 'node:util'
import { isMap, isSeq, isScalar, parseDocument } from 'yaml'
import type { Node, Scalar, YAMLMap, YAMLSeq } from 'yaml'
import type { RuleDefinition, RuleEdit, RuleRevisions } from '../shared/rules.ts'
import { assertRuleFileId, commitModuleDefinition, ensureModuleSlices, ModuleRulesError, validateModuleDefinitionText } from './module-storage.ts'
import type { ModuleDefinitionSnapshot } from './module-storage.ts'
import { invalidateModuleSpec } from './manifest.ts'
export { assertCanonicalRuleSource, rulePromptConfigOptions, ModuleRulesError, readRulesDir, ruleSettingsPath, ruleVariablesPath, ensureModuleSlices, decomposeModule } from './module-storage.ts'

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
export interface ModuleRulesSnapshot { rules: RuleDefinition[]; revisions: RuleRevisions; readonly revision: string }
function publicSnapshot(snapshot: ModuleDefinitionSnapshot, rules = snapshot.rules): ModuleRulesSnapshot {
  // 旧 host API 仍可读取 revision；规范 JSON 输出仅含 revisions。
  return Object.defineProperty({ rules: structuredClone(rules), revisions: structuredClone(snapshot.revisions) }, 'revision', { value: snapshot.revision }) as ModuleRulesSnapshot
}
export function readModuleRules(directory: string): ModuleRulesSnapshot { return publicSnapshot(ensureModuleSlices(directory)) }

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
  expectedRevision?: string
  expectedRevisions?: Partial<RuleRevisions>
  edits?: RuleEdit[]
  activateRuleId?: string
  validateOnly?: boolean
}

export function editModuleRules(directory: string, request: ModuleRuleEditRequest): ModuleRulesSnapshot {
  const snapshot = ensureModuleSlices(directory, { writable: request?.validateOnly !== true })
  const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value)
  if (!record(request) || (request.expectedRevision === undefined && !record(request.expectedRevisions))
    || (request.expectedRevision !== undefined && !hash(request.expectedRevision))
    || Object.keys(request).some(key => !['expectedRevision', 'expectedRevisions', 'edits', 'activateRuleId', 'validateOnly'].includes(key))
    || (request.validateOnly !== undefined && typeof request.validateOnly !== 'boolean')
    || (request.edits !== undefined && !Array.isArray(request.edits))
    || (request.activateRuleId !== undefined && (typeof request.activateRuleId !== 'string' || request.activateRuleId.length === 0))) throw new ModuleRulesError('规则事务字段或版本格式不合法')
  if (request.expectedRevisions !== undefined && (!record(request.expectedRevisions)
    || Object.keys(request.expectedRevisions).some(key => !['rules', 'settings', 'variables'].includes(key))
    || (request.expectedRevisions.rules !== undefined && (!record(request.expectedRevisions.rules) || Object.values(request.expectedRevisions.rules).some(value => !hash(value))))
    || (request.expectedRevisions.settings !== undefined && !hash(request.expectedRevisions.settings))
    || (request.expectedRevisions.variables !== undefined && !hash(request.expectedRevisions.variables)))) throw new ModuleRulesError('规则版本对象不合法')
  const legacy = request.expectedRevisions === undefined
  const expectedRevisions = request.expectedRevisions as Partial<RuleRevisions> | undefined
  if (legacy && snapshot.revision !== request.expectedRevision) throw new ModuleRulesError('模块文件已变化，请重新读取规则', 409, 'rules-conflict')
  const checkSettings = () => { if (!legacy && expectedRevisions?.settings !== snapshot.revisions.settings) throw new ModuleRulesError('规则状态已变化，请重新读取', 409, 'rules-conflict') }
  const checkRule = (id: string) => { if (!legacy && expectedRevisions?.rules?.[id] !== snapshot.revisions.rules[id]) throw new ModuleRulesError(`规则 ${id} 正文已变化，请重新读取`, 409, 'rules-conflict') }
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
    if (!record(edit) || Object.keys(edit).some(key => !['previousId', 'rule', 'settingsChanged'].includes(key))
      || (edit.settingsChanged !== undefined && typeof edit.settingsChanged !== 'boolean')
      || (edit.previousId !== null && (typeof edit.previousId !== 'string' || edit.previousId.length === 0))
      || (edit.rule !== null && !record(edit.rule)) || (edit.previousId === null && edit.rule === null)) throw new ModuleRulesError('规则修改项不合法')
    if (edit.previousId !== null && touched.has(edit.previousId)) throw new ModuleRulesError('同一规则不能在一次事务中重复修改')
    const index = edit.previousId === null ? -1 : rules.findIndex(rule => rule.id === edit.previousId)
    if (edit.previousId !== null && index < 0) throw new ModuleRulesError(`规则 ${edit.previousId} 已不存在`, 409, 'rules-conflict')
    if (edit.previousId !== null) { assertRuleFileId(edit.previousId); checkRule(edit.previousId); touched.add(edit.previousId) }
    if (edit.previousId === null || edit.rule === null || edit.previousId !== edit.rule.id || edit.settingsChanged === true) checkSettings()
    if (edit.rule === null) { rules.splice(index, 1); ruleNodes.items.splice(index, 1); delete order[edit.previousId!]; continue }
    assertRuleFileId(edit.rule.id)
    const replacement = structuredClone(edit.rule) as unknown as RuleDefinition
    if (!legacy && index >= 0 && edit.settingsChanged !== true) {
      const current = rules[index]!
      delete replacement.enabled; delete replacement.group; delete replacement.exclusive
      for (const key of ['enabled', 'group', 'exclusive'] as const) if (Object.hasOwn(current, key)) Object.assign(replacement, { [key]: current[key] })
    }
    if (rules.some((rule, at) => at !== index && rule.id === replacement.id)) throw new ModuleRulesError(`重复规则标识：${replacement.id}`)
    if (index < 0) { rules.push(replacement); ruleNodes.items.push(snapshot.doc.createNode(replacement)) }
    else {
      rules[index] = replacement
      // index 仍对应 previousId；先原位更新，避免新身份找不到旧节点而丢失深层注释。
      ruleNodes.items[index] = replaceNode(snapshot.doc, ruleNodes.items[index], replacement)
      if (edit.previousId !== edit.rule.id && Object.hasOwn(order, edit.previousId!)) {
        order[edit.rule.id] = order[edit.previousId!]; delete order[edit.previousId!]
        const pair = orderNodes.items.find(item => String(item.key) === edit.previousId)
        if (pair) pair.key = replaceNode(snapshot.doc, pair.key, edit.rule.id)
      }
    }
  }
  if (request.activateRuleId !== undefined) {
    checkSettings()
    const target = rules.find(rule => rule.id === request.activateRuleId)
    if (target === undefined) throw new ModuleRulesError('要启用的规则不存在')
    target.enabled = true
    if (typeof target.group === 'string' && target.group.trim().length > 0) {
      const peers = rules.filter(rule => rule.group === target.group)
      if (peers.some(rule => rule.exclusive === true)) for (const peer of peers) if (peer !== target) peer.enabled = false
    }
  }
  const ids = new Set(rules.map(rule => rule.id))
  for (const id of Object.keys(order)) if (!ids.has(id)) delete order[id]
  let tail = Math.max(-10, ...Object.values(order).map(Number)) + 10
  for (const rule of rules) if (order[rule.id] === undefined) { order[rule.id] = tail; tail += 10 }
  if (JSON.stringify(previous) === JSON.stringify(rules) && JSON.stringify(snapshot.source.configOrder ?? {}) === JSON.stringify(order)) return publicSnapshot(snapshot)
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
  // 与保存共用完整候选校验，但验证请求不写切片或完整定义。
  if (request.validateOnly) {
    validateModuleDefinitionText(snapshot.dir, snapshot.doc.toString())
    return publicSnapshot(snapshot, rules)
  }
  const saved = commitModuleDefinition(snapshot, snapshot.doc)
  invalidateModuleSpec(snapshot.dir)
  return publicSnapshot(saved)
}
