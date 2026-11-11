import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { ModuleMergeSnapshot } from '../../../shared/bridge-contract.ts'
import { readPublication } from '../../../shared/publication.ts'
import type { DraftsPort, ModuleActionsPort, ModuleFactsPort } from '../../data/store-ports.ts'
import { poolDirty } from '../../data/workspace-drafts.ts'
import { errorMessage } from '../../data/bridge-client.ts'
import type { PromptToolTranslate } from '../../locales.ts'
import { Button } from '../../ui/Button.tsx'
import { DialogSurface } from '../../ui/DialogSurface.tsx'
import { MenuSelect } from '../../ui/MenuSelect.tsx'
import { PublicationNotice, type PublicationView } from '../../ui/PublicationNotice.tsx'
import shared from '../../ui/controls.module.css'

export function ModuleMergeDialog(props: { store: ModuleActionsPort & ModuleFactsPort & DraftsPort; t: PromptToolTranslate; onClose: () => void }): ReactNode {
  const { store, t } = props
  const modules = store.meta.modules ?? []
  const [targetId, setTargetId] = useState('')
  const [sourceId, setSourceId] = useState('')
  const [action, setAction] = useState<'merge' | 'remove'>('merge')
  const [sources, setSources] = useState<string[]>([])
  const [preview, setPreview] = useState<ModuleMergeSnapshot>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)
  const [publication, setPublication] = useState<PublicationView>()
  const pending = useRef(false)
  const version = useRef(0)
  const confirmed = useRef<ModuleMergeSnapshot>()
  useEffect(() => {
    const sequence = ++version.current
    if (!targetId) return
    setBusy(true)
    void store.moduleActions.readMergeSources(targetId).then(result => {
      if (sequence !== version.current) return
      if (result.ok) setSources(result.value.sources)
      else setError(result.message ?? t('card.operationFailed'))
      setBusy(false)
    }).catch(reason => { if (sequence === version.current) { setError(errorMessage(reason)); setBusy(false) } })
    return () => { version.current += 1 }
  }, [targetId, store.moduleActions, t])
  const invalidate = (): void => { version.current += 1; confirmed.current = undefined; setPreview(undefined); setError(''); setDone(false); setPublication(undefined) }
  const guardDrafts = (): void => {
    if (store.dirtySwitches || poolDirty(store.editorDrafts, targetId) || (sourceId && poolDirty(store.editorDrafts, sourceId))) throw new Error(t('assetImport.draftBlocked'))
  }
  const run = async (confirm = false, retry = false): Promise<void> => {
    if (pending.current || !targetId || (!retry && !sourceId)) return
    const selected = confirmed.current
    if (confirm && (!selected?.revision || selected.targetId !== targetId || selected.sourceId !== sourceId || selected.action !== action)) return
    pending.current = true; setBusy(true); setError('')
    const sequence = ++version.current
    try {
      if (!retry) guardDrafts()
      const result = retry ? await store.moduleActions.retryMerge(targetId)
        : confirm ? await store.moduleActions.merge(targetId, { sourceId, action, expectedRevision: selected!.revision })
          : await store.moduleActions.previewMerge(targetId, sourceId, action)
      if (sequence !== version.current) return
      if (!result.ok) throw new Error(result.message ?? t('card.operationFailed'))
      setSources(result.value.sources)
      if (!confirm && !retry) { confirmed.current = result.value; setPreview(result.value); return }
      confirmed.current = undefined; setPreview(undefined); setDone(true)
      setPublication(readPublication(result.value))
      if ('refreshError' in result && result.refreshError) setError(t('moduleSwitcher.notice.refreshFailed'))
    } catch (reason) {
      if (sequence === version.current) { confirmed.current = undefined; setPreview(undefined); setError(errorMessage(reason)) }
    } finally { pending.current = false; if (sequence === version.current) setBusy(false) }
  }
  const chooseAction = (value: 'merge' | 'remove'): void => { invalidate(); setAction(value); setSourceId('') }
  const options = (action === 'merge' ? modules.filter(module => module.id !== targetId && module.renderable !== false).map(module => ({ value: module.id, label: `${module.name} · ${module.id}` }))
    : sources.map(id => ({ value: id, label: modules.find(module => module.id === id)?.name ? `${modules.find(module => module.id === id)!.name} · ${id}` : id })))
  return <DialogSurface title={t('moduleMerge.title')} closeLabel={t('moduleMerge.close')} description={t('moduleMerge.boundary')}
    onClose={() => { if (!pending.current) props.onClose() }} footer={<>
      <Button shape="pill" variant="outline" size="md" disabled={busy} onClick={props.onClose}>{t(done ? 'assetImport.done' : 'assetImport.cancel')}</Button>
      {!done && <Button shape="pill" variant="primary" size="md" disabled={busy || !targetId || !sourceId} onClick={() => void run(preview !== undefined)}>{t(preview ? 'moduleMerge.confirm' : 'moduleMerge.preview')}</Button>}
    </>}>
    <div className={shared.exportContent} aria-busy={busy}>
      <label>{t('moduleMerge.target')}<MenuSelect value={targetId} options={modules.filter(module => module.user && module.renderable !== false).map(module => ({ value: module.id, label: `${module.name} · ${module.id}` }))}
        ariaLabel={t('moduleMerge.target')} placeholder={t('moduleMerge.choose')} disabled={busy || done} onChange={id => { invalidate(); setSources([]); setSourceId(''); setTargetId(id) }} /></label>
      <div className={shared.inlineControls}>
        <Button shape="pill" variant={action === 'merge' ? 'primary' : 'outline'} size="sm" disabled={busy || done} aria-pressed={action === 'merge'} onClick={() => chooseAction('merge')}>{t('moduleMerge.merge')}</Button>
        <Button shape="pill" variant={action === 'remove' ? 'primary' : 'outline'} size="sm" disabled={busy || done} aria-pressed={action === 'remove'} onClick={() => chooseAction('remove')}>{t('moduleMerge.remove')}</Button>
      </div>
      <label>{t('moduleMerge.source')}<MenuSelect value={sourceId} options={options} ariaLabel={t('moduleMerge.source')} placeholder={t('moduleMerge.choose')} disabled={busy || done || !targetId} onChange={id => { invalidate(); setSourceId(id) }} /></label>
      {busy && <p role="status">{t('assetImport.reading')}</p>}
      {error && <p role="alert" className={shared.confirmError}>{error}</p>}
      {preview && <div role="status"><p>{targetId} ← {sourceId}</p><p>{t('moduleMerge.rules', { ids: preview.rules.join(', ') || '—' })}</p><p>{t('moduleMerge.files', { ids: preview.files.join(', ') || '—' })}</p>{!preview.changed && <p>{t('moduleMerge.empty')}</p>}</div>}
      {done && <p role="status">{t('moduleMerge.saved')}</p>}
      <PublicationNotice publication={publication} pendingLabel={t('publication.pending')} retryLabel={t('publication.retry')} disabled={busy} onRetry={() => void run(false, true)} />
    </div>
  </DialogSurface>
}
