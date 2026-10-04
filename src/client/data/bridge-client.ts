/** 由 shared bridge contract 驱动的类型化客户端。 */
import {
  BRIDGE_ENDPOINTS,
  type BridgeRequestMap,
  type BridgeValueMap,
} from '../../shared/bridge-contract.ts'
import {
  postBridge,
  uploadBridge,
  type BridgeResult,
} from './bridge-transport.ts'

export type BridgeKey = keyof typeof BRIDGE_ENDPOINTS

export function bridgeCall<K extends BridgeKey>(
  endpoint: K,
  // 契约里 body 可省略（`models: { refresh?: boolean } | undefined`）时，调用方无需显式传 undefined。
  ...args: undefined extends BridgeRequestMap[K] ? [body?: BridgeRequestMap[K], moduleId?: string] : [body: BridgeRequestMap[K], moduleId?: string]
): Promise<BridgeResult<BridgeValueMap[K]>> {
  // moduleId 只在**单次请求**上覆盖编辑目标头：平铺视图里每张卡带自己的模块身份读写，
  // 不改全局值，免得污染其它页面的单模块路径。
  return postBridge<BridgeValueMap[K]>(BRIDGE_ENDPOINTS[endpoint], args[0], args[1])
}

export function bridgeUpload(file: Blob, fileName: string): Promise<BridgeResult<BridgeValueMap['assetUpload']>> {
  return uploadBridge<BridgeValueMap['assetUpload']>(BRIDGE_ENDPOINTS.assetUpload, file, fileName)
}

export { errorMessage, shouldStreamJsonFile } from './bridge-transport.ts'
export type { BridgeResult, BridgeSettingsView } from './bridge-transport.ts'
