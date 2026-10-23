/** settings bridge 的底层 HTTP/文件传输与统一结果解析。 */
import {
  EDIT_TARGET_HEADER,
  SETTINGS_BRIDGE_PREFIX,
  type BridgeErrorPayload,
} from '../../shared/bridge-contract.ts'

export type { BridgeSettingsView } from '../../shared/bridge-contract.ts'

/**
 * 一次 bridge 调用的结果。`T` 是 `value` 字段的形状；`E` 是该端点的**顶层附加字段**
 * （契约里的 `BridgeExtrasOf<K>`），**缺省为空**——transport 不认识端点，形状由调用方
 * （`bridgeCall`）按端点填进来；它自己只判 `ok` 与 `value` 存在与否。
 */
export type BridgeResult<T, E = unknown> = ({ ok: true; value: T } & E) | BridgeErrorPayload

export const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error)

const isBridgeResultPayload = (payload: unknown): payload is BridgeResult<unknown> => {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return false
  const record = payload as Record<string, unknown>
  if (typeof record.ok !== 'boolean') return false
  return !record.ok || 'value' in record
}

/**
 * 宿主尚未就绪或路由未注册时，HTTP 层可能返回空体/非 JSON 响应；
 * 统一转成可诊断的桥接错误，不把原生 response.json() 异常透传给 UI。
 */
async function readBridgeResponse<T, E = unknown>(response: Response): Promise<BridgeResult<T, E>> {
  const text = await response.text()
  if (text.trim().length === 0) {
    return { ok: false, message: `桥接接口返回空响应（HTTP ${response.status}）` }
  }
  let payload: unknown
  try {
    payload = JSON.parse(text) as unknown
  } catch {
    const preview = text.trim().replace(/\s+/g, ' ').slice(0, 80)
    return { ok: false, message: `桥接接口返回非 JSON 响应（HTTP ${response.status}：${preview}）` }
  }
  if (isBridgeResultPayload(payload)) return payload as BridgeResult<T, E>
  return { ok: false, message: `invalid settings bridge payload (HTTP ${response.status})` }
}

/**
 * 主语只在调用实参里携带：`subject` 是模块 id（模块目录名），模块 id 唯一（复制必带 `-copy`
 * 后缀），加上卡自身的 id 就唯一确定一张配置卡。没有会话级目标，未传即不带该头。
 */
export async function postBridge<T, E = unknown>(path: string, body: unknown, subject?: string): Promise<BridgeResult<T, E>> {
  try {
    const response = await fetch(SETTINGS_BRIDGE_PREFIX + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(subject === undefined ? {} : { [EDIT_TARGET_HEADER]: subject }) },
      body: JSON.stringify(body ?? {}),
    })
    return await readBridgeResponse<T, E>(response)
  } catch (error) {
    return { ok: false, message: errorMessage(error) }
  }
}

/** 原始文件流上传；用于避开 JSON/base64 的额外膨胀。 */
export async function uploadBridge<T, E = unknown>(path: string, file: Blob, fileName: string): Promise<BridgeResult<T, E>> {
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
