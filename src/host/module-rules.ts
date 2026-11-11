/** 经验证规则切片的局部事务；正文和状态各有独立 CAS。 */
import { basename, dirname, join } from 'node:path'
import { isMap, isSeq, isScalar, parseDocument } from 'yaml'
import type { Node, Scalar, YAMLMap, YAMLSeq } from 'yaml'
import type { RuleDefinition, RuleEdit, RuleRevisions } from '../shared/rules.ts'
import { assertRuleFileId, commitModuleDefinition, ensureModuleSlices, loadModuleDefinition, nextModuleConfigSequence, validateModuleDefinitionText } from './module-slices.ts'
import type { ModuleDefinitionSnapshot } from './module-slices.ts'
import { ModuleWriteError, serializeWithoutSharedAlias } from './module-write.ts'
import { invalidateModuleSpec } from './module-spec.ts'
import { reservedConfigSequences } from './module-config-order.ts'
import { enabledModuleIds } from './config-store.ts'
import { assertCrossModuleGroups, assertCrossModuleParticipantPaths } from './module-rule-groups.ts'

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
export interface ModuleRulesSnapshot { rules: RuleDefinition[]; revisions: RuleRevisions }
function publicSnapshot(snapshot: ModuleDefinitionSnapshot, rules = snapshot.rules): ModuleRulesSnapshot {
  return { rules: structuredClone(rules), revisions: structuredClone(snapshot.revisions) }
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
  expectedRevisions: Partial<RuleRevisions>
  expectedRulesAbsent?: true
  edits?: RuleEdit[]
  activateRuleId?: string
  validateOnly?: boolean
}

export interface ModuleRuleCreateRequest {
  rule: RuleDefinition
  expectedRulesAbsent?: true
}

/** 服务端直写模板规则：目标内分配 id，版本和源 CAS 仍由同一规则事务负责。 */
export function createModuleRule(directory: string, request: ModuleRuleCreateRequest): { snapshot: ModuleRulesSnapshot; createdRuleId: string } {
  if (!record(request) || Object.keys(request).some(key => !['rule', 'expectedRulesAbsent'].includes(key))
    || !record(request.rule) || (request.expectedRulesAbsent !== undefined && request.expectedRulesAbsent !== true)) {
    throw new ModuleWriteError('规则创建载荷不合法')
  }
  if (typeof request.rule.id !== 'string') throw new ModuleWriteError('规则创建载荷不合法')
  try { assertRuleFileId(request.rule.id) } catch (error) { throw new ModuleWriteError(String((error as Error).message ?? error)) }
  // shortcut: 最多重试三次并发追加；若宿主竞争持续，应进入显式冲突重试。
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = ensureModuleSlices(directory, { writable: false })
    if (request.expectedRulesAbsent === true && Object.hasOwn(current.source, 'rules')) {
      throw new ModuleWriteError('目标模块已声明 rules，请重新读取后保存', 409, 'rules-conflict')
    }
    if (request.expectedRulesAbsent !== true && !Object.hasOwn(current.source, 'rules')) {
      throw new ModuleWriteError('目标模块尚未声明 rules，请重新确认后创建', 409, 'rules-conflict')
    }
    const base = request.rule.id
    const used = new Set(current.rules.map(rule => rule.id.toLowerCase()))
    let id = base
    for (let suffix = 2; used.has(id.toLowerCase()); suffix++) id = `${base}-${suffix}`
    try {
      const snapshot = editModuleRules(current.dir, {
        expectedRevisions: current.revisions,
        ...(request.expectedRulesAbsent === true ? { expectedRulesAbsent: true } : {}),
        edits: [{ previousId: null, rule: { ...structuredClone(request.rule), id } }],
      })
      return { snapshot, createdRuleId: id }
    } catch (error) {
      if (error instanceof ModuleWriteError && error.persisted) error.createdRuleId = id
      if (!(error instanceof ModuleWriteError) || error.code !== 'rules-conflict' || request.expectedRulesAbsent === true || attempt === 2) throw error
    }
  }
  throw new ModuleWriteError('规则创建冲突，请重试', 409, 'rules-conflict')
}

export function editModuleRules(directory: string, request: ModuleRuleEditRequest): ModuleRulesSnapshot {
  const snapshot = ensureModuleSlices(directory, { writable: request?.expectedRulesAbsent !== true && request?.validateOnly !== true })
  const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value)
  if (!record(request) || !record(request.expectedRevisions)
    || Object.keys(request).some(key => !['expectedRevisions', 'expectedRulesAbsent', 'edits', 'activateRuleId', 'validateOnly'].includes(key))
    || (request.expectedRulesAbsent !== undefined && request.expectedRulesAbsent !== true)
    || (request.validateOnly !== undefined && typeof request.validateOnly !== 'boolean')
    || (request.edits !== undefined && !Array.isArray(request.edits))
    || (request.activateRuleId !== undefined && (typeof request.activateRuleId !== 'string' || request.activateRuleId.length === 0))) throw new ModuleWriteError('规则事务字段或版本格式不合法')
  if (Object.keys(request.expectedRevisions).some(key => !['rules', 'settings', 'variables'].includes(key))
    || (request.expectedRevisions.rules !== undefined && (!record(request.expectedRevisions.rules) || Object.values(request.expectedRevisions.rules).some(value => !hash(value))))
    || (request.expectedRevisions.settings !== undefined && !hash(request.expectedRevisions.settings))
    || (request.expectedRevisions.variables !== undefined && !hash(request.expectedRevisions.variables))) throw new ModuleWriteError('规则版本对象不合法')
  if (request.expectedRulesAbsent === true && (request.validateOnly === true || request.activateRuleId !== undefined
    || !Array.isArray(request.edits) || request.edits.length === 0
    || request.edits.some(edit => !record(edit) || edit.previousId !== null || edit.rule === null))) {
    throw new ModuleWriteError('规则首写只允许新增规则编辑')
  }
  if (request.expectedRulesAbsent === true && Object.hasOwn(snapshot.source, 'rules')) {
    throw new ModuleWriteError('目标模块已声明 rules，请重新读取后保存', 409, 'rules-conflict')
  }
  const expectedRevisions = request.expectedRevisions
  const checkSettings = () => { if (expectedRevisions.settings !== snapshot.revisions.settings) throw new ModuleWriteError('规则状态已变化，请重新读取', 409, 'rules-conflict') }
  const checkRule = (id: string) => { if (expectedRevisions.rules?.[id] !== snapshot.revisions.rules[id]) throw new ModuleWriteError(`规则 ${id} 正文已变化，请重新读取`, 409, 'rules-conflict') }
  if (!Array.isArray(snapshot.source.modules)) throw new ModuleWriteError('当前组合没有可编辑的 modules 清单')
  const previous = (snapshot.source.rules ?? []) as RuleDefinition[]
  const rules = structuredClone(previous)
  const originalRules = snapshot.doc.get('rules', true)
  const ruleNodes = (isSeq(originalRules) ? originalRules.clone() : snapshot.doc.createNode([])) as YAMLSeq
  const originalOrder = snapshot.doc.get('configOrder', true)
  const orderNodes = (isMap(originalOrder) ? originalOrder.clone() : snapshot.doc.createNode({})) as YAMLMap
  const order = record(snapshot.source.configOrder) ? { ...snapshot.source.configOrder } : {}
  if (snapshot.source.configOrder !== undefined && !record(snapshot.source.configOrder)) throw new ModuleWriteError('configOrder 必须是对象')
  const touched = new Set<string>()
  for (const edit of request.edits ?? []) {
    if (!record(edit) || Object.keys(edit).some(key => !['previousId', 'rule', 'settingsChanged'].includes(key))
      || (edit.settingsChanged !== undefined && typeof edit.settingsChanged !== 'boolean')
      || (edit.previousId !== null && (typeof edit.previousId !== 'string' || edit.previousId.length === 0))
      || (edit.rule !== null && !record(edit.rule)) || (edit.previousId === null && edit.rule === null)) throw new ModuleWriteError('规则修改项不合法')
    if (edit.previousId !== null && touched.has(edit.previousId)) throw new ModuleWriteError('同一规则不能在一次事务中重复修改')
    const index = edit.previousId === null ? -1 : rules.findIndex(rule => rule.id === edit.previousId)
    if (edit.previousId !== null && index < 0) throw new ModuleWriteError(`规则 ${edit.previousId} 已不存在`, 409, 'rules-conflict')
    if (edit.previousId !== null) { assertRuleFileId(edit.previousId); checkRule(edit.previousId); touched.add(edit.previousId) }
    if (edit.previousId === null || edit.rule === null || edit.previousId !== edit.rule.id || edit.settingsChanged === true) checkSettings()
    if (edit.rule === null) { rules.splice(index, 1); ruleNodes.items.splice(index, 1); delete order[edit.previousId!]; continue }
    assertRuleFileId(edit.rule.id)
    const replacement = structuredClone(edit.rule) as unknown as RuleDefinition
    if (index >= 0 && edit.settingsChanged !== true) {
      const current = rules[index]!
      delete replacement.enabled; delete replacement.group; delete replacement.groupScope; delete replacement.exclusive
      for (const key of ['enabled', 'group', 'groupScope', 'exclusive'] as const) if (Object.hasOwn(current, key)) Object.assign(replacement, { [key]: current[key] })
    }
    if (rules.some((rule, at) => at !== index && rule.id === replacement.id)) throw new ModuleWriteError(`重复规则标识：${replacement.id}`)
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
    if (target === undefined) throw new ModuleWriteError('要启用的规则不存在')
    target.enabled = true
    if (typeof target.group === 'string' && target.group.trim().length > 0) {
      const peers = rules.filter(rule => rule.group === target.group && (rule.groupScope ?? 'module') === (target.groupScope ?? 'module'))
      if (peers.some(rule => rule.exclusive === true)) for (const peer of peers) if (peer !== target) peer.enabled = false
    }
  }
  const ids = new Set(rules.map(rule => rule.id))
  for (const id of Object.keys(order)) if (!ids.has(id)) delete order[id]
  // projection 已把 configOrder 校验为数字；这里只做 unknown → number 的类型收窄，不改写回值。
  const current = Object.fromEntries(Object.entries(order).map(([id, value]) => [id, Number(value)]))
  let tail: number | undefined
  for (const rule of rules) {
    if (order[rule.id] !== undefined) continue
    if (tail === undefined) {
      const reserved = reservedConfigSequences(dirname(snapshot.dir), basename(snapshot.dir))
      tail = nextModuleConfigSequence(current, reserved)
    }
    order[rule.id] = tail
    tail += 10
  }
  if (request.activateRuleId === undefined && JSON.stringify(previous) === JSON.stringify(rules) && JSON.stringify(snapshot.source.configOrder ?? {}) === JSON.stringify(order)) return publicSnapshot(snapshot)
  snapshot.doc.set('rules', replaceNode(snapshot.doc, ruleNodes, rules))
  if (Object.keys(order).length > 0) snapshot.doc.set('configOrder', replaceNode(snapshot.doc, orderNodes, order))
  else snapshot.doc.delete('configOrder')
  let expected = { ...snapshot.source, rules, configOrder: order } as Record<string, unknown>
  if (Object.keys(order).length === 0) delete expected.configOrder
  // 跨模块互斥只触及当前参与装配的模块与显式目标；停用模块的草稿不读不写。
  const crossCandidates: Array<{ snapshot: ModuleDefinitionSnapshot; doc: ReturnType<typeof parseDocument>; rules: RuleDefinition[] }> = []
  if (request.activateRuleId !== undefined) {
    const target = rules.find(rule => rule.id === request.activateRuleId)
    if (target?.group !== undefined && (target.groupScope ?? 'module') === 'cross-module' && target.enabled !== false) {
      const root = dirname(snapshot.dir)
      const participants = new Set([...enabledModuleIds(root), basename(snapshot.dir)])
      assertCrossModuleParticipantPaths(root, [...participants])
      participants.delete(basename(snapshot.dir))
      const peerSnapshots = new Map<string, ModuleDefinitionSnapshot>()
      for (const id of participants) peerSnapshots.set(id, ensureModuleSlices(join(root, id), { writable: false }))
      const allPeers = [...rules, ...[...peerSnapshots.values()].flatMap(peer => peer.rules)]
      const groupExclusive = target.exclusive === true || allPeers.some(rule => rule.group === target.group
        && (rule.groupScope ?? 'module') === 'cross-module' && rule.exclusive === true)
      if (groupExclusive) {
        for (const peerRule of rules) if (peerRule !== target && peerRule.group === target.group && (peerRule.groupScope ?? 'module') === 'cross-module') peerRule.enabled = false
        snapshot.doc.set('rules', replaceNode(snapshot.doc, ruleNodes, rules))
        expected = { ...expected, rules }
      }
      for (const id of participants) {
        const peer = peerSnapshots.get(id)!
        const peers = peer.rules.filter(rule => rule.group === target.group && (rule.groupScope ?? 'module') === 'cross-module')
        if (!groupExclusive || !peers.some(rule => rule.enabled !== false)) continue
        const nextRules = structuredClone(peer.rules)
        for (const peerRule of nextRules) if (peerRule.group === target.group && (peerRule.groupScope ?? 'module') === 'cross-module') peerRule.enabled = false
        const doc = peer.doc
        doc.set('rules', replaceNode(doc, doc.get('rules', true), nextRules))
        serializeWithoutSharedAlias(doc, { ...peer.source, rules: nextRules }, 'YAML 共享引用会改变其他定义；请先解除相关引用后再编辑')
        validateModuleDefinitionText(peer.dir, doc.toString())
        crossCandidates.push({ snapshot: peer, doc, rules: nextRules })
      }
    }
  }
  // 所有参与者在提交前再次核对完整定义版本；任一成员变化则整次启用拒绝，不先写目标。
  for (const candidate of crossCandidates) {
    const current = loadModuleDefinition(candidate.snapshot.dir)
    if (current.revision !== candidate.snapshot.revision) throw new ModuleWriteError('跨模块互斥成员已变化，请重新读取后保存', 409, 'rules-conflict')
  }
  const participants = new Set([...enabledModuleIds(dirname(snapshot.dir)), basename(snapshot.dir)])
  const overrides = new Map<string, readonly RuleDefinition[]>([[basename(snapshot.dir), rules]])
  for (const candidate of crossCandidates) {
    overrides.set(basename(candidate.snapshot.dir), candidate.rules)
  }
  assertCrossModuleGroups(dirname(snapshot.dir), [...participants], overrides)
  // 序列化本身也受检（别名锚点失配时 toString 会抛），故不取返回值。
  serializeWithoutSharedAlias(snapshot.doc, expected, 'YAML 共享引用会改变其他定义；请先解除相关引用后再编辑')
  // 与保存共用完整候选校验，但验证请求不写切片或完整定义。
  if (request.validateOnly) {
    validateModuleDefinitionText(snapshot.dir, snapshot.doc.toString())
    return publicSnapshot(snapshot, rules)
  }
  let saved: ModuleDefinitionSnapshot | undefined
  try {
    saved = commitModuleDefinition(snapshot, snapshot.doc)
    invalidateModuleSpec(snapshot.dir)
    for (const candidate of crossCandidates) {
      commitModuleDefinition(candidate.snapshot, candidate.doc)
      invalidateModuleSpec(candidate.snapshot.dir)
    }
  } catch (error) {
    if (request.activateRuleId === undefined || crossCandidates.length === 0 || (saved === undefined && !(error instanceof ModuleWriteError && error.persisted))) throw error
    const committed = loadModuleDefinition(snapshot.dir)
    invalidateModuleSpec(snapshot.dir)
    const pending = new ModuleWriteError(`目标规则已保存，但跨模块选择未完成；请用当前版本重试启用 ${request.activateRuleId}：${String((error as Error).message ?? error)}`, 500, 'rules-rebuild-failed', true, structuredClone(committed.revisions))
    pending.activationPending = request.activateRuleId
    throw pending
  }
  return publicSnapshot(saved)
}
