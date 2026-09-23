/** 规则草稿归属工作台；页面卸载不丢输入，网络响应只确认本次请求的快照。 */
import type { BridgeErrorPayload, BridgeRequestMap, BridgeValueMap } from '../../shared/bridge-contract.ts'
import type { BridgeResult } from './bridge-client.ts'
import { deepEqual } from './dirty-state.ts'
import type { FieldDraft, WorkspaceDrafts } from './workspace-drafts.ts'

type TriggerSnapshot = BridgeValueMap['triggers']
export interface TriggerEditorDraft {
  value: unknown[]
  saved: unknown[]
  fields: Map<string, FieldDraft>
  revision?: string
  meta?: TriggerSnapshot['meta']
  remote?: TriggerSnapshot
  loaded: boolean
  busy?: 'read' | 'save' | 'validate'
  error?: BridgeErrorPayload
  validated: boolean
  sequence: number
}

export const hasTriggerFieldDrafts = (draft: TriggerEditorDraft): boolean => [...draft.fields.values()].some((field) => field.text !== field.source || field.error.length > 0)
export const triggerDraftDirty = (draft: TriggerEditorDraft): boolean => !deepEqual(draft.value, draft.saved) || hasTriggerFieldDrafts(draft)

export function getTriggerDraft(drafts: WorkspaceDrafts, presetId: string): TriggerEditorDraft {
  let draft = drafts.triggers.get(presetId)
  if (draft === undefined) {
    draft = { value: [], saved: [], fields: new Map(), loaded: false, validated: false, sequence: 0 }
    drafts.triggers.set(presetId, draft)
  }
  return draft
}

interface TriggerEditorDependencies {
  request(body: BridgeRequestMap['triggers']): Promise<BridgeResult<TriggerSnapshot>>
  enqueue<T>(presetId: string, task: () => Promise<T>): Promise<T>
  isCurrent(): boolean
  changed(): void
}

export function createTriggerEditor(presetId: string, draft: TriggerEditorDraft, deps: TriggerEditorDependencies) {
  const current = (sequence: number): boolean => sequence === draft.sequence && deps.isCurrent()
  const failure = (error: unknown): BridgeErrorPayload => ({ ok: false, code: 'trigger-request-failed', message: error instanceof Error ? error.message : String(error) })
  const finish = (sequence: number): void => {
    if (sequence === draft.sequence) { draft.busy = undefined; deps.changed() }
  }
  const patch = (value: unknown[]): void => {
    draft.value = structuredClone(value)
    draft.validated = false
    if (draft.remote === undefined) draft.error = undefined
    deps.changed()
  }
  const load = async (): Promise<boolean> => {
    if (!deps.isCurrent() || draft.busy === 'save' || draft.busy === 'validate') return false
    const sequence = ++draft.sequence
    draft.busy = 'read'
    deps.changed()
    try {
      const result = await deps.request({ expectedPresetId: presetId })
      if (!current(sequence)) return false
      if (!result.ok) { draft.error = result; return false }
      const snapshot = result.value
      draft.meta = snapshot.meta
      // 其他预设设置也改变整文件版本：仅当规则未被他人修改时，才可保留本地输入并推进基线。
      if (triggerDraftDirty(draft) && !deepEqual(snapshot.triggers, draft.saved)) {
        draft.remote = snapshot
        draft.error = { ok: false, code: 'trigger-rules-changed' }
        return false
      }
      if (!triggerDraftDirty(draft)) draft.value = structuredClone(snapshot.triggers)
      draft.saved = structuredClone(snapshot.triggers)
      draft.revision = snapshot.revision
      draft.loaded = true
      draft.remote = undefined
      draft.error = undefined
      draft.validated = false
      return true
    } catch (error) {
      if (current(sequence)) draft.error = failure(error)
      return false
    } finally { finish(sequence) }
  }
  const submit = async (validateOnly = false): Promise<boolean> => {
    if (!deps.isCurrent() || !draft.loaded || draft.busy !== undefined || draft.remote !== undefined || draft.revision === undefined || hasTriggerFieldDrafts(draft)) return false
    const sequence = ++draft.sequence
    const submitted = structuredClone(draft.value)
    const expectedRevision = draft.revision
    draft.busy = validateOnly ? 'validate' : 'save'
    draft.validated = false
    draft.error = undefined
    deps.changed()
    try {
      const result = await deps.enqueue(presetId, async () => {
        if (!current(sequence)) return undefined
        return deps.request({ expectedPresetId: presetId, expectedRevision, triggers: submitted, ...(validateOnly ? { validateOnly: true } : {}) })
      })
      if (!current(sequence) || result === undefined) return false
      if (!result.ok) { draft.error = result; return false }
      if (validateOnly) {
        draft.validated = deepEqual(draft.value, submitted) && !hasTriggerFieldDrafts(draft)
      } else {
        draft.saved = structuredClone(submitted)
        draft.revision = result.value.revision
        draft.meta = result.value.meta
      }
      return true
    } catch (error) {
      if (current(sequence)) draft.error = failure(error)
      return false
    } finally { finish(sequence) }
  }
  /** 仅供用户确认放弃本地输入后调用；普通重新读取始终保留未保存草稿。 */
  const discard = (): void => {
    if (draft.busy !== undefined) return
    if (draft.remote !== undefined) {
      draft.saved = structuredClone(draft.remote.triggers)
      draft.revision = draft.remote.revision
      draft.meta = draft.remote.meta
      draft.loaded = true
    }
    draft.value = structuredClone(draft.saved)
    draft.fields.clear()
    draft.remote = undefined
    draft.error = undefined
    draft.validated = false
    deps.changed()
  }
  return { patch, load, submit, discard }
}

export type TriggerEditor = ReturnType<typeof createTriggerEditor>
