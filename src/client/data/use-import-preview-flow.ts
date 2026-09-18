/** 有界导入队列：读取、暂存、预览和提交共享生命周期；结束与跳过明确分开。 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { StConversionReport, StOrderGroupCandidate } from '../../shared/bridge-contract.ts'
import { MAX_BRIDGE_BODY_BYTES } from '../../shared/bridge-contract.ts'
import type { AssetFile, AssetImportRequest, AssetSummary, ImportChoices, ImportKind } from '../../shared/asset-transfer.ts'
import type { ImportOrderCandidates, ImportPreviewState } from '../prompt-tool-types.ts'
import { bridgeCall, bridgeUpload, errorMessage } from './bridge-client.ts'
import { readImportFiles } from './import-files.ts'

export type ImportFlowPhase = 'idle' | 'reading' | 'confirming' | 'submitting' | 'stale' | 'error' | 'complete'
export type ImportPreviewOutcome =
  | { kind: 'ready'; sourceDigest?: string; previewRevision?: string; report?: StConversionReport; summary?: AssetSummary }
  | { kind: 'candidates'; candidates: StOrderGroupCandidate[]; sourceName?: string }
  | { kind: 'kinds'; kinds: ImportKind[] }
  | { kind: 'error'; message: string; stale?: boolean }
export interface ImportCommitResult { ok: boolean; stale?: boolean; message?: string; label?: string; refreshWarning?: string }
export interface ImportFlowHandlers {
  preview: (request: AssetImportRequest) => Promise<ImportPreviewOutcome>
  commit: (preview: ImportPreviewState) => Promise<ImportCommitResult>
  onCommitted?: (label?: string) => Promise<void> | void
  onError: (message: string, stale: boolean) => void
  directoryTooLarge: string
}
interface ImportProgress { index: number; total: number; imported: number; skipped: number; failed: number; failures: string[] }
const emptyProgress: ImportProgress = { index: 0, total: 0, imported: 0, skipped: 0, failed: 0, failures: [] }

export function useImportPreviewFlow(handlers: ImportFlowHandlers) {
  const [phase, setPhase] = useState<ImportFlowPhase>('idle')
  const [preview, setPreview] = useState<ImportPreviewState>()
  const [candidates, setCandidates] = useState<ImportOrderCandidates>()
  const [kinds, setKinds] = useState<ImportKind[]>()
  const [choices, setChoices] = useState<ImportChoices>({})
  const [error, setError] = useState('')
  const [sourceName, setSourceName] = useState('')
  const [sourceImage, setSourceImage] = useState<string>()
  const [progress, setProgress] = useState(emptyProgress)
  const [resultLabel, setResultLabel] = useState<string>()
  const [refreshError, setRefreshError] = useState('')
  const api = useRef(handlers)
  api.current = handlers
  const alive = useRef(true)
  const sequence = useRef(0)
  const locked = useRef(false)
  const submitting = useRef(false)
  const source = useRef<AssetImportRequest>()
  const units = useRef<Array<File[] | AssetFile[]>>([])
  const index = useRef(0)
  const selected = useRef<ImportChoices>({})
  const ready = useRef<ImportPreviewState>()
  const result = useRef<string>()
  const imageUrl = useRef<string>()

  const release = useCallback(() => {
    const id = source.current?.sourceId
    source.current = undefined
    if (imageUrl.current !== undefined) URL.revokeObjectURL(imageUrl.current)
    imageUrl.current = undefined
    if (id !== undefined) void bridgeCall('assetRelease', { sourceId: id })
  }, [])
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false; sequence.current += 1; release() }
  }, [release])

  const inspect = useCallback(async (): Promise<void> => {
    if (!alive.current || submitting.current) return
    const seq = ++sequence.current
    ready.current = undefined
    setPhase('reading')
    setError('')
    try {
      if (source.current === undefined) {
        const batch = units.current[index.current]
        if (batch === undefined) return
        const first = batch[0]
        if (first instanceof File) {
          if (batch.length === 1 && !first.webkitRelativePath) {
            const uploaded = await bridgeUpload(first, first.name)
            if (!uploaded.ok) throw new Error(uploaded.message)
            if (!alive.current || seq !== sequence.current) {
              void bridgeCall('assetRelease', { sourceId: uploaded.value.sourceId })
              return
            }
            source.current = { sourceId: uploaded.value.sourceId }
          } else {
            const files = batch as File[]
            if (files.reduce((total, file) => total + Math.ceil(file.size / 3) * 4 + file.webkitRelativePath.length * 6 + 128, 4096) >= MAX_BRIDGE_BODY_BYTES) throw new Error(api.current.directoryTooLarge)
            const entries = await readImportFiles(files, 'base64')
            if (!alive.current || seq !== sequence.current) return
            source.current = { files: entries }
          }
        } else source.current = { files: batch as AssetFile[] }
      }
      const request = { ...source.current, ...selected.current }
      const response = await api.current.preview(request)
      if (!alive.current || seq !== sequence.current) return
      if (response.kind === 'error') {
        setPhase(response.stale ? 'stale' : 'error')
        setError(response.message)
        api.current.onError(response.message, response.stale === true)
        return
      }
      setCandidates(response.kind === 'candidates' ? response : undefined)
      setKinds(response.kind === 'kinds' ? response.kinds : undefined)
      if (response.kind === 'ready') {
        const state: ImportPreviewState = { ...request, sourceDigest: response.sourceDigest ?? '', previewRevision: response.previewRevision, report: response.report, summary: response.summary, groupCharacterId: selected.current.promptOrderCharacterId }
        // 服务端提供默认的新身份。确认始终绑定这一份预览，不自动改成覆盖。
        selected.current = { ...selected.current, targetId: response.summary?.targetId ?? selected.current.targetId, targetName: response.summary?.targetName ?? selected.current.targetName }
        setChoices(selected.current)
        ready.current = state
        setPreview(state)
      } else setPreview(undefined)
      setPhase('confirming')
    } catch (reason) {
      if (!alive.current || seq !== sequence.current) return
      const message = errorMessage(reason)
      setError(message)
      setPhase('error')
      api.current.onError(message, false)
    }
  }, [])

  const startUnit = useCallback(async (): Promise<void> => {
    release()
    selected.current = {}
    ready.current = undefined
    setChoices({})
    setPreview(undefined)
    setCandidates(undefined)
    setKinds(undefined)
    const first = units.current[index.current]?.[0]
    setSourceName(first instanceof File ? first.name : first?.path ?? '')
    imageUrl.current = first instanceof File && (first.type === 'image/png' || /\.png$/i.test(first.name)) ? URL.createObjectURL(first) : undefined
    setSourceImage(imageUrl.current)
    setProgress((previous) => ({ ...previous, index: index.current + 1 }))
    await inspect()
  }, [inspect, release])

  const run = useCallback(async (files: File[] | AssetFile[], mode: 'package' | 'files' = 'package'): Promise<void> => {
    if (files.length === 0 || locked.current) return
    locked.current = true
    units.current = mode === 'files' ? files.map((file) => [file] as File[] | AssetFile[]) : [files]
    index.current = 0
    setProgress({ ...emptyProgress, total: units.current.length })
    setResultLabel(undefined)
    setRefreshError('')
    await startUnit()
  }, [startUnit])

  const advance = useCallback(async (): Promise<void> => {
    release()
    index.current += 1
    if (index.current < units.current.length) await startUnit()
    else {
      ready.current = undefined
      setPreview(undefined)
      setCandidates(undefined)
      setKinds(undefined)
      setError('')
      setPhase('complete')
    }
  }, [release, startUnit])

  const updateChoices = useCallback((patch: ImportChoices): void => {
    if (submitting.current) return
    selected.current = { ...selected.current, ...patch }
    setChoices(selected.current)
    void inspect()
  }, [inspect])

  const confirm = useCallback(async (): Promise<void> => {
    const state = ready.current
    if (state === undefined || submitting.current) return
    ready.current = undefined
    submitting.current = true
    setPhase('submitting')
    setError('')
    try {
      const committed = await api.current.commit(state)
      if (!alive.current) return
      if (!committed.ok) {
        setError(committed.message ?? '')
        setPhase(committed.stale ? 'stale' : 'error')
        api.current.onError(committed.message ?? '', committed.stale === true)
        return
      }
      result.current = committed.label
      setResultLabel(committed.label)
      setProgress((previous) => ({ ...previous, imported: previous.imported + 1 }))
      try {
        await api.current.onCommitted?.(committed.label)
        if (committed.refreshWarning) throw new Error(committed.refreshWarning)
      } catch (reason) {
        if (!alive.current) return
        setRefreshError(errorMessage(reason))
        const remaining = units.current.length - index.current - 1
        setProgress((previous) => ({ ...previous, skipped: previous.skipped + remaining }))
        units.current = []
        setPhase('complete')
        release()
        return
      }
      if (alive.current) { submitting.current = false; await advance() }
    } catch (reason) {
      if (!alive.current) return
      setError(errorMessage(reason))
      setPhase('error')
      api.current.onError(errorMessage(reason), false)
    } finally { submitting.current = false }
  }, [advance, release])

  const skip = useCallback((): void => {
    if (submitting.current || index.current !== progress.index - 1 || units.current.length === 0) return
    sequence.current += 1
    setProgress((previous) => ({ ...previous, skipped: previous.skipped + (error ? 0 : 1), failed: previous.failed + (error ? 1 : 0), failures: error ? [...previous.failures, `${sourceName}: ${error}`] : previous.failures }))
    void advance()
  }, [advance, error, sourceName, progress.index])
  const cancel = useCallback((): void => {
    if (submitting.current) return
    sequence.current += 1
    locked.current = false
    ready.current = undefined
    release()
    units.current = []
    setPreview(undefined)
    setCandidates(undefined)
    setKinds(undefined)
    setError('')
    setPhase('idle')
  }, [release])
  const retryRefresh = useCallback(async (): Promise<void> => {
    if (submitting.current) return
    submitting.current = true
    try { await api.current.onCommitted?.(result.current); if (alive.current) setRefreshError('') }
    catch (reason) { if (alive.current) setRefreshError(errorMessage(reason)) }
    finally { submitting.current = false }
  }, [])
  const end = useCallback((): void => {
    if (submitting.current || units.current.length === 0) return
    sequence.current += 1
    ready.current = undefined
    release()
    const remaining = units.current.length - index.current
    setProgress((previous) => ({ ...previous, skipped: previous.skipped + remaining - (error ? 1 : 0), failed: previous.failed + (error ? 1 : 0), failures: error ? [...previous.failures, `${sourceName}: ${error}`] : previous.failures }))
    units.current = []
    setPreview(undefined)
    setPhase('complete')
  }, [error, release, sourceName])
  return { phase, preview, candidates, kinds, choices, error, sourceName, sourceImage, progress, resultLabel, refreshError, run, updateChoices, chooseGroup: (characterId: string) => updateChoices({ promptOrderCharacterId: characterId }), confirm, cancel, end, skip, repreview: inspect, retryRefresh }
}
