/** 独立主/子人设卡；字段省略、显式空文本与 false 分别保存。 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Button } from '../../ui/Button.tsx'
import { createWorkspaceDrafts, type PersonaEditorDraft, type WorkspaceDrafts } from '../../data/workspace-drafts.ts'
import { bridgeCall } from '../../data/bridge-client.ts'
import type { PromptToolTranslate } from '../../locales.ts'
import { moduleDeclares } from '../../data/module-subject.ts'
import type { ModuleSummary } from '../../../shared/bridge-contract.ts'
import { CollapsibleCard } from '../../ui/CollapsibleCard.tsx'
import { PromptConfigNavigation } from '../../ui/PromptConfigNavigation.tsx'
import { MenuSelect } from '../../ui/MenuSelect.tsx'
import type { PersonaAudience, PersonaSources, PersonaSpec, PersonaTargetSpec } from '../../../shared/persona-section.ts'
import type { BridgeRequestMap } from '../../../shared/bridge-contract.ts'
import { ConfirmDialog } from '../../ui/ConfirmDialog.tsx'
import { FormField } from '../../ui/FormField.tsx'
import styles from '../../ui/controls.module.css'
import css from './persona.module.css'

type Notice = (kind: 'ok' | 'error', message: string) => void

/**
 * 人设写请求载荷：**创建模式（该模块未声明 `persona`）不传 `expectedRevision`**——没有前状态就没有
 * 可冲突的对象（服务端据此走创建语义）；已声明时必须带读取到的模块版本。
 * `persona: null` 仍是「删除该段」的既有语义（只在已声明时有意义）。
 */
export function personaWriteBody(moduleId: string, submitted: PersonaSpec, revision: string, creating: boolean): BridgeRequestMap['persona'] {
  return {
    persona: Object.keys(submitted).length ? submitted : null,
    expectedModuleId: moduleId,
    ...(creating ? {} : { expectedRevision: revision }),
  }
}

/**
 * 人设读数请求（主语＝该模块）：**声明面明确未声明就不构造这次请求**（返回 `undefined`）——
 * 服务端读了也是 400 `module-not-declared`。这只决定「读不发」，不决定编辑器出不出：
 * 本卡是固定卡，未声明时按空内容渲染编辑器，保存即建立该节（写路径不查声明面）。
 */
export const readModulePersona = (moduleId: string, undeclared: boolean) =>
  undeclared ? undefined : bridgeCall('persona', { expectedModuleId: moduleId }, moduleId)
const notify = (draft: { listeners?: Set<() => void> }): void => { for (const listener of draft.listeners ?? []) listener() }

/** 独立主/子人设卡；字段省略、显式空文本与 false 分别保存。
 *  **主语由归属方给**：本卡的主语来自它自己读到的 `personaSources`（main／subagent 指向哪个模块）；
 *  `moduleId` 只是外部给的首选模块，`canEditModule` 兜该模块的逐模块可编辑判据（无模块时不兜底）。 */
export function ModulePersonaCard(props: {
  t: PromptToolTranslate
  audience: PersonaAudience
  moduleId?: string
  disabled?: boolean
  /** 该模块此刻是否可编辑（总闸 + 逐模块事实）；不传＝只按全局总闸判断。 */
  canEditModule?: (moduleId: string) => boolean
  /** `/meta` 的模块快照：`declares` 是「这个主语声明了 persona 吗」的唯一判据。 */
  modules?: readonly ModuleSummary[]
  /** 该模块未声明 `persona`、首次成功写盘建立声明后回调：调用方据此重读 `/meta`。 */
  onDeclared?: () => void
  drafts?: WorkspaceDrafts
  onNotice: Notice
}): ReactNode {
  const { t, onNotice, audience } = props
  const localDrafts = useRef(createWorkspaceDrafts())
  const drafts = props.drafts ?? localDrafts.current
  const selection = drafts.personaSources
  const [, redraw] = useState(0)
  const mounted = useRef(false)
  const [confirming, setConfirming] = useState<{ moduleId: string; audience: PersonaAudience; reload?: boolean }>()
  const [activeField, setActiveField] = useState<'prefix' | 'suffix'>('prefix')
  const saveTimer = useRef<ReturnType<typeof setTimeout>>()
  const composing = useRef(false)
  const refresh = useCallback(() => { if (mounted.current) redraw(value => value + 1) }, [])
  const editorOf = useCallback((moduleId: string): PersonaEditorDraft => {
    let editor = drafts.persona.get(moduleId)
    if (!editor) {
      const empty = {}
      editor = { value: empty, saved: empty, revision: '', declared: false, loaded: false, error: '', saving: false }
      drafts.persona.set(moduleId, editor)
    }
    return editor
  }, [drafts])
  const loadSources = useCallback(async (): Promise<void> => {
    if (selection.saving || selection.loading) return
    const sequence = ++selection.readSequence
    selection.loading = true
    selection.error = ''
    notify(selection)
    const result = await bridgeCall('personaSources')
    if (sequence !== selection.readSequence) return
    selection.loading = false
    if (result.ok) {
      const { sources, revision, candidates } = result.value
      selection.value = {
        main: selection.value.main !== selection.saved.main ? selection.value.main : sources.main,
        subagent: selection.value.subagent !== selection.saved.subagent ? selection.value.subagent : sources.subagent,
      }
      selection.saved = sources
      selection.revision = revision
      selection.candidates = candidates
      selection.loaded = true
    } else selection.error = result.message ?? t('persona.sources.loadFailed')
    notify(selection)
  }, [selection, t])
  const saveSources = async (next: PersonaSources, refreshOnly = false): Promise<void> => {
    if (selection.saving || selection.loading || !selection.loaded) return
    selection.value = next
    selection.saving = true
    selection.error = ''
    notify(selection)
    const result = await bridgeCall('personaSources', refreshOnly ? { refreshOnly: true } : { sources: next, expectedRevision: selection.revision })
    selection.saving = false
    if (result.ok) {
      selection.saved = result.value.sources
      selection.revision = result.value.revision
      selection.candidates = result.value.candidates
      selection.publicationPending = result.value.publicationPending === true
      selection.publicationError = result.value.publicationError
    } else selection.error = result.message ?? t('persona.sources.saveFailed')
    notify(selection)
    if (mounted.current) onNotice(result.ok && !selection.publicationPending ? 'ok' : 'error',
      selection.error || selection.publicationError || t('persona.sources.saved'))
  }
  /** 本卡的主语：人设来源指向的模块（没有来源就用调用方给的首选模块）。 */
  const moduleId = selection.value[audience] ?? props.moduleId
  const currentOwner = useRef({ moduleId, audience })
  currentOwner.current = { moduleId, audience }
  /** 该主语没声明 `persona`：**不读该节**（读了也是 400）、内容按空、保存即建立声明。
   *  本卡是固定卡——未声明也照常出编辑器，编辑器不随声明面出现或消失。未知（未下发）不当作未声明。 */
  const undeclared = moduleId !== undefined && moduleDeclares(props.modules, moduleId, 'persona') === false
  const loadPersona = useCallback(async (moduleId: string, discard = false): Promise<void> => {
    const editor = editorOf(moduleId)
    if (editor.saving || editor.loading || (!discard && JSON.stringify(editor.value) !== JSON.stringify(editor.saved))) return
    // 声明面明确未声明：创建模式——**不构造这次读**（读了也是 400）；空草稿就是真值，保存即建立该节。
    const pending = readModulePersona(moduleId, undeclared)
    if (pending === undefined) {
      editor.loaded = true
      editor.error = ''
      notify(editor)
      return
    }
    const sequence = (editor.readSequence ?? 0) + 1
    editor.readSequence = sequence
    editor.loading = true
    const readingDraft = editor.value
    editor.error = ''
    notify(editor)
    const result = await pending
    if (editor.readSequence !== sequence) return
    editor.loading = false
    if (editor.value !== readingDraft) { notify(editor); return }
    if (result.ok) {
      editor.value = editor.saved = result.value.persona ?? {}
      editor.revision = result.value.revision
      editor.declared = result.value.persona !== null
      editor.loaded = true
    } else editor.error = result.message ?? t('persona.notice.loadFailed')
    notify(editor)
  }, [editorOf, t, undeclared])
  useEffect(() => {
    mounted.current = true
    selection.listeners ??= new Set()
    selection.listeners.add(refresh)
    void loadSources()
    return () => { mounted.current = false; selection.listeners?.delete(refresh) }
  }, [selection, refresh, loadSources])
  useEffect(() => {
    if (!selection.loaded || !moduleId) return
    const editor = editorOf(moduleId)
    editor.listeners ??= new Set()
    editor.listeners.add(refresh)
    if (!editor.saving) void loadPersona(moduleId)
    return () => { editor.listeners?.delete(refresh) }
  }, [moduleId, selection.loaded, editorOf, loadPersona, refresh])

  const patch = (moduleId: string, audience: PersonaAudience, field: keyof PersonaTargetSpec, value: string | boolean | undefined): void => {
    const editor = editorOf(moduleId)
    const target = { ...editor.value[audience] }
    if (value === undefined) delete target[field]
    else Object.assign(target, { [field]: value })
    const next = { ...editor.value }
    if (Object.keys(target).length === 0) delete next[audience]
    else next[audience] = target
    editor.value = next
    notify(editor)
    if (saveTimer.current !== undefined) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      saveTimer.current = undefined
      if (!composing.current) void write(moduleId, audience)
    }, 600)
  }
  const write = async (moduleId: string, audience: PersonaAudience, remove = false): Promise<void> => {
    const editor = editorOf(moduleId)
    if (editor.saving || !editor.loaded || editor.error || editor.loading) return
    const target = editor.value[audience]
    const submitted = { ...editor.saved }
    if (remove || target === undefined) delete submitted[audience]
    else submitted[audience] = target
    editor.saving = true
    notify(editor)
    // 未声明 persona 的首次写入＝创建：不传 expectedRevision——没有前状态就没有可冲突的对象，
    // 传空串会被服务端当成非法版本拒绝。已声明时仍带读取到的模块版本。
    const creating = !editor.declared && moduleDeclares(props.modules, moduleId, 'persona') === false
    const result = await bridgeCall('persona', personaWriteBody(moduleId, submitted, editor.revision, creating), moduleId)
    editor.saving = false
    if (result.ok) {
      editor.saved = result.value.persona ?? {}
      editor.revision = result.value.revision
      editor.declared = result.value.persona !== null
      editor.publicationPending = result.value.publicationPending === true
      editor.publicationError = result.value.publicationError
      // 创建模式下这次写盘建立了声明：重读 `/meta`，卡片随即按正常形态出现。
      if (undeclared) props.onDeclared?.()
      if (editor.value[audience] === target) {
        editor.value = { ...editor.value }
        if (editor.saved[audience] === undefined) delete editor.value[audience]
        else editor.value[audience] = editor.saved[audience]
      }
    }
    if (result.ok && mounted.current && currentOwner.current.moduleId === moduleId && currentOwner.current.audience === audience
      && JSON.stringify(editor.value[audience]) !== JSON.stringify(editor.saved[audience]) && !composing.current) {
      if (saveTimer.current !== undefined) clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(() => { saveTimer.current = undefined; void write(moduleId, audience) }, 600)
    }
    notify(editor)
    if (mounted.current) onNotice(result.ok && !editor.publicationPending ? 'ok' : 'error',
      result.ok ? editor.publicationError ?? t(remove ? 'persona.notice.removed' : 'persona.notice.saved') : result.message ?? t('persona.notice.saveFailed'))
    if (!result.ok && remove) throw new Error(result.message ?? t('persona.notice.saveFailed'))
  }
  const retryPublication = async (moduleId: string): Promise<void> => {
    const editor = editorOf(moduleId)
    if (editor.saving || !editor.publicationPending) return
    editor.saving = true
    notify(editor)
    const result = await bridgeCall('persona', { expectedModuleId: moduleId, refreshOnly: true }, moduleId)
    editor.saving = false
    editor.publicationPending = !result.ok || result.value.publicationPending === true
    editor.publicationError = result.ok ? result.value.publicationError : result.message ?? t('persona.notice.saveFailed')
    notify(editor)
    if (mounted.current) onNotice(editor.publicationPending ? 'error' : 'ok', editor.publicationError ?? t('persona.notice.saved'))
  }
  useEffect(() => () => { if (saveTimer.current !== undefined) clearTimeout(saveTimer.current) }, [moduleId, audience])
  const sourcesDirty = selection.value.main !== selection.saved.main || selection.value.subagent !== selection.saved.subagent
  const editor = moduleId ? editorOf(moduleId) : undefined
  const target = editor?.value[audience]
  const dirty = JSON.stringify(target) !== JSON.stringify(editor?.saved[audience])
  const canEdit = !!moduleId && (selection.value[audience] !== null || props.disabled !== true)
  const busy = !canEdit || !selection.loaded || !editor?.loaded || !!editor.error || editor.loading
    || (moduleId !== undefined && props.canEditModule !== undefined && !props.canEditModule(moduleId))
  const options = [{ value: '', label: t('persona.sources.official') }, ...selection.candidates.map(candidate => ({ value: candidate.id, label: `${candidate.name} · ${candidate.id}` }))]
  const source = options.find(option => option.value === (selection.value[audience] ?? ''))?.label ?? selection.value[audience] ?? ''
  // 展开状态按**卡片自己的模块主语**建键（调用方给的 `props.moduleId`，与资产卡同一来源）：
  // 恒有字符串键，所以「继承官方」（没有模块主语）那一态也能点开——否则这张卡默认状态整块打不开。
  // 用来源模块（下面那个解析后的 `moduleId`）建键会让「换来源」顺手把卡收起来，也不是原始接线。
  // 不回落 DEFAULT_MODULE_ID，也不发明「当前模块」。
  const expandedKey = `${props.moduleId ?? ''}:persona:${audience}`
  return (
    <CollapsibleCard
      id={`persona-${audience}`}
      title={t('persona.title', { audience: t(`persona.${audience}`) })}
      meta={t('persona.sources.current', { source })}
      bodyClassName={`${styles.configForm} ${css.body}`}
      expanded={drafts.expanded.get(expandedKey) ?? false}
      onToggle={value => { drafts.expanded.set(expandedKey, value); refresh() }}
      actions={<MenuSelect compact value={selection.value[audience] ?? ''} options={options}
        ariaLabel={t('persona.sources.label', { audience: t(`persona.${audience}`) })}
        disabled={selection.saving || selection.loading || !selection.loaded}
        onChange={value => { void saveSources({ ...selection.value, [audience]: value || null }) }} />}
    >
      {selection.error && <p className={styles.noticeError} role="alert">{selection.error} <Button shape="pill" variant="outline" size="sm" disabled={selection.loading || selection.saving} onClick={() => { void loadSources() }}>{t('persona.sources.reload')}</Button></p>}
      {selection.publicationPending && <p className={styles.noticeError} role="alert">{selection.publicationError ?? t('persona.sources.publicationPending')} <Button shape="pill" variant="outline" size="sm" disabled={selection.saving || selection.loading} onClick={() => { void saveSources(selection.value, true) }}>{t('workspace.retry')}</Button></p>}
      {sourcesDirty && <p className={styles.configFieldHint} role="status">{t('persona.sources.unsaved')} <Button shape="pill" variant="outline" size="sm" disabled={selection.saving || selection.loading || !selection.loaded} onClick={() => { void saveSources(selection.value) }}>{t('workspace.retry')}</Button></p>}
      {confirming && <ConfirmDialog title={t(confirming.reload ? 'persona.reload' : 'persona.remove')}
        description={t(confirming.reload ? 'persona.sources.reloadDescription' : 'persona.sources.removeDescription', { module: confirming.moduleId, audience: t(`persona.${confirming.audience}`) })}
        confirmLabel={t(confirming.reload ? 'persona.reload' : 'persona.remove')} cancelLabel={t('toolEditor.cancel')}
        onConfirm={() => confirming.reload ? loadPersona(confirming.moduleId, true) : write(confirming.moduleId, confirming.audience, true)}
        onCancel={() => setConfirming(undefined)} />}
      {dirty && <p className={styles.configFieldHint} role="status">{t('card.unsaved')}</p>}
      {editor?.error && <p className={styles.noticeError} role="alert">{editor.error}</p>}
      {editor?.publicationPending && <p className={styles.noticeError} role="alert">{editor.publicationError ?? t('persona.sources.publicationPending')} <Button shape="pill" variant="outline" size="sm" disabled={editor.saving} onClick={() => { if (moduleId) void retryPublication(moduleId) }}>{t('workspace.retry')}</Button></p>}
      {/* 固定卡：未声明 `persona` 也照常出编辑器（读请求不发、内容按空、保存即建立声明）。 */}
      {undeclared && <p className={styles.configFieldHint} role="status">{t('declare.createHint')}</p>}
      <div className={css.options}>
        <FormField label={t('persona.mode')}>
          <MenuSelect compact value={target?.[activeField] === undefined ? 'inherit' : 'custom'} disabled={busy}
            ariaLabel={`${t(`persona.${audience}`)} ${t(`persona.${activeField}.label`)}`}
            options={[{ value: 'inherit', label: t('persona.inherit') }, { value: 'custom', label: t('persona.custom') }]}
            onChange={value => { if (moduleId) { patch(moduleId, audience, activeField, value === 'inherit' ? undefined : ''); if (saveTimer.current !== undefined) clearTimeout(saveTimer.current); void write(moduleId, audience) } }} />
        </FormField>
        {(['complete', 'includeRuntimeContext'] as const).map(option => {
          const key = option === 'complete' ? 'complete' : 'runtimeContext'
          return <FormField key={option} label={t(`persona.${key}.label`)} hint={t(`persona.${key}.hint`)} hintMode="tooltip">
            <MenuSelect compact disabled={busy} value={target?.[option] === undefined ? 'inherit' : String(target?.[option])}
              ariaLabel={`${t(`persona.${audience}`)} ${t(`persona.${key}.label`)}`}
              options={[{ value: 'inherit', label: t('persona.inherit') }, { value: 'true', label: t('persona.on') }, { value: 'false', label: t('persona.off') }]}
              onChange={value => { if (moduleId) { patch(moduleId, audience, option, value === 'inherit' ? undefined : value === 'true'); if (saveTimer.current !== undefined) clearTimeout(saveTimer.current); void write(moduleId, audience) } }} />
          </FormField>
        })}
      </div>
      <PromptConfigNavigation t={t} layer="system-section" activePanel={activeField}
        onPanelChange={field => setActiveField(field === 'suffix' ? 'suffix' : 'prefix')}>
        {(['prefix', 'suffix'] as const).map(field => (
          <section key={field} data-config-panel={field} aria-label={t(`persona.${field}.label`)} className={css.panel}>
            <textarea className={styles.configTextarea}
              aria-label={`${t(`persona.${audience}`)} ${t(`persona.${field}.aria`)}`} spellCheck={false}
              value={target?.[field] ?? ''} readOnly={busy || target?.[field] === undefined}
              placeholder={target?.[field] === undefined ? t('persona.inheritedText', { field: t(`persona.${field}.label`) }) : undefined}
              onCompositionStart={() => { composing.current = true; if (saveTimer.current !== undefined) clearTimeout(saveTimer.current) }}
              onCompositionEnd={() => { composing.current = false; if (moduleId) { if (saveTimer.current !== undefined) clearTimeout(saveTimer.current); saveTimer.current = setTimeout(() => { saveTimer.current = undefined; void write(moduleId, audience) }, 600) } }}
              onChange={event => { if (moduleId) patch(moduleId, audience, field, event.target.value) }} />
            <p className={styles.configFieldHint}>{t(`persona.${field}.hint`)}</p>
          </section>
        ))}
      </PromptConfigNavigation>
      <div className={css.footer}>
        <Button shape="pill" variant="outline" size="sm" disabled={busy || editor?.saving || !dirty} onClick={() => { if (moduleId) void write(moduleId, audience) }}>{editor?.saving ? t('persona.saving') : t('persona.save')}</Button>
        <Button shape="pill" variant="outline" size="sm" disabled={!moduleId || editor?.saving || editor?.loading} onClick={() => {
          if (!moduleId || !editor) return
          if (JSON.stringify(editor.value) !== JSON.stringify(editor.saved)) setConfirming({ moduleId, audience, reload: true })
          else void loadPersona(moduleId)
        }}>{t('persona.reload')}</Button>
        {editor?.saved[audience] && <Button shape="pill" variant="outline" data-danger disabled={busy || editor.saving} onClick={() => { if (moduleId) setConfirming({ moduleId, audience }) }}>{t('persona.remove')}</Button>}
      </div>
    </CollapsibleCard>
  )
}
