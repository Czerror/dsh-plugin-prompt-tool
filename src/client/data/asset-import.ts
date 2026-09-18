import type { AssetImportRequest } from '../../shared/asset-transfer.ts'
import type { ImportPreviewState } from '../prompt-tool-types.ts'
import type { ImportCommitResult, ImportPreviewOutcome } from './use-import-preview-flow.ts'
import { bridgeCall } from './bridge-client.ts'

type ImportEndpoint = 'importPresetPackage' | 'charactersImport'
export async function previewAsset(endpoint: ImportEndpoint, request: AssetImportRequest): Promise<ImportPreviewOutcome> {
  const response = await bridgeCall(endpoint, { ...request, preview: true })
  if (!response.ok) return { kind: 'error', message: response.message ?? 'settings bridge unavailable' }
  const value = response.value
  if (value.state === 'needs-order-selection') return { kind: 'candidates', candidates: value.candidates ?? [], sourceName: 'sourceName' in value ? value.sourceName : undefined }
  if (value.state === 'needs-kind-selection') return { kind: 'kinds', kinds: value.kinds ?? [] }
  return { kind: 'ready', sourceDigest: value.sourceDigest, previewRevision: value.previewRevision, report: value.report, summary: value.summary }
}
export async function commitAsset(endpoint: ImportEndpoint, preview: ImportPreviewState): Promise<ImportCommitResult> {
  const { files, sourceId, targetId, targetName, overwrite, sourceKind, promptOrderCharacterId, sourceDigest, previewRevision } = preview
  const response = await bridgeCall(endpoint, { files, sourceId, targetId, targetName, overwrite, sourceKind, promptOrderCharacterId, expectedSourceDigest: sourceDigest, expectedPreviewRevision: previewRevision })
  return response.ok ? { ok: true, label: response.value.id, refreshWarning: 'refreshWarning' in response.value ? response.value.refreshWarning : undefined } : { ok: false, stale: response.code?.endsWith('preview-stale'), message: response.message ?? 'settings bridge unavailable' }
}
