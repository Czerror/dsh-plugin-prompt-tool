import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import type { ImportChoices, ImportKind } from '../../shared/asset-transfer.ts'
import type { ImportOrderCandidates, ImportPreviewState } from '../prompt-tool-types.ts'
import type { PromptToolTranslate } from '../locales.ts'
import { DialogSurface } from './DialogSurface.tsx'
import { MenuSelect } from './MenuSelect.tsx'
import { ConfirmDialog } from './ConfirmDialog.tsx'
import { ImportFileButton } from './ImportFileButton.tsx'
import { ImportPreviewCard } from './ImportPreviewCard.tsx'
import sharedCss from './controls.module.css'
import css from './ImportDialog.module.css'

export function ImportDialog(props: {
  t: PromptToolTranslate
  destination: 'preset' | 'character'
  phase: 'idle' | 'reading' | 'confirming' | 'submitting' | 'stale' | 'error' | 'complete'
  preview?: ImportPreviewState
  candidates?: ImportOrderCandidates
  kinds?: ImportKind[]
  choices: ImportChoices
  sourceName: string
  sourceImage?: string
  error: string
  refreshError: string
  progress: { index: number; total: number; imported: number; skipped: number; failed: number; failures: string[] }
  targets: Array<{ id: string; name: string }>
  onFiles: (files: File[], directory: boolean) => void
  onChoices: (choices: ImportChoices) => void
  onConfirm: () => void
  onClose: () => void
  onReset: () => void
  onSkip: () => void
  onEnd: () => void
  onRepreview: () => void
  onRefresh: () => void
  onUse?: () => void
}): ReactNode {
  const { t, phase, preview, choices, progress } = props
  const [confirming, setConfirming] = useState(false)
  const [imageFailed, setImageFailed] = useState(false)
  const errorRef = useRef<HTMLParagraphElement>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const id = useId()
  const summary = preview?.summary
  const busy = phase === 'submitting'
  const complete = phase === 'complete'
  const validId = choices.targetId === undefined || (choices.targetId.length <= 128 && /^[a-z0-9][a-z0-9-]*$/.test(choices.targetId))
  const ready = phase === 'confirming' && preview !== undefined && validId && (choices.targetName === undefined || choices.targetName.trim().length > 0)
  const close = (): void => { if (!busy) props.onClose() }
  useEffect(() => { if (props.error) errorRef.current?.focus() }, [props.error])
  useEffect(() => { setConfirming(false) }, [preview?.previewRevision, phase])
  useEffect(() => { setImageFailed(false) }, [props.sourceImage])
  const fromCharacter = summary?.kind === 'native-character' || summary?.kind === 'st-character'
  const confirmLabel = choices.overwrite === true ? t('assetImport.update') : t(props.destination === 'preset' ? fromCharacter ? 'assetImport.createFromCharacter' : 'assetImport.createPreset' : 'assetImport.createCharacter')
  if (confirming) return <ConfirmDialog title={t('assetImport.overwriteTitle', { name: summary?.targetName ?? choices.targetName ?? '' })}
    description={t(props.destination === 'character' ? 'assetImport.characterReplace' : 'assetImport.presetReplace')}
    confirmLabel={confirmLabel} cancelLabel={t('assetImport.back')}
    onCancel={() => setConfirming(false)} onConfirm={() => { setConfirming(false); props.onConfirm() }} />
  return <DialogSurface title={t(props.destination === 'preset' ? 'assetImport.presetTitle' : 'assetImport.characterTitle')}
    closeLabel={t('assetImport.close')} onClose={close} size="wide" initialFocusRef={headingRef}
    footer={<>
      {complete ? <>
        <button type="button" className={sharedCss.pillButton} onClick={close}>{t('assetImport.done')}</button>
        {props.refreshError ? <button type="button" className={sharedCss.primaryPill} onClick={props.onRefresh}>{t('assetImport.refresh')}</button>
          : props.onUse && progress.imported > 0 ? <button type="button" className={sharedCss.primaryPill} onClick={props.onUse}>{t(props.destination === 'preset' ? 'assetImport.switch' : 'assetImport.apply')}</button> : null}
      </> : <>
        {phase !== 'idle' && progress.total <= 1 && <button type="button" className={sharedCss.pillButton} disabled={busy} onClick={props.onReset}>{t('assetImport.reselect')}</button>}
        {progress.total > 1 && <button type="button" className={sharedCss.pillButton} disabled={busy} onClick={props.onSkip}>{t('assetImport.skip')}</button>}
        <button type="button" className={sharedCss.pillButton} disabled={busy} onClick={progress.total > 1 ? props.onEnd : close}>{t(progress.total > 1 ? 'assetImport.end' : 'assetImport.cancel')}</button>
        {(phase === 'error' || phase === 'stale') ? <button type="button" className={sharedCss.primaryPill} onClick={props.onRepreview}>{t('assetImport.repreview')}</button>
          : phase !== 'idle' && <button type="button" className={sharedCss.primaryPill} disabled={!ready} onClick={() => choices.overwrite ? setConfirming(true) : props.onConfirm()}>{confirmLabel}</button>}
      </>}
    </>}>
    <div className={css.content} aria-busy={phase === 'reading' || busy}>
      <h2 ref={headingRef} tabIndex={-1} className={css.heading}>{t(complete ? 'assetImport.result' : phase === 'idle' ? 'assetImport.select' : 'assetImport.inspect')}</h2>
      <ol className={css.steps} aria-label={t('assetImport.steps')}>
        {(['assetImport.select', 'assetImport.inspect', 'assetImport.result'] as const).map((key, step) => <li key={key} aria-current={step === (complete ? 2 : phase === 'idle' ? 0 : 1) ? 'step' : undefined}>{t(key)}</li>)}
      </ol>
      {progress.total > 1 && !complete && <p>{t('assetImport.queue', { index: progress.index, total: progress.total })}</p>}
      {phase === 'idle' ? <>
        <p>{t('assetImport.formats')}</p><p>{t('assetImport.noWrite')}</p>
        <div className={css.actions}>
          <ImportFileButton label={t('assetImport.file')} ariaLabel={t('assetImport.file')} accept=".zip,.json,.png,.yml,.yaml" multiple={props.destination === 'character'} onFiles={(files) => props.onFiles(files, false)} />
          <ImportFileButton label={t('assetImport.folder')} ariaLabel={t('assetImport.folder')} directory onFiles={(files) => props.onFiles(files, true)} />
        </div>
      </> : complete ? <>
        <p role="status">{t('assetImport.counts', { imported: progress.imported, skipped: progress.skipped, failed: progress.failed })}</p>
        {progress.failures.length > 0 && <ul>{progress.failures.map((failure, index) => <li key={index}>{failure}</li>)}</ul>}
        {props.refreshError && <p role="alert">{t('assetImport.refreshFailed', { reason: props.refreshError })}</p>}
      </> : <>
        <p>{t('assetImport.source', { name: summary?.sourceName ?? props.sourceName })}</p>
        {props.sourceImage && (imageFailed ? <p>{t('assetImport.avatarUnavailable')}</p> : <img className={css.avatar} src={props.sourceImage} alt={t('assetImport.avatar', { name: summary?.targetName ?? props.sourceName })} onError={() => setImageFailed(true)} />)}
        {(phase === 'reading' || busy) && <p role="status">{t(busy ? 'assetImport.submitting' : 'assetImport.reading')}</p>}
        {props.error && <p ref={errorRef} tabIndex={-1} role="alert" className={sharedCss.confirmError}>{phase === 'stale' ? `${t('assetImport.stale')} ${props.error}` : props.error}</p>}
        {props.kinds !== undefined && <fieldset><legend>{t('assetImport.kind')}</legend>{props.kinds.map((kind) => <label key={kind} className={css.option}><input type="radio" name={`${id}-kind`} checked={choices.sourceKind === kind} onChange={() => props.onChoices({ sourceKind: kind })} />{t(`assetImport.kind.${kind}`)}</label>)}</fieldset>}
        {summary !== undefined && <>
          <p>{t(`assetImport.kind.${summary.kind}`)} · {t('assetImport.summary', { files: summary.files.length, bytes: summary.files.reduce((total, file) => total + file.bytes, 0), configs: summary.configCount })}</p>
          <fieldset disabled={busy} className={css.fields}>
            <legend>{t('assetImport.target')}</legend>
            <label>{t('assetImport.name')}<input value={choices.targetName ?? summary.targetName} onChange={(event) => props.onChoices({ targetName: event.target.value })} aria-invalid={choices.targetName?.trim() === ''} /></label>
            <label>{t('assetImport.id')}<input value={choices.targetId ?? summary.targetId} onChange={(event) => props.onChoices({ targetId: event.target.value })} aria-invalid={!validId} aria-describedby={!validId ? `${id}-invalid` : undefined} /></label>
            {!validId && <p id={`${id}-invalid`} role="alert">{t('assetImport.invalidId')}</p>}
            <label className={css.option}><input type="radio" name={`${id}-target`} checked={!choices.overwrite} onChange={() => props.onChoices({ overwrite: false, targetId: undefined })} />{t('assetImport.new')}</label>
            <label className={css.option}><input type="radio" name={`${id}-target`} checked={choices.overwrite === true} disabled={props.targets.length === 0} onChange={() => props.onChoices({ overwrite: true, targetId: props.targets[0]?.id })} />{t('assetImport.existing')}</label>
            {choices.overwrite && <div>{t('assetImport.existing')}<MenuSelect value={choices.targetId ?? ''} ariaLabel={t('assetImport.existing')} disabled={busy} onChange={(targetId) => props.onChoices({ targetId })} options={props.targets.map((target) => ({ value: target.id, label: `${target.name} · ${target.id}` }))} /></div>}
          </fieldset>
          <p>{t(choices.overwrite ? props.destination === 'character' ? 'assetImport.characterReplace' : 'assetImport.presetReplace' : 'assetImport.newHint')}</p>
          <details><summary>{t('assetImport.files', { count: summary.files.length })}</summary><ul className={css.files}>{summary.files.map((file) => <li key={file.path}><span>{file.path}</span><span>{file.bytes} B · {t(choices.overwrite ? 'assetImport.replace' : 'assetImport.add')}</span></li>)}</ul></details>
          {summary.warnings.length > 0 && <details open><summary>{t('assetImport.warnings')}</summary><ul>{summary.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}
        </>}
        {(preview !== undefined || props.candidates !== undefined) && <ImportPreviewCard t={t} preview={preview === undefined ? undefined : { ...preview, groupCharacterId: choices.promptOrderCharacterId ?? preview.groupCharacterId }} candidates={props.candidates} busy={busy} hideActions onGroupChange={(characterId) => props.onChoices({ promptOrderCharacterId: characterId })} onConfirm={props.onConfirm} onCancel={close} />}
        {!ready && phase === 'confirming' && <p role="status">{t('assetImport.chooseFirst')}</p>}
      </>}
    </div>
  </DialogSurface>
}
