/**
 * 人设草稿的**读改写 owner**：读取守卫、在途判定、创建模式与自动续存只在这一处。
 *
 * 形态照 tools 那份样板（`tools-editor.ts`）——载体作位置参数、依赖显式、用 `resource-track.ts`
 * 的原语。比 tools 多的是人设自己的东西：两受众共一份草稿、`revision` ＋ `declared` 的 CAS、
 * 以及「改完停 600ms 自动续存」。少的是 `busy` 语义（人设用 `saving`／`loading` 两个布尔）。
 *
 * `personaSources` 槽**不在这里**：它是单例、`revision` 可为 `null`、读/写都不带主语头，
 * 形状与 persona 不同，仍留在卡里。
 */
import type { PersonaAudience, PersonaSpec } from '../../shared/persona-section.ts'
import type { BridgeRequestMap, BridgeValueMap } from '../../shared/bridge-contract.ts'
import type { BridgeResult } from './bridge-client.ts'
import type { PersonaDraft, PersonaEditorDraft, WorkspaceDrafts } from './workspace-drafts.ts'
import type { PromptToolTranslate } from '../locales.ts'
import { bridgeCall } from './bridge-client.ts'
import { beginLatest, isLatest } from './resource-track.ts'

/** 人设写载荷：**创建模式（该模块未声明 `persona`）不传 `expectedRevision`**——没有前状态就没有可冲突的对象；已声明时必须带读取到的模块版本。`persona: null` 仍是「删除该段」。 */
export function personaWriteBody(moduleId: string, submitted: PersonaSpec, revision: string, creating: boolean): BridgeRequestMap['persona'] {
  return {
    persona: Object.keys(submitted).length ? submitted : null,
    expectedModuleId: moduleId,
    ...(creating ? {} : { expectedRevision: revision }),
  }
}

/** 人设读数请求：**声明面明确未声明就不构造这次请求**（返回 `undefined`）——服务端读了也是 400。这只决定「读不发」，不决定编辑器出不出（本卡是固定卡，未声明时按空内容渲染）。 */
export const readModulePersona = (moduleId: string, undeclared: boolean, request: RequestPersona = (body, id) => bridgeCall('persona', body, id)) =>
  undeclared ? undefined : request({ expectedModuleId: moduleId }, moduleId)

type RequestPersona = (body: BridgeRequestMap['persona'], moduleId: string) => Promise<BridgeResult<BridgeValueMap['persona']>>
type Translate = PromptToolTranslate

export interface PersonaEditorDependencies {
  request: RequestPersona
  /** 主语＝该受众的人设来源（下拉里选的模块）；没选来源时用归属方给的首选模块。 */
  getModuleId: (audience: PersonaAudience) => string | undefined
  /** 该模块的声明面是否含 `persona`：`false`＝创建模式（读不发、写不带版本）。 */
  declares: (moduleId: string) => boolean | undefined
  isCurrent: () => boolean
  /** 该受众此刻仍是本卡显示的主语（换来源后就别续存了）。 */
  isCurrentSubject: (audience: PersonaAudience, moduleId: string) => boolean
  /** 输入法组合中：组合期间不自动落盘，等 `compositionEnd` 再排一次（原实现是卡里的 `composing` ref）。 */
  isComposing: () => boolean
  t: Translate
  changed: () => void
  onDeclared?: () => void
}

export interface PersonaEditor {
  readonly draft: PersonaEditorDraft
  load(audience: PersonaAudience, discard?: boolean): Promise<void>
  patch(audience: PersonaAudience, field: keyof PersonaTarget, value: string | boolean | undefined): void
  /** 提交本次受众：`{...saved}` 基础上覆盖或删除该受众，其余受众不动。 */
  save(audience: PersonaAudience, remove?: boolean): Promise<void>
  retryPublication(): Promise<void>
  /** 排一次自动续存（输入法 `compositionEnd` 用：组合结束后再等一个停顿）。 */
  scheduleAutoSave(audience: PersonaAudience, remove?: boolean): void
  /** 卸载时调用：取消待发的自动续存。 */
  cancelAutoSave(): void
}

type PersonaTarget = NonNullable<PersonaSpec[PersonaAudience]>

const AUTO_SAVE_MS = 600

/** 每个模块一个人设编辑 owner；实例跨渲染缓存，因为它持有续存定时器。 */
export function createPersonaEditors(drafts: WorkspaceDrafts, deps: PersonaEditorDependencies) {
  const owners = new Map<string, ReturnType<typeof createPersonaEditor>>()
  const editorOf = (moduleId: string): PersonaEditor => {
    let owner = owners.get(moduleId)
    if (owner === undefined) {
      owner = createPersonaEditor(moduleId, drafts, deps)
      owners.set(moduleId, owner)
    }
    // 草稿池可能被换实例：owner 跟着对齐，不抓死旧引用。
    owner.sync(ensureDraft(drafts, moduleId))
    return owner
  }
  return { editorOf }
}

/** owner 的完整形状：`sync` 只给 `createPersonaEditors` 用，不进公开的 `PersonaEditor`。 */
type PersonaEditorOwner = PersonaEditor & { sync: (next: PersonaEditorDraft) => void }

function createPersonaEditor(moduleId: string, drafts: WorkspaceDrafts, deps: PersonaEditorDependencies): PersonaEditorOwner {
  let draft = ensureDraft(drafts, moduleId)
  let saveTimer: ReturnType<typeof setTimeout> | undefined
  let currentSave: { audience: PersonaAudience; remove: boolean } = { audience: 'main', remove: false }
  const notify = (): void => { for (const listener of draft.listeners ?? []) listener() }
  const flush = (): void => {
    saveTimer = undefined
    // 输入法组合期间不落盘：等 compositionEnd 再排一次。
    if (!deps.isCurrent() || deps.isComposing()) return
    void save(currentSave.audience, currentSave.remove)
  }
  const scheduleAutoSave = (audience: PersonaAudience, remove = false): void => {
    currentSave = { audience, remove }
    if (saveTimer !== undefined) clearTimeout(saveTimer)
    saveTimer = setTimeout(flush, AUTO_SAVE_MS)
  }
  const load = async (audience: PersonaAudience, discard = false): Promise<void> => {
    const editor = draft
    // 脏草稿不重读：用户没保存的输入优先（`discard` 时例外——重读确认路径要覆盖）。
    if (editor.saving || editor.loading || (!discard && JSON.stringify(editor.value) !== JSON.stringify(editor.saved))) return
    const pending = readModulePersona(moduleId, deps.declares(moduleId) === false, deps.request)
    if (pending === undefined) {
      editor.loaded = true
      editor.error = ''
      notify()
      return
    }
    const sequence = beginLatest(editor)
    editor.loading = true
    const readingDraft = editor.value
    editor.error = ''
    notify()
    const result = await pending
    // 已卸载或已有更新的一次请求：这次应答既不落地也不清 loading（清理权归最新那次）。
    if (!deps.isCurrent() || !isLatest(editor, sequence)) return
    editor.loading = false
    // 读期间草稿被换过（用户输入或另一次编辑）：不覆盖。
    if (editor.value !== readingDraft) { notify(); return }
    if (result.ok) {
      editor.value = editor.saved = result.value.persona ?? {}
      editor.revision = result.value.revision
      editor.declared = result.value.persona !== null
      editor.loaded = true
    } else editor.error = result.message ?? deps.t('persona.notice.loadFailed')
    notify()
  }
  const patch = (audience: PersonaAudience, field: keyof PersonaTarget, value: string | boolean | undefined): void => {
    const editor = draft
    const target = { ...editor.value[audience] }
    if (value === undefined) delete target[field]
    else Object.assign(target, { [field]: value })
    const next: PersonaDraft = { ...editor.value }
    if (Object.keys(target).length === 0) delete next[audience]
    else next[audience] = target
    editor.value = next
    notify()
    scheduleAutoSave(audience)
  }
  const save = async (audience: PersonaAudience, remove = false): Promise<void> => {
    const editor = draft
    if (editor.saving || !editor.loaded || editor.error || editor.loading) return
    const target = editor.value[audience]
    const submitted: PersonaSpec = { ...editor.saved }
    if (remove || target === undefined) delete submitted[audience]
    else submitted[audience] = target
    editor.saving = true
    notify()
    // 未声明 `persona` 的首次写入＝创建：不传 expectedRevision；已声明时带读取到的模块版本。
    const creating = !editor.declared && deps.declares(moduleId) === false
    const result = await deps.request(personaWriteBody(moduleId, submitted, editor.revision, creating), moduleId)
    editor.saving = false
    if (result.ok) {
      editor.saved = result.value.persona ?? {}
      editor.revision = result.value.revision
      editor.declared = result.value.persona !== null
      editor.publicationPending = result.value.publicationPending === true
      editor.publicationError = result.value.publicationError
      editor.error = editor.publicationError ?? ''
      // 创建模式下这次写盘建立了声明：调用方据此重读 `/meta`。
      if (result.value.persona !== null) deps.onDeclared?.()
      // 写盘期间本受众没被再改：把服务端值回填进草稿（改过就保留用户输入）。
      if (editor.value[audience] === target) {
        editor.value = { ...editor.value }
        if (editor.saved[audience] === undefined) delete editor.value[audience]
        else editor.value[audience] = editor.saved[audience]
      }
    } else {
      editor.error = result.message ?? deps.t('persona.notice.saveFailed')
      if (remove) throw new Error(result.message ?? deps.t('persona.notice.saveFailed'))
    }
    notify()
    // 写盘期间又有新输入、且本受众仍是本卡的主语：继续排一次续存，别把它丢在草稿里。
    if (result.ok && deps.isCurrent() && deps.isCurrentSubject(audience, moduleId)
      && JSON.stringify(editor.value[audience]) !== JSON.stringify(editor.saved[audience])) scheduleAutoSave(audience, remove)
  }
  const retryPublication = async (): Promise<void> => {
    const editor = draft
    if (editor.saving || !editor.publicationPending) return
    editor.saving = true
    notify()
    const result = await deps.request({ expectedModuleId: moduleId, refreshOnly: true }, moduleId)
    editor.saving = false
    if (result.ok) {
      editor.publicationPending = result.value.publicationPending === true
      editor.publicationError = result.value.publicationError
      editor.error = editor.publicationError ?? ''
    } else editor.error = result.message ?? deps.t('persona.notice.saveFailed')
    notify()
  }
  return {
    get draft() { return draft },
    sync: (next: PersonaEditorDraft) => { draft = next },
    load, patch, save, retryPublication, scheduleAutoSave,
    cancelAutoSave: () => {
      if (saveTimer !== undefined) { clearTimeout(saveTimer); saveTimer = undefined }
      // 卸载同时让在途的读失效：原实现是卡片的 `mounted` ref 判据，owner 这里用序号表达同一件事。
      beginLatest(draft)
    },
  }
}

function ensureDraft(drafts: WorkspaceDrafts, moduleId: string): PersonaEditorDraft {
  const existing = drafts.persona.get(moduleId)
  if (existing !== undefined) return existing
  const empty = {}
  const created: PersonaEditorDraft = { value: empty, saved: empty, revision: '', declared: false, loaded: false, error: '', saving: false, latest: 0 }
  drafts.persona.set(moduleId, created)
  return created
}
