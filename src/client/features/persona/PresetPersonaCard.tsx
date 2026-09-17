/** preset.yml 顶层 persona 段编辑卡（官方 @deepseek-ai/dsh-persona 行 config 同构）。
 *  数据源 = /persona：无载荷读、带 persona 写，host 侧走 readPersonaSpec 校验 +
 *  savePresetPersona 原子写盘并重建。prefix/suffix 取代旧 promptConfigs
 *  params.sectionName + text 的人设承载方式；complete 与提示词配置的「独占」互斥，
 *  由 bridge 写盘前 fail loud。 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PersonaDraft, PersonaEditorDraft, WorkspaceDrafts } from '../../data/workspace-drafts.ts'
import { bridgeCall } from '../../data/bridge-client.ts'
import type { PromptToolTranslate } from '../../locales.ts'
import { EngineModuleCard } from '../../ui/EngineModuleCard.tsx'
import { ToggleRow } from '../../ui/ToggleRow.tsx'
import { ConfirmDialog } from '../../ui/ConfirmDialog.tsx'
import styles from '../../ui/controls.module.css'

type Notice = (kind: 'ok' | 'error', message: string) => void

const EMPTY_PERSONA: PersonaDraft = { prefix: '', suffix: '', complete: false, includeRuntimeContext: true }

export function PresetPersonaCard(props: { t: PromptToolTranslate; presetId?: string; disabled?: boolean; drafts?: WorkspaceDrafts; onNotice: Notice }): ReactNode {
  const { t, onNotice } = props
  const editor = useMemo((): PersonaEditorDraft => {
    const key = props.presetId ?? ''
    const retained = props.drafts?.persona.get(key)
    if (retained) return retained
    const next = { value: EMPTY_PERSONA, saved: EMPTY_PERSONA, declared: false, loaded: false, error: '', saving: false }
    props.drafts?.persona.set(key, next)
    return next
  }, [props.drafts, props.presetId])
  const [draft, setDraft] = useState<PersonaDraft>(editor.value)
  const [declared, setDeclared] = useState(editor.declared)
  const [loaded, setLoaded] = useState(editor.loaded)
  const [dirty, setDirty] = useState(editor.value !== editor.saved)
  const [saving, setSaving] = useState(false)
  const [loadError, setLoadError] = useState(editor.error)
  const [confirmingRemove, setConfirmingRemove] = useState(false)
  const active = useRef<PersonaEditorDraft | null>(editor)

  const load = useCallback(() => {
    setLoadError('')
    const readingDraft = editor.value
    void bridgeCall('persona', { expectedPresetId: props.presetId }).then((result) => {
      if (active.current !== editor) return
      if (editor.value !== readingDraft) return
      if (result.ok) {
        const persona = result.value.persona
        const next = persona === null ? EMPTY_PERSONA : {
          prefix: persona.prefix,
          suffix: persona.suffix ?? '',
          complete: persona.complete === true,
          includeRuntimeContext: persona.includeRuntimeContext !== false,
        }
        editor.value = next
        editor.saved = next
        editor.declared = persona !== null
        editor.loaded = true
        editor.error = ''
        setDraft(next)
        setDirty(false)
        setDeclared(persona !== null)
      } else {
        editor.error = result.message ?? t('persona.notice.loadFailed')
        setLoadError(editor.error)
        onNotice('error', editor.error)
      }
      setLoaded(true)
    })
  }, [editor, props.presetId, onNotice, t])
  useEffect(() => {
    active.current = editor
    const refresh = (): void => {
      setDraft(editor.value); setDeclared(editor.declared); setLoaded(editor.loaded)
      setDirty(editor.value !== editor.saved); setLoadError(editor.error); setSaving(editor.saving)
    }
    editor.refresh = refresh
    refresh()
    if (!editor.loaded || (editor.value === editor.saved && !editor.saving)) load()
    return () => { active.current = null; if (editor.refresh === refresh) editor.refresh = undefined }
  }, [editor, load])

  const patch = (next: Partial<PersonaDraft>): void => {
    editor.value = { ...editor.value, ...next }
    setDraft(editor.value)
    setDirty(true)
  }
  const write = async (persona: { prefix: string; suffix?: string; complete?: boolean; includeRuntimeContext?: boolean } | null): Promise<void> => {
    if (editor.saving || !editor.loaded || props.disabled || loadError) return
    const submitted = persona === null ? EMPTY_PERSONA : editor.value
    editor.saving = true
    setSaving(true)
    await bridgeCall('persona', { persona, expectedPresetId: props.presetId }).then((result) => {
      editor.saving = false
      if (result.ok) {
        editor.saved = submitted
        editor.declared = persona !== null
        if (persona === null && editor.value === draft) editor.value = EMPTY_PERSONA
      }
      editor.refresh?.()
      if (active.current !== editor) return
      setSaving(false)
      if (result.ok) {
        setDeclared(editor.declared)
        setDraft(editor.value)
        setDirty(editor.value !== editor.saved)
        setConfirmingRemove(false)
        onNotice('ok', persona === null ? t('persona.notice.removed') : t('persona.notice.saved'))
      } else {
        onNotice('error', result.message ?? t('persona.notice.saveFailed'))
        if (persona === null) throw new Error(result.message ?? t('persona.notice.saveFailed'))
      }
    })
  }
  const save = (): void => {
    const untouched = draft.prefix === '' && draft.suffix === '' && !draft.complete && draft.includeRuntimeContext
    void write(!declared && untouched ? null : {
      prefix: draft.prefix,
      ...(draft.suffix.length > 0 ? { suffix: draft.suffix } : {}),
      ...(draft.complete ? { complete: true } : {}),
      ...(draft.includeRuntimeContext ? {} : { includeRuntimeContext: false }),
    })
  }
  const busy = props.disabled === true || saving || !loaded || loadError.length > 0
  return (
    <EngineModuleCard
      name={t('persona.name')}
      meta={declared ? t('persona.meta.declared') : t('persona.meta.inherited')}
      layer="system-section"
      defaultExpanded={props.drafts?.expanded.get(`${props.presetId ?? ''}:persona`)}
      onExpandedChange={(value) => props.drafts?.expanded.set(`${props.presetId ?? ''}:persona`, value)}
    >
      {loadError && <p className={styles.noticeError} role="alert">{loadError} <Button size="sm" onClick={load}>{t('workspace.retry')}</Button></p>}
      {dirty && <p className={styles.configFieldHint} role="status">{t('card.unsaved')}</p>}
      {confirmingRemove && <ConfirmDialog title={t('persona.remove')} description={t('persona.removeDescription')}
        confirmLabel={t('persona.remove')} cancelLabel={t('toolEditor.cancel')}
        onConfirm={() => write(null)} onCancel={() => setConfirmingRemove(false)} />}
      <span className={styles.configFieldStack}>
        <span className={styles.configFieldLabel}>{t('persona.prefix.label')}</span>
        <textarea
          className={styles.configTextarea}
          aria-label={t('persona.prefix.aria')}
          value={draft.prefix}
          spellCheck={false}
          readOnly={props.disabled || !loaded || !!loadError}
          onChange={(event) => patch({ prefix: event.target.value })}
        />
        <span className={styles.configFieldHint}>{t('persona.prefix.hint')}</span>
      </span>
      <span className={styles.configFieldStack}>
        <span className={styles.configFieldLabel}>{t('persona.suffix.label')}</span>
        <textarea
          className={styles.configTextarea}
          aria-label={t('persona.suffix.aria')}
          value={draft.suffix}
          spellCheck={false}
          readOnly={props.disabled || !loaded || !!loadError}
          onChange={(event) => patch({ suffix: event.target.value })}
        />
        <span className={styles.configFieldHint}>{t('persona.suffix.hint')}</span>
      </span>
      <ToggleRow
        id="persona-complete"
        label={t('persona.complete.label')}
        hint={t('persona.complete.hint')}
        checked={draft.complete}
        disabled={props.disabled || !loaded || !!loadError}
        onChange={(next) => patch({ complete: next })}
      />
      <ToggleRow
        id="persona-runtime-context"
        label={t('persona.runtimeContext.label')}
        hint={t('persona.runtimeContext.hint')}
        checked={draft.includeRuntimeContext}
        disabled={props.disabled || !loaded || !!loadError}
        onChange={(next) => patch({ includeRuntimeContext: next })}
      />
      <div className={styles.configActions}>
        <Button size="sm" disabled={busy || !dirty} onClick={save}>{saving ? t('persona.saving') : t('persona.save')}</Button>
        {declared && (
          <button type="button" className={styles.pillButton} data-danger disabled={busy} onClick={() => setConfirmingRemove(true)}>{t('persona.remove')}</button>
        )}
      </div>
    </EngineModuleCard>
  )
}
