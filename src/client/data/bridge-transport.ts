/** settings bridge 的底层 HTTP/文件传输与统一结果解析。 */
import type { EngineMeta, PromptConfigDraft } from '../prompt-tool-types.ts'
import type { HostDefaultModel, SkillCatalogEntry } from './prompt-tool-fields.ts'
import {
  MAX_BRIDGE_BODY_BYTES,
  SETTINGS_BRIDGE_PREFIX,
  type BridgeErrorPayload,
} from '../../shared/bridge-contract.ts'

interface BridgeSuccessExtras {
  providers?: string[]
  modelCatalog?: Record<string, string[]>
  activeSkillsDirs?: string[]
  skillsDirExists?: Record<string, boolean>
  skillCatalog?: SkillCatalogEntry[]
  templatePreStepCount?: number
  presetParams?: Record<string, unknown>
  hostDefaultModel?: HostDefaultModel
  meta?: { meta: EngineMeta }
  overrides?: { overrides: Record<string, unknown> }
  variables?: { variables: Record<string, string>; enabled: boolean }
  promptConfigs?: { promptConfigs: PromptConfigDraft[] }
}

export type { BridgeSettingsView } from '../../shared/bridge-contract.ts'

export type BridgeResult<T> = ({ ok: true; value: T } & BridgeSuccessExtras) | BridgeErrorPayload

export const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error)

const isBridgeResultPayload = (payload: unknown): payload is BridgeResult<unknown> => {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return false
  const record = payload as Record<string, unknown>
  if (typeof record.ok !== 'boolean') return false
  return !record.ok || 'value' in record
}

async function readBridgeResponse<T>(response: Response): Promise<BridgeResult<T>> {
  const payload = await response.json() as unknown
  if (isBridgeResultPayload(payload)) return payload as BridgeResult<T>
  return { ok: false, message: `invalid settings bridge payload (HTTP ${response.status})` }
}

export async function postBridge<T>(path: string, body: unknown): Promise<BridgeResult<T>> {
  try {
    const response = await fetch(SETTINGS_BRIDGE_PREFIX + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    })
    return await readBridgeResponse<T>(response)
  } catch (error) {
    return { ok: false, message: errorMessage(error) }
  }
}

/** 原始文件流上传；用于避开 JSON/base64 的额外膨胀。 */
export async function uploadBridge<T>(path: string, file: Blob, fileName: string): Promise<BridgeResult<T>> {
  try {
    const response = await fetch(SETTINGS_BRIDGE_PREFIX + path, {
      method: 'POST',
      headers: {
        'content-type': file.type || 'application/octet-stream',
        'x-file-name': encodeURIComponent(fileName),
      },
      body: file,
    })
    return await readBridgeResponse<T>(response)
  } catch (error) {
    return { ok: false, message: errorMessage(error) }
  }
}

/** JSON 包装字段和少量路径元数据预留 4KiB，避免临界文件刚好超限。 */
export function shouldStreamJsonFile(file: Blob): boolean {
  return file.size >= MAX_BRIDGE_BODY_BYTES - 4 * 1024
}
