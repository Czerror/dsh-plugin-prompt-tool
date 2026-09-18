/** 载体和解码后的资源集合使用同一上限。 */
export const MAX_ASSET_BYTES = 64 * 1024 * 1024
export const MAX_ASSET_FILES = 2048

/** 资产传输使用显式编码；省略编码仅兼容旧文本请求。 */
export interface AssetFile {
  path: string
  content: string
  encoding?: 'utf8' | 'base64'
}

export type ImportKind = 'native-preset' | 'native-character' | 'st-preset' | 'st-character' | 'world-book'
export interface ImportChoices {
  targetId?: string
  targetName?: string
  overwrite?: boolean
  sourceKind?: ImportKind
  promptOrderCharacterId?: string
}

export interface AssetSummary {
  sourceName: string
  kind: ImportKind
  targetId: string
  targetName: string
  exists: boolean
  files: Array<{ path: string; bytes: number }>
  configCount: number
  warnings: string[]
}

export interface AssetImportRequest extends ImportChoices {
  files?: AssetFile[]
  sourceId?: string
  preview?: boolean
  expectedSourceDigest?: string
  expectedPreviewRevision?: string
}

export interface PresetExportRequest {
  id: string
  mode?: 'definition' | 'zip'
  preview?: boolean
  expectedRevision?: string
  memoryChoices?: Record<string, 'include' | 'exclude'>
}

export interface PresetExportResult {
  id: string
  name: string
  content: string
  encoding?: 'utf8' | 'base64'
  filename?: string
  revision?: string
  files?: Array<{ path: string; bytes: number }>
  warnings?: string[]
  blockers?: string[]
  memoryConflicts?: Array<{ id: string; name: string }>
  excludedMemoryCount?: number
}
