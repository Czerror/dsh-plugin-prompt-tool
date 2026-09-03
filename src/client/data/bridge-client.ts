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
  ...args: BridgeRequestMap[K] extends undefined ? [] : [body: BridgeRequestMap[K]]
): Promise<BridgeResult<BridgeValueMap[K]>> {
  return postBridge<BridgeValueMap[K]>(BRIDGE_ENDPOINTS[endpoint], args[0])
}

export function bridgeUpload(file: Blob, fileName: string): Promise<BridgeResult<BridgeValueMap['charactersImportStream']>> {
  return uploadBridge<BridgeValueMap['charactersImportStream']>(BRIDGE_ENDPOINTS.charactersImportStream, file, fileName)
}

export { errorMessage, shouldStreamJsonFile } from './bridge-transport.ts'
export type { BridgeResult, BridgeSettingsView } from './bridge-transport.ts'
