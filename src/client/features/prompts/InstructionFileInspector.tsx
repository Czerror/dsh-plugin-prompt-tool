import { useId, useLayoutEffect, useRef, useState, type MutableRefObject, type ReactNode } from 'react'
import { canSaveDraft } from '../../data/instruction-drafts.ts'
import { instructionFileIdOf } from '../../data/prompt-config-content.ts'
import type { InstructionFilesPort } from '../../data/store-ports.ts'
import { useAutosave } from '../../data/use-autosave.ts'
import type { PromptToolTranslate } from '../../locales.ts'
import type { PromptConfigDraft } from '../../prompt-tool-types.ts'
import { Button } from '../../ui/Button.tsx'
import { ConfirmDialog } from '../../ui/ConfirmDialog.tsx'
import { IconCloseFillRegular } from '../../ui/icons.tsx'
import { Switch } from '../../ui/Switch.tsx'
import css from './instruction-file-inspector.module.css'

export function InstructionFileInspector({ store, t, config, renderInstructionSettings, onClose, leaveSave }: {
  store: InstructionFilesPort
  t: PromptToolTranslate
  config: PromptConfigDraft
  renderInstructionSettings?: (config: PromptConfigDraft) => ReactNode
  onClose: (restoreFocus: boolean) => void
  leaveSave: MutableRefObject<(() => void) | undefined>
}): ReactNode {
  const heading = useRef<HTMLHeadingElement>(null)
  const reloadButton = useRef<HTMLButtonElement>(null)
  const headingId = useId()
  const textId = useId()
  const [confirmReload, setConfirmReload] = useState(false)
  const fileId = instructionFileIdOf(config)
  const path = String(config.params?.displayPath ?? config.params?.file ?? '')
  const name = path.split(/[\\/]/).pop() || config.name || config.id
  const isReadOnly = config.contentStatus !== 'ready' || config.contentConflict === true
  const controlled = config.agentControl?.enabled === false
  const autosave = useAutosave(config.id, () => {
    if (!fileId || isReadOnly || confirmReload) return
    const pool = store.getInstructionPool()
    const draft = pool.drafts.find(entry => entry.fileId === fileId)
    if (draft && (draft.saving || canSaveDraft(pool, draft))) void store.persistInstructionFiles([fileId])
  })
  useLayoutEffect(() => {
    leaveSave.current = autosave.flush
    return () => { if (leaveSave.current === autosave.flush) leaveSave.current = undefined }
  })
  useLayoutEffect(() => { heading.current?.focus({ preventScroll: true }) }, [fileId])
  if (!fileId) return null

  const status = config.contentConflict ? t('card.chip.fileConflict')
    : config.contentStatus === 'missing' ? t('card.fileMissing') : config.contentStatus === 'too-large' ? t('card.fileTooLarge')
      : isReadOnly ? t('card.chip.fileUnavailable') : config.contentSaving ? t('card.chip.fileSaving')
        : config.contentDirty ? t('card.chip.fileDirty') : ''
  return <aside className={css.inspector} aria-labelledby={headingId} data-instruction-inspector
    onFocus={autosave.onFocus} onBlur={autosave.onBlur}
    onCompositionStart={autosave.onCompositionStart} onCompositionEnd={autosave.onCompositionEnd}
    onKeyDown={event => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229
        || !(event.target instanceof Node) || !event.currentTarget.contains(event.target) || confirmReload) return
      event.preventDefault()
      event.stopPropagation()
      onClose(true)
    }}>
    <header className={css.header}>
      <span className={css.mark} aria-hidden="true">MD</span>
      <div className={css.identity}>
        <h3 id={headingId} ref={heading} tabIndex={-1}>{name}</h3>
        <small title={path}>{path}</small>
      </div>
      <Button icon aria-label={t('rules.closePanel', { name })} onClick={() => onClose(true)}><IconCloseFillRegular /></Button>
    </header>
    <div className={css.body}>
      <label className={css.policy}><span>{t('rules.enableInstruction')}</span>
        <Switch checked={config.enabled !== false && !controlled} label={t('card.enableAria', { name })}
          disabled={controlled || config.contentSaving || store.instructionPolicy.error !== undefined}
          onChange={enabled => { void store.updateInstructionPolicy(fileId, { enabled }) }} />
      </label>
      {controlled && <p>{t('card.agentControl', { rules: config.agentControl?.controlRules.length ? ' · ' + config.agentControl.controlRules.join(', ') : '' })}</p>}
      <label className={css.textLabel} htmlFor={textId}>{t('rules.instructionBody')}</label>
      <textarea id={textId} className={css.text} value={config.text ?? ''} spellCheck={false} readOnly={isReadOnly}
        onChange={event => store.patchInstructionText(fileId, event.currentTarget.value)} />
      <div className={css.fileActions}>
        <span role="status" aria-atomic="true">{status}</span>
        {isReadOnly ? <Button ref={reloadButton} variant="outline" disabled={config.contentSaving}
          onClick={() => { if (config.contentDirty) setConfirmReload(true); else void store.reloadInstructionFile(fileId) }}>{t('card.reloadFile')}</Button>
          : <Button variant="outline" disabled={!config.contentDirty || config.contentSaving} onClick={autosave.flush}>{t('card.saveFile')}</Button>}
      </div>
      {config.contentMessage && <p role="alert">{config.contentMessage}</p>}
      {config.contentConflict && <p>{t('card.fileConflictDetail')}</p>}
      {renderInstructionSettings?.(config)}
    </div>
    {confirmReload && <ConfirmDialog title={t('card.reloadTitle', { name })} description={t('card.reloadDescription')}
      confirmLabel={t('card.reloadFile')} cancelLabel={t('card.cancel')} failureMessage={t('card.operationFailed')}
      returnFocusRef={reloadButton} onCancel={() => setConfirmReload(false)} onConfirm={() => store.reloadInstructionFile(fileId)} />}
  </aside>
}
