/** 独立主/子人设卡；字段省略、显式空文本与 false 分别保存。 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Button } from '../../ui/Button.tsx'
import { createWorkspaceDrafts, type PersonaEditorDraft, type WorkspaceDrafts } from '../../data/workspace-drafts.ts'
import { beginLatest, isLatest } from '../../data/resource-track.ts'
import { bridgeCall } from '../../data/bridge-client.ts'
import type { PromptToolTranslate } from '../../locales.ts'
import { moduleDeclares } from '../../data/module-subject.ts'
import type { ModuleSummary } from '../../../shared/bridge-contract.ts'
import { CollapsibleCard } from '../../ui/CollapsibleCard.tsx'
import { PromptConfigNavigation } from '../../ui/PromptConfigNavigation.tsx'
import { MenuSelect } from '../../ui/MenuSelect.tsx'
import { createPersonaEditors, personaWriteBody, readModulePersona } from '../../data/persona-editor.ts'
import type { PersonaAudience, PersonaSources, PersonaTargetSpec } from '../../../shared/persona-section.ts'
import { readPublication } from '../../../shared/publication.ts'
import { PublicationNotice } from '../../ui/PublicationNotice.tsx'
import { ConfirmDialog } from '../../ui/ConfirmDialog.tsx'
import { FormField } from '../../ui/FormField.tsx'
import styles from '../../ui/controls.module.css'
import css from './persona.module.css'

// 读改写已搬进 `data/persona-editor.ts`；这两个纯函数仍从本模块转出（既有测试与调用方按此路径导入）。
export { personaWriteBody, readModulePersona }

type Notice = (kind: 'ok' | 'error', message: string) => void

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
  const composing = useRef(false)
  const refresh = useCallback(() => { if (mounted.current) redraw(value => value + 1) }, [])
  // 人设的读改写归 owner（`data/persona-editor.ts`）；本卡只注册重画回调，并保留 selection（personaSources 仍在本卡）。
  const notify = (draft: { listeners?: Set<() => void> }): void => { for (const listener of draft.listeners ?? []) listener() }
  const loadSources = useCallback(async (): Promise<void> => {
    if (selection.saving || selection.loading) return
    const sequence = beginLatest(selection)
    selection.loading = true
    selection.error = ''
    notify(selection)
    const result = await bridgeCall('personaSources')
    if (!isLatest(selection, sequence)) return
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
      const publication = readPublication(result.value)
      selection.publicationPending = publication.pending
      selection.publicationError = publication.error
    } else selection.error = result.message ?? t('persona.sources.saveFailed')
    notify(selection)
    if (mounted.current) onNotice(result.ok && !selection.publicationPending ? 'ok' : 'error',
      selection.error || selection.publicationError || t('persona.sources.saved'))
  }
  /** 本卡的主语：人设来源指向的模块（没有来源就用调用方给的首选模块）。 */
  const moduleId = selection.value[audience] ?? props.moduleId
  /** 该主语没声明 `persona`：**不读该节**（读了也是 400）、内容按空、保存即建立声明。
   *  本卡是固定卡——未声明也照常出编辑器，编辑器不随声明面出现或消失。未知（未下发）不当作未声明。 */
  const undeclared = moduleId !== undefined && moduleDeclares(props.modules, moduleId, 'persona') === false
  const owners = useMemo(() => createPersonaEditors(drafts, {
    request: (body, moduleId) => bridgeCall('persona', body, moduleId),
    // 主语＝该受众的人设来源；没选来源时用归属方给的首选模块（`undefined` 表示当前没有主语）。
    getModuleId: target => selection.value[target] ?? props.moduleId,
    isCurrentSubject: (target, id) => (selection.value[target] ?? props.moduleId) === id,
    declares: id => moduleDeclares(props.modules, id, 'persona'),
    isCurrent: () => mounted.current,
    isComposing: () => composing.current,
    t,
    changed: refresh,
    onDeclared: props.onDeclared,
  }), [drafts, refresh, t, selection, props.modules, props.moduleId, props.onDeclared])
  useEffect(() => {
    mounted.current = true
    selection.listeners ??= new Set()
    selection.listeners.add(refresh)
    void loadSources()
    return () => { mounted.current = false; selection.listeners?.delete(refresh) }
  }, [selection, refresh, loadSources])
  const draftOf = (id: string): PersonaEditorDraft => owners.editorOf(id).draft
  useEffect(() => {
    if (!selection.loaded || !moduleId) return
    const editor = draftOf(moduleId)
    editor.listeners ??= new Set()
    editor.listeners.add(refresh)
    if (!editor.saving) void owners.editorOf(moduleId).load(audience)
    return () => { editor.listeners?.delete(refresh) }
  }, [audience, moduleId, selection.loaded, owners, refresh, draftOf])
  const patch = (moduleId: string, audience: PersonaAudience, field: keyof PersonaTargetSpec, value: string | boolean | undefined): void =>
    owners.editorOf(moduleId).patch(audience, field, value)
  /** 保存／删除本次受众：协议在 owner，本卡只负责提示与删除失败的错误抛出。 */
  const save = async (moduleId: string, audience: PersonaAudience, remove = false): Promise<void> => {
    const editor = draftOf(moduleId)
    try { await owners.editorOf(moduleId).save(audience, remove) } catch (error) {
      if (mounted.current) onNotice('error', error instanceof Error ? error.message : t('persona.notice.saveFailed'))
      return
    }
    if (!mounted.current) return
    onNotice(editor.error || editor.publicationPending ? 'error' : 'ok',
      editor.publicationError ?? (remove ? t('persona.notice.removed') : t('persona.notice.saved')))
  }
  const retryPublication = async (moduleId: string): Promise<void> => {
    const editor = draftOf(moduleId)
    await owners.editorOf(moduleId).retryPublication()
    if (mounted.current) onNotice(editor.publicationPending ? 'error' : 'ok', editor.publicationError ?? t('persona.notice.saved'))
  }
  // 卸载时取消待发的自动续存；两受众共用同一份草稿，故按 owner 取消。
  useEffect(() => () => { owners.editorOf(moduleId ?? '').cancelAutoSave() }, [audience, moduleId, owners])
  const sourcesDirty = selection.value.main !== selection.saved.main || selection.value.subagent !== selection.saved.subagent
  const editor = moduleId ? draftOf(moduleId) : undefined
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
      <PublicationNotice className={styles.noticeError} publication={{ pending: selection.publicationPending === true, error: selection.publicationError }} pendingLabel={t('persona.sources.publicationPending')} retryLabel={t('workspace.retry')} disabled={selection.saving || selection.loading} onRetry={() => { void saveSources(selection.value, true) }} />
      {sourcesDirty && <p className={styles.configFieldHint} role="status">{t('persona.sources.unsaved')} <Button shape="pill" variant="outline" size="sm" disabled={selection.saving || selection.loading || !selection.loaded} onClick={() => { void saveSources(selection.value) }}>{t('workspace.retry')}</Button></p>}
      {confirming && <ConfirmDialog title={t(confirming.reload ? 'persona.reload' : 'persona.remove')}
        description={t(confirming.reload ? 'persona.sources.reloadDescription' : 'persona.sources.removeDescription', { module: confirming.moduleId, audience: t(`persona.${confirming.audience}`) })}
        confirmLabel={t(confirming.reload ? 'persona.reload' : 'persona.remove')} cancelLabel={t('toolEditor.cancel')}
        onConfirm={() => confirming.reload ? owners.editorOf(confirming.moduleId).load(confirming.audience, true) : save(confirming.moduleId, confirming.audience, true)}
        onCancel={() => setConfirming(undefined)} />}
      {dirty && <p className={styles.configFieldHint} role="status">{t('card.unsaved')}</p>}
      {editor?.error && <p className={styles.noticeError} role="alert">{editor.error}</p>}
      <PublicationNotice className={styles.noticeError} publication={{ pending: editor?.publicationPending === true, error: editor?.publicationError }} pendingLabel={t('persona.sources.publicationPending')} retryLabel={t('workspace.retry')} disabled={editor?.saving} onRetry={() => { if (moduleId) void retryPublication(moduleId) }} />
      {/* 固定卡：未声明 `persona` 也照常出编辑器（读请求不发、内容按空、保存即建立声明）。 */}
      {undeclared && <p className={styles.configFieldHint} role="status">{t('declare.createHint')}</p>}
      <div className={css.options}>
        <FormField label={t('persona.mode')}>
          <MenuSelect compact value={target?.[activeField] === undefined ? 'inherit' : 'custom'} disabled={busy}
            ariaLabel={`${t(`persona.${audience}`)} ${t(`persona.${activeField}.label`)}`}
            options={[{ value: 'inherit', label: t('persona.inherit') }, { value: 'custom', label: t('persona.custom') }]}
            onChange={value => { if (moduleId) { patch(moduleId, audience, activeField, value === 'inherit' ? undefined : ''); owners.editorOf(moduleId).cancelAutoSave(); void save(moduleId, audience) } }} />
        </FormField>
        {(['complete', 'includeRuntimeContext'] as const).map(option => {
          const key = option === 'complete' ? 'complete' : 'runtimeContext'
          return <FormField key={option} label={t(`persona.${key}.label`)} hint={t(`persona.${key}.hint`)} hintMode="tooltip">
            <MenuSelect compact disabled={busy} value={target?.[option] === undefined ? 'inherit' : String(target?.[option])}
              ariaLabel={`${t(`persona.${audience}`)} ${t(`persona.${key}.label`)}`}
              options={[{ value: 'inherit', label: t('persona.inherit') }, { value: 'true', label: t('persona.on') }, { value: 'false', label: t('persona.off') }]}
              onChange={value => { if (moduleId) { patch(moduleId, audience, option, value === 'inherit' ? undefined : value === 'true'); owners.editorOf(moduleId).cancelAutoSave(); void save(moduleId, audience) } }} />
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
              onCompositionStart={() => { composing.current = true; if (moduleId) owners.editorOf(moduleId).cancelAutoSave() }}
              onCompositionEnd={() => { composing.current = false; if (moduleId) owners.editorOf(moduleId).scheduleAutoSave(audience) }}
              onChange={event => { if (moduleId) patch(moduleId, audience, field, event.target.value) }} />
            <p className={styles.configFieldHint}>{t(`persona.${field}.hint`)}</p>
          </section>
        ))}
      </PromptConfigNavigation>
      <div className={css.footer}>
        <Button shape="pill" variant="outline" size="sm" disabled={busy || editor?.saving || !dirty} onClick={() => { if (moduleId) void save(moduleId, audience) }}>{editor?.saving ? t('persona.saving') : t('persona.save')}</Button>
        <Button shape="pill" variant="outline" size="sm" disabled={!moduleId || editor?.saving || editor?.loading} onClick={() => {
          if (!moduleId || !editor) return
          if (JSON.stringify(editor.value) !== JSON.stringify(editor.saved)) setConfirming({ moduleId, audience, reload: true })
          else void owners.editorOf(moduleId).load(audience)
        }}>{t('persona.reload')}</Button>
        {editor?.saved[audience] && <Button shape="pill" variant="outline" data-danger disabled={busy || editor.saving} onClick={() => { if (moduleId) setConfirming({ moduleId, audience }) }}>{t('persona.remove')}</Button>}
      </div>
    </CollapsibleCard>
  )
}
