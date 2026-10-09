import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import type { ModuleExportResult } from '../../../shared/asset-transfer.ts'
import type { PromptToolTranslate } from '../../locales.ts'
import { bridgeCall, errorMessage } from '../../data/bridge-client.ts'
import { DialogSurface } from '../../ui/DialogSurface.tsx'
import { Button } from '../../ui/Button.tsx'
import shared from '../../ui/controls.module.css'
import css from './modules.module.css'

export function ModuleExportDialog(props: { module: { id: string; name: string }; t: PromptToolTranslate; onClose: () => void }): ReactNode {
  const { t, module } = props
  const id = useId()
  const [mode, setMode] = useState<'zip' | 'definition'>('zip')
  const [memoryChoices, setMemoryChoices] = useState<Record<string, 'include' | 'exclude'>>({})
  const [preview, setPreview] = useState<ModuleExportResult>()
  const [phase, setPhase] = useState<'reading' | 'ready' | 'downloading' | 'done' | 'error'>('reading')
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const version = useRef(0)
  const ready = useRef(false)
  const pending = useRef(false)
  const errorRef = useRef<HTMLParagraphElement>(null)
  useEffect(() => { if (error) errorRef.current?.focus() }, [error])
  useEffect(() => {
    const sequence = ++version.current
    ready.current = false
    setPhase('reading')
    setError('')
    void bridgeCall('exportModule', { id: module.id, mode, memoryChoices, preview: true }).then((response) => {
      if (sequence !== version.current) return
      if (!response.ok) { setError(response.message ?? t('card.operationFailed')); setPhase('error'); return }
      setPreview(response.value)
      setPhase('ready')
      ready.current = true
    })
    return () => { version.current += 1; ready.current = false }
  }, [module.id, mode, memoryChoices, retry, t])
  const invalidate = (): void => { ready.current = false; version.current += 1; setPhase('reading') }
  const unresolved = (preview?.memoryConflicts ?? []).some((entry) => memoryChoices[entry.id] === undefined)
  const blocked = mode === 'zip' && (preview?.blockers?.length ?? 0) > 0
  const canDownload = phase === 'ready' && !unresolved && !blocked && preview?.revision !== undefined
  const download = async (): Promise<void> => {
    if (!ready.current || !canDownload || pending.current) return
    pending.current = true
    ready.current = false
    const sequence = version.current
    setPhase('downloading')
    try {
      const response = await bridgeCall('exportModule', { id: module.id, mode, memoryChoices, expectedRevision: preview.revision })
      if (sequence !== version.current) return
      if (!response.ok) throw new Error(response.message ?? t('card.operationFailed'))
      const exported = response.value
      const bytes = exported.encoding === 'base64' ? Uint8Array.from(atob(exported.content), (char) => char.charCodeAt(0)) : exported.content
      const url = URL.createObjectURL(new Blob([bytes], { type: mode === 'zip' ? 'application/zip' : 'application/yaml' }))
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = exported.filename ?? `${module.id}.${mode === 'zip' ? 'zip' : 'module.yml'}`
      document.body.append(anchor)
      anchor.click()
      anchor.remove()
      // 宽限期远长于浏览器默认下载：桌面版走 Electron 默认下载流程（原生「另存为」
      // 对话框），用户可能长时间停留在那里；blob 数据在下载启动时已被读取，这里只是
      // 冗余保险，避免对话框尚未确认时 URL 先被回收。每次导出是一条待回收 URL。
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
      setPhase('done')
    } catch (reason) { if (sequence === version.current) { setError(errorMessage(reason)); setPhase('error') } }
    finally { pending.current = false }
  }
  const close = (): void => { if (!pending.current) props.onClose() }
  return <DialogSurface title={t('assetExport.title', { name: module.name })} closeLabel={t('assetImport.close')} onClose={close}
    footer={<>
      <Button shape="pill" variant="outline" size="md" disabled={phase === 'downloading'} onClick={close}>{t(phase === 'done' ? 'assetImport.done' : 'assetImport.cancel')}</Button>
      {phase === 'error' ? <Button shape="pill" variant="primary" size="md" onClick={() => setRetry((value) => value + 1)}>{t('assetExport.preview')}</Button>
        : phase !== 'done' && <Button shape="pill" variant="primary" size="md" disabled={!canDownload} onClick={() => { void download() }}>{t(mode === 'zip' ? 'assetExport.downloadZip' : 'assetExport.downloadYaml')}</Button>}
    </>}>
    <div className={css.exportContent}>
      <p><code>{module.id}</code></p>
      <fieldset disabled={phase === 'downloading'}>
        <legend>{t('assetExport.scope')}</legend>
        {(['zip', 'definition'] as const).map((option) => <label key={option} className={css.exportOption}>
          <input type="radio" name={`${id}-mode`} checked={mode === option} onChange={() => { invalidate(); setMode(option) }} />
          <span><strong>{t(`assetExport.${option}`)}</strong><small>{t(`assetExport.${option}Hint`)}</small></span>
        </label>)}
      </fieldset>
      {(phase === 'reading' || phase === 'downloading') && <p role="status">{t('assetImport.reading')}</p>}
      {error && <p ref={errorRef} tabIndex={-1} role="alert" className={shared.confirmError}>{error}</p>}
      {phase === 'done' && <p role="status">{t('assetExport.downloaded')}</p>}
      {preview && <>
        {(preview.memoryConflicts?.length ?? 0) > 0 && <fieldset disabled={phase === 'downloading'}>
          <legend>{t('assetExport.conflicts')}</legend>
          {preview.memoryConflicts!.map((entry) => <div key={entry.id}>
            <strong>{entry.name} · {entry.id}</strong>
            {(['include', 'exclude'] as const).map((choice) => <label className={css.exportOption} key={choice}><input type="radio" name={`${id}-${entry.id}`} checked={memoryChoices[entry.id] === choice}
              onChange={() => { invalidate(); setMemoryChoices((current) => ({ ...current, [entry.id]: choice })) }} />{t(`assetExport.${choice}`)}</label>)}
          </div>)}
        </fieldset>}
        {Object.values(memoryChoices).includes('include') && <p>{t('assetExport.included')}</p>}
        <details><summary>{t('assetImport.files', { count: preview.files?.length ?? 0 })}</summary><ul>{preview.files?.map((file) => <li key={file.path}>{file.path} · {file.bytes} B</li>)}</ul></details>
        <p>{t('assetExport.excluded', { count: preview.excludedMemoryCount ?? 0 })}</p>
        <p>{t('assetExport.boundary')}</p>
        {(preview.blockers?.length ?? 0) > 0 && <div role={blocked ? 'alert' : undefined}>{blocked && <p>{t('assetExport.blocked')}</p>}<ul>{preview.blockers!.map((item, index) => <li key={index}>{item}</li>)}</ul></div>}
        {(preview.warnings?.length ?? 0) > 0 && <details open><summary>{t('assetImport.warnings')}</summary><ul>{preview.warnings!.map((item, index) => <li key={index}>{item}</li>)}</ul></details>}
      </>}
    </div>
  </DialogSurface>
}
