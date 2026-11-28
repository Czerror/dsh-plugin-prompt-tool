import type { CompactRulesSnapshot, RuleDefinition, RuleEdit, RuleRevisions, RulesRequest, RulesSnapshot } from '../../shared/rules.ts'
import type { BridgeResult } from './bridge-client.ts'
import type { FieldDraft, WorkspaceDrafts } from './workspace-drafts.ts'
import { deepEqual } from './dirty-state.ts'
import { beginLatest, isLatest } from './resource-track.ts'
import { readPublication } from '../../shared/publication.ts'

/**
 * 需要「先重新读取」才能继续的拒绝码：这些失败重放保存只会重复同一次拒绝。
 * `rules-conflict`／`module-changed` 是目标版本已变，必须读回新版本；
 * `shared-alias` 是 YAML 共享引用连带改了别人的字段，得先让用户解除引用再重读。
 */
const READ_FIRST_CODES: readonly string[] = ['rules-conflict', 'module-changed', 'shared-alias']

function validSnapshot(value: RulesSnapshot | undefined): value is RulesSnapshot {
  return !!value && Array.isArray(value.rules) && value.rules.every(rule => rule && typeof rule.id === 'string' && Array.isArray(rule.then))
    && typeof value.revisions?.rules === 'object' && value.revisions.rules !== null
    && typeof value.revisions.settings === 'string' && typeof value.revisions.variables === 'string'
    && Array.isArray(value.meta?.actions) && Array.isArray(value.meta.predicates)
}

/** key 只归编辑器；重命名不能改变正在输入的字段身份。 */
export interface RuleEntry { key: string; previousId: string | null; value: RuleDefinition; deleted?: boolean }
export interface RulesDraft {
  entries: RuleEntry[]
  saved: RuleDefinition[]
  fields: Map<string, FieldDraft>
  composing?: Set<string>
  revisions?: RuleRevisions
  definitionRevision?: string
  meta?: RulesSnapshot['meta']
  remote?: RulesSnapshot
  pending?: { checked: boolean; read: () => Promise<boolean>; entries?: RuleEntry[]; request: RulesRequest; key?: string; retryCreate?: () => Promise<boolean> }
  retryCreate?: () => Promise<boolean>
  retrySave?: { key?: string; activateRuleId?: string }
  loaded: boolean
  busy?: 'read' | 'save' | 'validate'
  saving?: Promise<void>
  error?: string
  errorCode?: string
  retry?: 'read' | 'save'
  rulesDeclared?: boolean
  publicationPending?: boolean
  publicationError?: string
  activationPending?: string
  validated: boolean
  latest: number
  nextKey: number
}
export function getRulesDraft(drafts: WorkspaceDrafts, moduleId: string): RulesDraft {
  let draft = drafts.rules.get(moduleId)
  if (draft === undefined) {
    draft = { entries: [], saved: [], fields: new Map(), loaded: false, validated: false, latest: 0, nextKey: 0 }
    drafts.rules.set(moduleId, draft)
  }
  return draft
}
export const hasRuleFields = (draft: RulesDraft, key?: string): boolean => [...draft.fields].some(([path, field]) =>
  (key === undefined || path.startsWith(key + ':')) && (field.text !== field.source || !!field.error))
export function ruleEdits(draft: RulesDraft, key?: string): RuleEdit[] {
  const saved = new Map(draft.saved.map(rule => [rule.id, rule]))
  return draft.entries.flatMap<RuleEdit>(entry => {
    if (key !== undefined && entry.key !== key) return []
    if (entry.deleted) return entry.previousId === null ? [] : [{ previousId: entry.previousId, rule: null }]
    const previous = entry.previousId === null ? undefined : saved.get(entry.previousId)
    return previous === undefined || !deepEqual(entry.value, previous)
      ? [{ previousId: entry.previousId, rule: structuredClone(entry.value), settingsChanged: previous === undefined
        || !deepEqual([entry.value.enabled, entry.value.group, entry.value.groupScope, entry.value.exclusive], [previous.enabled, previous.group, previous.groupScope, previous.exclusive]) }] : []
  })
}
export const rulesDirty = (draft: RulesDraft, key?: string): boolean => hasRuleFields(draft, key) || ruleEdits(draft, key).length > 0
function acceptRules(draft: RulesDraft, snapshot: RulesSnapshot): void {
  const keys = new Map(draft.entries.map(entry => [entry.previousId, entry.key]))
  draft.entries = snapshot.rules.map(value => ({ key: keys.get(value.id) ?? `rule-${draft.nextKey++}`, previousId: value.id, value: structuredClone(value) }))
  draft.saved = structuredClone(snapshot.rules)
  draft.meta = snapshot.meta
  draft.revisions = snapshot.revisions
  draft.definitionRevision = snapshot.definitionRevision
  draft.loaded = true
  draft.rulesDeclared = true
  draft.remote = undefined
}
interface RuleEditorDependencies {
  onUnconfirmed?: () => void
  onRetriedCreate?: (snapshot: RulesSnapshot) => Promise<void>
  request: (body: RulesRequest) => Promise<BridgeResult<RulesSnapshot>>
  enqueue: <T>(moduleId: string, task: () => Promise<T>) => Promise<T>
  isCurrent: () => boolean
  changed: () => void
}
/** 读取、编辑、改名、激活和整组响应都通过这一 owner，不写旧配置段。 */
export function createRuleEditor(moduleId: string, draft: RulesDraft, deps: RuleEditorDependencies) {
  const clearFailure = (): void => {
    draft.retry = undefined; draft.retrySave = undefined; draft.error = undefined; draft.errorCode = undefined
  }
  const clearRevertedSave = (): void => {
    const failed = draft.retrySave
    if (!failed || rulesDirty(draft, failed.key)) return
    const target = failed.activateRuleId
    if (target === undefined || draft.entries.some(entry => !entry.deleted && entry.value.id === target && entry.value.enabled === false)) clearFailure()
  }
  const changed = (): void => { draft.validated = false; clearRevertedSave(); deps.changed() }
  const publication = (snapshot: RulesSnapshot | CompactRulesSnapshot): void => {
    draft.activationPending = 'activationPending' in snapshot ? snapshot.activationPending : undefined
    const state = readPublication(snapshot)
    draft.publicationPending = state.pending
    draft.publicationError = state.error
  }
  const receive = (snapshot: RulesSnapshot, keepSaveFailure = false): boolean => {
    if (rulesDirty(draft)) {
      if (!deepEqual(snapshot.rules, draft.saved)) {
        clearFailure()
        draft.remote = snapshot; draft.retry = 'read'; draft.error = 'rules-conflict'; draft.loaded = true; return false
      }
      draft.revisions = snapshot.revisions; draft.definitionRevision = snapshot.definitionRevision; draft.meta = snapshot.meta
    } else acceptRules(draft, snapshot)
    draft.loaded = true; draft.rulesDeclared = true; draft.remote = undefined
    if (!keepSaveFailure) clearFailure()
    return true
  }
  const acceptSent = (entries: RuleEntry[], snapshot: RulesSnapshot): void => {
    const returned = new Map(snapshot.rules.map(rule => [rule.id, rule]))
    const submitted = new Map(entries.map(entry => [entry.key, entry]))
    const before = new Map(draft.saved.map(rule => [rule.id, rule]))
    draft.entries = draft.entries.flatMap(entry => {
      const sent = submitted.get(entry.key)
      if (sent?.deleted) return entry.deleted ? [] : [{ ...entry, previousId: null }]
      const id = sent?.value.id ?? entry.previousId
      const saved = id === null ? undefined : returned.get(id)
      if (saved === undefined) return [entry]
      returned.delete(saved.id)
      const base = sent?.value ?? (entry.previousId === null ? undefined : before.get(entry.previousId))
      const value = structuredClone(saved)
      // 服务端互斥状态与在途正文分别合入，不能用旧整卡把同组关闭结果覆盖回来。
      if (base !== undefined) for (const key of new Set([...Object.keys(base), ...Object.keys(entry.value)])) {
        const field = key as keyof RuleDefinition
        if (!deepEqual(entry.value[field], base[field])) {
          if (Object.hasOwn(entry.value, field)) Object.assign(value, { [field]: structuredClone(entry.value[field]) })
          else delete value[field]
        }
      }
      return [{ ...entry, previousId: saved.id, value }]
    })
    for (const value of returned.values()) draft.entries.push({ key: `rule-${draft.nextKey++}`, previousId: value.id, value: structuredClone(value) })
    draft.saved = structuredClone(snapshot.rules); draft.revisions = snapshot.revisions; draft.meta = snapshot.meta; draft.rulesDeclared = true; draft.loaded = true
    draft.definitionRevision = snapshot.definitionRevision
  }
  const acceptCompactSent = (entries: RuleEntry[], snapshot: CompactRulesSnapshot): void => {
    const sent = entries[0]
    if (!sent || sent.deleted || snapshot.rule.id !== sent.value.id) throw new Error('紧凑规则确认身份不匹配')
    const current = draft.entries.find(entry => entry.key === sent.key)
    if (!current) throw new Error('紧凑规则确认目标已不存在')
    if (![snapshot.ruleRevision, snapshot.definitionRevision, snapshot.settingsRevision, snapshot.variablesRevision].every(value => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value))) throw new Error('紧凑规则确认版本不合法')
    const base = sent.value
    const value = structuredClone(snapshot.rule)
    for (const key of new Set([...Object.keys(base), ...Object.keys(current.value)])) {
      const field = key as keyof RuleDefinition
      if (!deepEqual(current.value[field], base[field])) {
        if (Object.hasOwn(current.value, field)) Object.assign(value, { [field]: structuredClone(current.value[field]) })
        else delete value[field]
      }
    }
    draft.entries = draft.entries.map(entry => entry.key === sent.key ? { ...entry, previousId: value.id, value } : entry)
    draft.saved = draft.saved.map(rule => rule.id === value.id ? structuredClone(snapshot.rule) : rule)
    draft.revisions = { ...draft.revisions!, rules: { ...draft.revisions!.rules, [value.id]: snapshot.ruleRevision },
      settings: snapshot.settingsRevision, variables: snapshot.variablesRevision }
    draft.definitionRevision = snapshot.definitionRevision
    draft.meta = snapshot.meta
    draft.loaded = true
  }
  const unknown = (operation: Omit<NonNullable<RulesDraft['pending']>, 'checked' | 'read'>): false => {
    clearFailure()
    draft.pending = { ...operation, checked: false, read: () => reconcile() }
    draft.retry = 'read'
    draft.error = '保存结果待确认。连接恢复后将核对原模块。'
    if (deps.onUnconfirmed) queueMicrotask(deps.onUnconfirmed)
    return false
  }
  const reconcile = async (manual = false): Promise<boolean> => {
    const pending = draft.pending
    if (!pending || draft.busy || (!manual && pending.checked)) return false
    pending.checked = true
    draft.busy = 'read'; deps.changed()
    try {
      const result = await deps.request({ expectedModuleId: moduleId })
      const request = pending.request
      if (request.createRule && ((!result.ok && result.code === 'module-not-declared' && request.expectedRulesAbsent)
        || (result.ok && validSnapshot(result.value) && draft.loaded && deepEqual(result.value.revisions, draft.revisions)))) {
        draft.pending = undefined; draft.retryCreate = pending.retryCreate
        draft.retry = 'save'; draft.error = '原模块没有此次创建的改动，可重试创建。'
        return false
      }
      if (!result.ok || !validSnapshot(result.value)) return false
      const saved = result.value
      const remote = new Map(saved.rules.map(rule => [rule.id, rule]))
      const edits = request.edits ?? []
      // 读取只能确认目标内容。创建的宿主分配身份、跨模块选择的完成度无法从同名或目标启停推断。
      if (request.createRule || request.activateRuleId) {
        draft.error = '尚不能确认创建或跨模块选择的结果，请核对原模块。'
        return false
      }
      const matches = edits.every(({ previousId, rule }) =>
        (previousId === null || previousId === rule?.id || !remote.has(previousId))
        && (rule === null || deepEqual(rule, remote.get(rule.id))))
      if (matches && pending.entries) {
        acceptSent(pending.entries, saved)
        clearFailure(); draft.pending = undefined
        publication(saved)
        return true
      }
      draft.pending = undefined
      if (deepEqual(saved.revisions, draft.revisions)) {
        draft.retrySave = { key: pending.key, activateRuleId: request.activateRuleId }
        draft.retry = 'save'; draft.error = '原模块仍为保存前版本，可重试。'
        clearRevertedSave()
      } else {
        draft.remote = saved; draft.retry = 'read'; draft.error = '原模块已变化，草稿仍保留。'
      }
      return false
    } catch { return false }
    finally { draft.busy = undefined; deps.changed() }
  }
  const create = async (request: RulesRequest): Promise<BridgeResult<RulesSnapshot>> => {
    if (draft.pending) return { ok: false, message: draft.error ?? '保存结果待确认' }
    if (draft.busy !== undefined) return { ok: false, code: 'rules-busy', message: '规则正在读写，请稍后重试' }
    const sequence = beginLatest(draft)
    const operation = { request, retryCreate: async () => {
      const result = await create(request)
      if (result.ok) await deps.onRetriedCreate?.(result.value)
      return result.ok
    } }
    clearFailure()
    draft.busy = 'save'; deps.changed()
    try {
      const result = await deps.enqueue(moduleId, () => deps.request(request))
      if (!isLatest(draft, sequence)) return result
      if ((!result.ok && result.code === 'bridge-response-unknown') || (result.ok && (!validSnapshot(result.value)
        || !result.value.rules.some(item => item.id === result.value.createdRuleId)))) {
        unknown(operation)
        return { ok: false, message: draft.error }
      }
      if (result.ok) {
        receive(result.value)
        draft.rulesDeclared = true
        publication(result.value)
      } else {
        draft.errorCode = result.code
        if (READ_FIRST_CODES.includes(result.code ?? '')) draft.retry = 'read'
        draft.error = result.message ?? result.code ?? 'rules-create-failed'
      }
      return result
    } catch (error) {
      if (isLatest(draft, sequence)) unknown(operation)
      return { ok: false, message: String(error) }
    } finally { if (isLatest(draft, sequence)) { draft.retryCreate = undefined; draft.busy = undefined; deps.changed() } }
  }
  const load = async (force = false): Promise<boolean> => {
    if (draft.pending) return force ? reconcile(true) : false
    if (!deps.isCurrent() || draft.busy !== undefined) return false
    if (draft.loaded && !force) return true
    const sequence = beginLatest(draft)
    draft.busy = 'read'; deps.changed()
    try {
      const result = await deps.request({ expectedModuleId: moduleId })
      if (!isLatest(draft, sequence)) return false
      if (!result.ok) { clearFailure(); draft.retry = 'read'; draft.errorCode = result.code; draft.error = result.message ?? result.code ?? 'rules-read-failed'; return false }
      if (!validSnapshot(result.value)) { clearFailure(); draft.retry = 'read'; draft.error = '规则读取应答无效'; return false }
      publication(result.value)
      return receive(result.value)
    } catch (error) { if (isLatest(draft, sequence)) { clearFailure(); draft.retry = 'read'; draft.error = String(error) }; return false }
    finally { if (isLatest(draft, sequence)) { draft.busy = undefined; deps.changed() } }
  }
  const patch = (key: string, value: RuleDefinition): void => {
    draft.entries = draft.entries.map(entry => entry.key === key ? { ...entry, value } : entry)
    changed()
  }
  const add = (value: RuleDefinition): string => {
    const key = `rule-${draft.nextKey++}`
    draft.entries = [...draft.entries, { key, previousId: null, value: structuredClone(value) }]
    changed(); return key
  }
  const remove = (key: string): void => {
    draft.entries = draft.entries.map(entry => entry.key === key ? { ...entry, deleted: true } : entry)
    for (const name of draft.fields.keys()) if (name.startsWith(`${key}:`)) draft.fields.delete(name)
    changed()
  }
  const retryPublication = async (): Promise<boolean> => {
    if (!deps.isCurrent() || draft.busy !== undefined || draft.pending || draft.retry === 'read' || draft.remote
      || draft.activationPending !== undefined || !draft.publicationPending) return false
    const sequence = beginLatest(draft)
    draft.busy = 'save'; deps.changed()
    try {
      const result = await deps.enqueue(moduleId, async () => isLatest(draft, sequence)
        ? deps.request({ expectedModuleId: moduleId, refreshOnly: true,
          ...(draft.definitionRevision === undefined ? {} : { expectedDefinitionRevision: draft.definitionRevision }) }) : undefined)
      if (!isLatest(draft, sequence) || result === undefined) return false
      if (result.ok) {
        if (!validSnapshot(result.value)) {
          clearFailure()
          draft.retry = 'read'; draft.error = '规则发布应答无效'; return false
        }
        receive(result.value, draft.retry === 'save'); publication(result.value)
      } else if (READ_FIRST_CODES.includes(result.code ?? '')) {
        clearFailure()
        draft.retry = 'read'
        draft.errorCode = result.code
        draft.error = result.message ?? result.code
        return false
      }
      if (!result.ok) {
        draft.publicationError = result.message ?? result.code ?? 'rules-refresh-failed'
        return false
      }
      return !draft.publicationPending
    } catch (error) { if (isLatest(draft, sequence)) draft.publicationError = String(error); return false }
    finally { if (isLatest(draft, sequence)) { draft.busy = undefined; deps.changed() } }
  }
  const submit = async (options: { validateOnly?: boolean; activateRuleId?: string } = {}, key?: string): Promise<boolean> => {
    if (!deps.isCurrent()) return false
    if (key !== undefined && draft.saving) {
      const requested = draft.entries.find(entry => entry.key === key)
      while (draft.saving) await draft.saving
      const current = draft.entries.find(entry => entry.key === key)
      if (!requested || !current || !deepEqual(current.value, requested.value) || current.deleted !== requested.deleted) return false
    }
    if (!options.validateOnly && options.activateRuleId === undefined && draft.activationPending !== undefined
      && draft.entries.some(entry => !entry.deleted && entry.value.id === draft.activationPending && entry.value.enabled !== false)) options = { ...options, activateRuleId: draft.activationPending }
    if (!draft.loaded || draft.busy !== undefined || draft.remote !== undefined || draft.pending || draft.retry === 'read' || !draft.revisions
      || hasRuleFields(draft, key) || (key === undefined ? draft.composing?.size : draft.composing?.has(key))) return false
    const edits = ruleEdits(draft, key)
    const expectedRevisions: Partial<RuleRevisions> = { rules: Object.fromEntries(edits.flatMap(edit =>
      edit.previousId === null ? [] : [[edit.previousId, draft.revisions!.rules[edit.previousId]!]])) }
    if (options.activateRuleId !== undefined || edits.some(edit => edit.settingsChanged || edit.previousId === null
      || edit.rule === null || edit.previousId !== edit.rule.id)) expectedRevisions.settings = draft.revisions.settings
    if (edits.length === 0 && options.activateRuleId === undefined && !options.validateOnly) return key === undefined && draft.publicationPending ? retryPublication() : true
    const sequence = beginLatest(draft), entries = structuredClone(key === undefined ? draft.entries : draft.entries.filter(entry => entry.key === key))
    const completed = Promise.withResolvers<void>()
    draft.saving = completed.promise
    const compactEdit = !options.validateOnly && options.activateRuleId === undefined && key !== undefined
      && edits.length === 1 && edits[0]!.previousId !== null && edits[0]!.rule !== null
      && edits[0]!.previousId === edits[0]!.rule.id && edits[0]!.settingsChanged !== true
    const request = { expectedModuleId: moduleId, expectedRevisions, edits, ...options, ...(compactEdit ? { compactEdit: true as const } : {}) }
    draft.busy = options.validateOnly ? 'validate' : 'save'; clearFailure(); deps.changed()
    try {
      const result = await deps.enqueue(moduleId, async () => isLatest(draft, sequence)
        ? deps.request(request) : undefined)
      // 入口确认操作资格；入队后的显式目标事务与结果归共享草稿，不随切页取消。
      if (!isLatest(draft, sequence) || result === undefined) return false
      const compactValue = result?.ok && compactEdit ? result.value : undefined
      const compactResult = compactValue && 'rule' in compactValue
        && 'definitionRevision' in compactValue && 'ruleRevision' in compactValue
        && 'settingsRevision' in compactValue && 'variablesRevision' in compactValue
        ? compactValue as CompactRulesSnapshot : undefined
      if (!options.validateOnly && ((!result.ok && result.code === 'bridge-response-unknown')
        || (result.ok && !(compactResult ? compactResult.rule?.id === edits[0]!.rule!.id : validSnapshot(result.value as RulesSnapshot))))) return unknown({ request, entries, key })
      if (!result.ok) {
        draft.retry = READ_FIRST_CODES.includes(result.code ?? '') ? 'read' : 'save'
        draft.errorCode = result.code
        if (draft.retry === 'save') draft.retrySave = { key, activateRuleId: options.activateRuleId }
        draft.error = result.message ?? result.code ?? 'rules-save-failed'
        clearRevertedSave()
        return false
      }
      if (options.validateOnly) draft.validated = deepEqual(draft.entries, entries) && !hasRuleFields(draft)
      else if (compactResult) acceptCompactSent(entries, compactResult)
      else acceptSent(entries, result.value as RulesSnapshot)
      if (!options.validateOnly) publication(compactResult ?? result.value as RulesSnapshot)
      return !draft.publicationPending
    } catch (error) {
      if (isLatest(draft, sequence)) {
        if (!options.validateOnly) return unknown({ request, entries, key })
        draft.error = String(error)
      }
      return false
    }
    finally {
      draft.saving = undefined; completed.resolve()
      if (isLatest(draft, sequence)) { draft.busy = undefined; deps.changed() }
    }
  }
  const submitRule = (key: string, options?: { activateRuleId?: string }): Promise<boolean> => submit(options, key)
  const move = async (key: string, path: string, index: number, offset: -1 | 1): Promise<boolean> => {
    if (!deps.isCurrent() || !draft.loaded || draft.busy !== undefined || draft.remote !== undefined
      || draft.retry === 'read' || !draft.revisions || hasRuleFields(draft) || draft.composing?.size) return false
    const entry = draft.entries.find(item => item.key === key && !item.deleted)
    if (entry === undefined || !path.startsWith(`${key}:`)) return false
    const value = structuredClone(entry.value)
    let list: unknown = value
    for (const part of path.slice(key.length + 1).split(':')) {
      if (list === null || typeof list !== 'object' || !Object.hasOwn(list, part)) return false
      list = (list as Record<string, unknown>)[part]
    }
    const target = index + offset
    if (!Array.isArray(list) || !Number.isInteger(index) || index < 0 || index >= list.length || target < 0 || target >= list.length) return false
    ;[list[index], list[target]] = [list[target], list[index]]
    // 位置缓存属于旧子树；模块校验已确认它们均为干净格式缓存。
    const prefixes = [`${path}:${index}`, `${path}:${target}`]
    for (const name of draft.fields.keys()) if (prefixes.some(prefix => name === prefix || name.startsWith(prefix + ':'))) draft.fields.delete(name)
    patch(key, value)
    return submit()
  }
  const setComposing = (key: string, active: boolean): void => {
    draft.composing ??= new Set()
    if (active) draft.composing.add(key); else draft.composing.delete(key)
  }
  const discard = (): void => {
    if (draft.busy !== undefined) return
    const readRequired = draft.retry === 'read' || draft.pending !== undefined
    clearFailure()
    draft.retryCreate = undefined
    draft.pending = undefined
    if (draft.remote !== undefined) {
      publication(draft.remote)
      acceptRules(draft, draft.remote)
    }
    else if (draft.meta && draft.revisions) {
      acceptRules(draft, { rules: draft.saved, meta: draft.meta, revisions: draft.revisions, definitionRevision: draft.definitionRevision })
      if (readRequired) { draft.retry = 'read'; draft.error = 'rules-conflict' }
    }
    draft.fields.clear(); changed()
  }
  const retryKind = (): 'read' | 'save' | 'publish' => draft.retry === 'read' || draft.remote !== undefined ? 'read'
    : draft.retry === 'save' || draft.activationPending !== undefined || draft.retryCreate ? 'save'
      : draft.publicationPending ? 'publish' : draft.loaded && rulesDirty(draft) ? 'save' : 'read'
  const retry = async (): Promise<boolean> => {
    if (draft.pending) return reconcile(true)
    const kind = retryKind()
    if (kind === 'read') return load(true)
    if (kind === 'publish') return retryPublication()
    if (draft.retryCreate) return draft.retryCreate()
    if (draft.retrySave) {
      const { key, activateRuleId } = draft.retrySave
      return submit({ activateRuleId }, key)
    }
    const activateRuleId = draft.activationPending
    if (activateRuleId !== undefined) {
      return submit({ activateRuleId }, draft.entries.find(entry => !entry.deleted && entry.value.id === activateRuleId)?.key)
    }
    return submit()
  }
  return { load, reconcile, patch, move, setComposing, add, remove,
    create: (rule: RuleDefinition, rulesDeclared?: boolean) => create({ expectedModuleId: moduleId, createRule: structuredClone(rule),
      ...(draft.rulesDeclared !== true && rulesDeclared === false ? { expectedRulesAbsent: true as const } : {}) }),
    submit, submitRule, retryPublication, discard, changed, retry, get retryKind() { return retryKind() } }
}
export type RuleEditor = ReturnType<typeof createRuleEditor>
