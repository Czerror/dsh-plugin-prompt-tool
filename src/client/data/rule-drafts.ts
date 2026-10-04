import type { RuleDefinition, RuleEdit, RuleRevisions, RulesRequest, RulesSnapshot } from '../../shared/rules.ts'
import type { BridgeResult } from './bridge-client.ts'
import type { FieldDraft, WorkspaceDrafts } from './workspace-drafts.ts'
import { deepEqual } from './dirty-state.ts'

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
  publicationPending?: boolean
  publicationError?: string
  validated: boolean
  sequence: number
  nextKey: number
}
export function getRulesDraft(drafts: WorkspaceDrafts, moduleId: string): RulesDraft {
  let draft = drafts.rules.get(moduleId)
  if (draft === undefined) {
    draft = { entries: [], saved: [], fields: new Map(), loaded: false, validated: false, sequence: 0, nextKey: 0 }
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
  draft.remote = undefined
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
  const current = (sequence: number): boolean => draft.sequence === sequence && deps.isCurrent()
  const changed = (): void => { draft.validated = false; deps.changed() }
  const load = async (force = false): Promise<boolean> => {
    if (!deps.isCurrent() || draft.busy !== undefined) return false
    if (draft.loaded && !force) return true
    const sequence = ++draft.sequence
    draft.busy = 'read'; deps.changed()
    try {
      const result = await deps.request({ expectedModuleId: moduleId })
      if (!current(sequence)) return false
      if (!result.ok) { draft.error = result.message ?? result.code ?? 'rules-read-failed'; return false }
      if (rulesDirty(draft)) {
        if (!deepEqual(result.value.rules, draft.saved)) { draft.remote = result.value; draft.error = 'rules-conflict'; return false }
        draft.revisions = result.value.revisions; draft.meta = result.value.meta
      } else acceptRules(draft, result.value)
      draft.loaded = true; draft.error = draft.publicationError; return true
    } catch (error) { if (current(sequence)) draft.error = String(error); return false }
    finally { if (draft.sequence === sequence) { draft.busy = undefined; deps.changed() } }
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
    const sequence = ++draft.sequence
    draft.busy = 'save'; deps.changed()
    try {
      const result = await deps.enqueue(moduleId, async () => current(sequence)
        ? deps.request({ expectedModuleId: moduleId, refreshOnly: true }) : undefined)
      if (!current(sequence) || result === undefined) return false
      if (!result.ok || result.value.publicationError) {
        draft.publicationError = result.ok ? result.value.publicationError : result.message ?? result.code ?? 'rules-refresh-failed'
        draft.error = draft.publicationError
        return false
      }
      draft.publicationPending = false; draft.publicationError = undefined; draft.error = undefined
      return true
    } catch (error) { if (current(sequence)) { draft.error = String(error); draft.publicationError = draft.error }; return false }
    finally { if (draft.sequence === sequence) { draft.busy = undefined; deps.changed() } }
  }
  const submit = async (options: { validateOnly?: boolean; activateRuleId?: string } = {}): Promise<boolean> => {
    if (!deps.isCurrent() || !draft.loaded || draft.busy !== undefined || draft.remote !== undefined || !draft.revisions || hasRuleFields(draft)) return false
    const sequence = ++draft.sequence, entries = structuredClone(draft.entries), edits = ruleEdits(draft)
    const expectedRevisions: Partial<RuleRevisions> = { rules: Object.fromEntries(edits.flatMap(edit =>
      edit.previousId === null ? [] : [[edit.previousId, draft.revisions!.rules[edit.previousId]!]])) }
    if (options.activateRuleId !== undefined || edits.some(edit => edit.settingsChanged || edit.previousId === null
      || edit.rule === null || edit.previousId !== edit.rule.id)) expectedRevisions.settings = draft.revisions.settings
    if (edits.length === 0 && options.activateRuleId === undefined && !options.validateOnly) return draft.publicationPending ? retryPublication() : true
    draft.busy = options.validateOnly ? 'validate' : 'save'; draft.error = undefined; deps.changed()
    try {
      const result = await deps.enqueue(moduleId, async () => current(sequence)
        ? deps.request({ expectedModuleId: moduleId, expectedRevisions, edits, ...options }) : undefined)
      if (!current(sequence) || result === undefined) return false
      if (!result.ok) { draft.error = result.message ?? result.code ?? 'rules-save-failed'; return false }
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
        draft.saved = structuredClone(result.value.rules); draft.revisions = result.value.revisions; draft.meta = result.value.meta
      }
      if (!options.validateOnly) {
        draft.publicationPending = result.value.publicationPending === true || !!result.value.publicationError
        draft.publicationError = result.value.publicationError
      }
      if (draft.publicationError) { draft.error = draft.publicationError; return false }
      return true
    } catch (error) { if (current(sequence)) draft.error = String(error); return false }
    finally { if (draft.sequence === sequence) { draft.busy = undefined; deps.changed() } }
  }
  const discard = (): void => {
    if (draft.busy !== undefined) return
    if (draft.remote !== undefined) acceptRules(draft, draft.remote)
    else if (draft.meta && draft.revisions) acceptRules(draft, { rules: draft.saved, meta: draft.meta, revisions: draft.revisions })
    draft.fields.clear(); changed()
  }
  return { load, patch, add, remove, submit, retryPublication, discard, changed }
}
export type RuleEditor = ReturnType<typeof createRuleEditor>
