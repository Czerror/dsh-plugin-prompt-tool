import type { RuleDefinition, RuleEdit, RuleRevisions, RulesRequest, RulesSnapshot } from '../../shared/rules.ts'
import type { BridgeResult } from './bridge-client.ts'
import type { FieldDraft, WorkspaceDrafts } from './workspace-drafts.ts'
import { deepEqual } from './dirty-state.ts'
import { beginLatest, isLatest } from './resource-track.ts'

/**
 * 需要「先重新读取」才能继续的拒绝码：这些失败重放保存只会重复同一次拒绝。
 * `rules-conflict`／`module-changed` 是目标版本已变，必须读回新版本；
 * `shared-alias` 是 YAML 共享引用连带改了别人的字段，得先让用户解除引用再重读。
 */
const READ_FIRST_CODES: readonly string[] = ['rules-conflict', 'module-changed', 'shared-alias']

/** key 只归编辑器；重命名不能改变正在输入的字段身份。 */
export interface RuleEntry { key: string; previousId: string | null; value: RuleDefinition; deleted?: boolean }
export interface RulesDraft {
  entries: RuleEntry[]
  saved: RuleDefinition[]
  fields: Map<string, FieldDraft>
  revisions?: RuleRevisions
  meta?: RulesSnapshot['meta']
  remote?: RulesSnapshot
  loaded: boolean
  busy?: 'read' | 'save' | 'validate'
  error?: string
  retry?: 'read' | 'save'
  rulesDeclared?: boolean
  publicationPending?: boolean
  publicationError?: string
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
export const hasRuleFields = (draft: RulesDraft): boolean => [...draft.fields.values()].some(field => field.text !== field.source || !!field.error)
export function ruleEdits(draft: RulesDraft): RuleEdit[] {
  const saved = new Map(draft.saved.map(rule => [rule.id, rule]))
  return draft.entries.flatMap<RuleEdit>(entry => {
    if (entry.deleted) return entry.previousId === null ? [] : [{ previousId: entry.previousId, rule: null }]
    const previous = entry.previousId === null ? undefined : saved.get(entry.previousId)
    return previous === undefined || !deepEqual(entry.value, previous)
      ? [{ previousId: entry.previousId, rule: structuredClone(entry.value), settingsChanged: previous === undefined
        || !deepEqual([entry.value.enabled, entry.value.group, entry.value.exclusive], [previous.enabled, previous.group, previous.exclusive]) }] : []
  })
}
export const rulesDirty = (draft: RulesDraft): boolean => hasRuleFields(draft) || ruleEdits(draft).length > 0
function acceptRules(draft: RulesDraft, snapshot: RulesSnapshot): void {
  const keys = new Map(draft.entries.map(entry => [entry.previousId, entry.key]))
  draft.entries = snapshot.rules.map(value => ({ key: keys.get(value.id) ?? `rule-${draft.nextKey++}`, previousId: value.id, value: structuredClone(value) }))
  draft.saved = structuredClone(snapshot.rules)
  draft.meta = snapshot.meta
  draft.revisions = snapshot.revisions
  draft.loaded = true
  draft.rulesDeclared = true
  draft.remote = undefined
  draft.retry = undefined
  draft.error = draft.publicationError
}
interface RuleEditorDependencies {
  request: (body: RulesRequest) => Promise<BridgeResult<RulesSnapshot>>
  enqueue: <T>(moduleId: string, task: () => Promise<T>) => Promise<T>
  isCurrent: () => boolean
  changed: () => void
}
/** 读取、编辑、改名、激活和整组响应都通过这一 owner，不写旧配置段。 */
export function createRuleEditor(moduleId: string, draft: RulesDraft, deps: RuleEditorDependencies) {
  const changed = (): void => { draft.validated = false; deps.changed() }
  const publication = (snapshot: RulesSnapshot): void => {
    draft.publicationPending = snapshot.publicationPending === true || !!snapshot.publicationError
    draft.publicationError = snapshot.publicationError ?? (snapshot.publicationPending === true ? 'rules-refresh-pending' : undefined)
    draft.error = draft.retry === 'read' ? 'rules-conflict' : draft.publicationError
  }
  const receive = (snapshot: RulesSnapshot): boolean => {
    if (rulesDirty(draft)) {
      if (!deepEqual(snapshot.rules, draft.saved)) {
        draft.remote = snapshot; draft.retry = 'read'; draft.error = 'rules-conflict'; draft.loaded = true; return false
      }
      draft.revisions = snapshot.revisions; draft.meta = snapshot.meta
    } else acceptRules(draft, snapshot)
    draft.loaded = true; draft.rulesDeclared = true; draft.remote = undefined; draft.retry = undefined; draft.error = draft.publicationError
    return true
  }
  const create = async (rule: RuleDefinition, rulesDeclared?: boolean): Promise<BridgeResult<RulesSnapshot>> => {
    if (draft.busy !== undefined) return { ok: false, code: 'rules-busy', message: '规则正在读写，请稍后重试' }
    const sequence = beginLatest(draft), candidate = structuredClone(rule)
    draft.busy = 'save'; deps.changed()
    try {
      const result = await deps.enqueue(moduleId, () => deps.request({ expectedModuleId: moduleId,
        ...(draft.rulesDeclared !== true && rulesDeclared === false ? { expectedRulesAbsent: true as const } : {}),
        createRule: candidate,
      }))
      if (!isLatest(draft, sequence)) return result
      if (result.ok) {
        receive(result.value)
        draft.rulesDeclared = true
        publication(result.value)
      } else draft.error = result.message ?? result.code ?? 'rules-create-failed'
      return result
    } catch (error) {
      if (isLatest(draft, sequence)) draft.error = String(error)
      return { ok: false, message: String(error) }
    } finally { if (isLatest(draft, sequence)) { draft.busy = undefined; deps.changed() } }
  }
  const load = async (force = false): Promise<boolean> => {
    if (!deps.isCurrent() || draft.busy !== undefined) return false
    if (draft.loaded && !force) return true
    const sequence = beginLatest(draft)
    draft.busy = 'read'; deps.changed()
    try {
      const result = await deps.request({ expectedModuleId: moduleId })
      if (!isLatest(draft, sequence)) return false
      if (!result.ok) { draft.retry = 'read'; draft.error = result.message ?? result.code ?? 'rules-read-failed'; return false }
      return receive(result.value)
    } catch (error) { if (isLatest(draft, sequence)) { draft.retry = 'read'; draft.error = String(error) }; return false }
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
    if (!deps.isCurrent() || draft.busy !== undefined || !draft.publicationPending) return false
    const sequence = beginLatest(draft)
    draft.busy = 'save'; deps.changed()
    try {
      const result = await deps.enqueue(moduleId, async () => isLatest(draft, sequence)
        ? deps.request({ expectedModuleId: moduleId, refreshOnly: true }) : undefined)
      if (!isLatest(draft, sequence) || result === undefined) return false
      if (result.ok) receive(result.value)
      if (!result.ok || result.value.publicationError || result.value.publicationPending === true) {
        draft.publicationError = result.ok ? result.value.publicationError ?? 'rules-refresh-pending' : result.message ?? result.code ?? 'rules-refresh-failed'
        draft.error = draft.publicationError
        return false
      }
      draft.publicationPending = false; draft.publicationError = undefined; draft.error = draft.retry === 'read' ? 'rules-conflict' : undefined
      return true
    } catch (error) { if (isLatest(draft, sequence)) { draft.error = String(error); draft.publicationError = draft.error }; return false }
    finally { if (isLatest(draft, sequence)) { draft.busy = undefined; deps.changed() } }
  }
  const submit = async (options: { validateOnly?: boolean; activateRuleId?: string } = {}): Promise<boolean> => {
    if (!deps.isCurrent() || !draft.loaded || draft.busy !== undefined || draft.remote !== undefined || draft.retry === 'read' || !draft.revisions || hasRuleFields(draft)) return false
    const sequence = beginLatest(draft), entries = structuredClone(draft.entries), edits = ruleEdits(draft)
    const expectedRevisions: Partial<RuleRevisions> = { rules: Object.fromEntries(edits.flatMap(edit =>
      edit.previousId === null ? [] : [[edit.previousId, draft.revisions!.rules[edit.previousId]!]])) }
    if (options.activateRuleId !== undefined || edits.some(edit => edit.settingsChanged || edit.previousId === null
      || edit.rule === null || edit.previousId !== edit.rule.id)) expectedRevisions.settings = draft.revisions.settings
    if (edits.length === 0 && options.activateRuleId === undefined && !options.validateOnly) return draft.publicationPending ? retryPublication() : true
    draft.busy = options.validateOnly ? 'validate' : 'save'; draft.error = undefined; deps.changed()
    try {
      const result = await deps.enqueue(moduleId, async () => isLatest(draft, sequence)
        ? deps.request({ expectedModuleId: moduleId, expectedRevisions, edits, ...options }) : undefined)
      // 入口确认操作资格；入队后的显式目标事务与结果归共享草稿，不随切页取消。
      if (!isLatest(draft, sequence) || result === undefined) return false
      if (!result.ok) {
        draft.retry = READ_FIRST_CODES.includes(result.code ?? '') ? 'read' : 'save'
        draft.error = result.message ?? result.code ?? 'rules-save-failed'; return false
      }
      draft.retry = undefined
      if (options.validateOnly) draft.validated = deepEqual(draft.entries, entries) && !hasRuleFields(draft)
      else {
        const returned = new Map(result.value.rules.map(rule => [rule.id, rule]))
        const submitted = new Map(entries.map(entry => [entry.key, entry]))
        draft.entries = draft.entries.flatMap(entry => {
          const sent = submitted.get(entry.key)
          if (sent?.deleted) return entry.deleted ? [] : [{ ...entry, previousId: null }]
          const id = sent?.value.id ?? entry.previousId
          const saved = id === null ? undefined : returned.get(id)
          if (saved === undefined) return [entry]
          returned.delete(saved.id)
          const value = structuredClone(saved)
          // 服务端互斥状态与在途正文分别合入，不能用旧整卡把同组关闭结果覆盖回来。
          if (sent !== undefined) for (const key of new Set([...Object.keys(sent.value), ...Object.keys(entry.value)])) {
            const field = key as keyof RuleDefinition
            if (!deepEqual(entry.value[field], sent.value[field])) {
              if (Object.hasOwn(entry.value, field)) Object.assign(value, { [field]: structuredClone(entry.value[field]) })
              else delete value[field]
            }
          }
          return [{ ...entry, previousId: saved.id, value }]
        })
        for (const value of returned.values()) draft.entries.push({ key: `rule-${draft.nextKey++}`, previousId: value.id, value: structuredClone(value) })
        draft.saved = structuredClone(result.value.rules); draft.revisions = result.value.revisions; draft.meta = result.value.meta; draft.rulesDeclared = true
      }
      if (!options.validateOnly) {
        publication(result.value)
      }
      if (draft.publicationError) { draft.error = draft.publicationError; return false }
      return true
    } catch (error) { if (isLatest(draft, sequence)) { draft.retry = 'save'; draft.error = String(error) }; return false }
    finally { if (isLatest(draft, sequence)) { draft.busy = undefined; deps.changed() } }
  }
  const discard = (): void => {
    if (draft.busy !== undefined) return
    if (draft.remote !== undefined) acceptRules(draft, draft.remote)
    else if (draft.meta && draft.revisions) {
      const retry = draft.retry
      acceptRules(draft, { rules: draft.saved, meta: draft.meta, revisions: draft.revisions })
      if (retry === 'read') { draft.retry = 'read'; draft.error = 'rules-conflict' }
    }
    draft.fields.clear(); changed()
  }
  const retryKind = (): 'read' | 'save' | 'publish' => draft.retry === 'read' || draft.remote !== undefined ? 'read'
    : draft.publicationPending ? 'publish' : draft.loaded && rulesDirty(draft) ? 'save' : 'read'
  const retry = (): Promise<boolean> => retryKind() === 'publish' ? retryPublication() : retryKind() === 'save' ? submit() : load(true)
  return { load, patch, add, remove, create, submit, retryPublication, discard, changed, retry, get retryKind() { return retryKind() } }
}
export type RuleEditor = ReturnType<typeof createRuleEditor>
