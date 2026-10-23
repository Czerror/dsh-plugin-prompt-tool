/** 由 shared bridge contract 驱动的类型化客户端。 */
import {
  BRIDGE_ENDPOINTS,
  BRIDGE_SUBJECT_POLICY,
  type BridgeEndpointKey,
  type BridgeExtrasOf,
  type BridgeRequestMap,
  type BridgeResponse,
  type BridgeValueMap,
} from '../../shared/bridge-contract.ts'
import {
  postBridge,
  uploadBridge,
} from './bridge-transport.ts'

/** 对外名与契约保持一致，不新增第二套语义。 */
export type BridgeKey = BridgeEndpointKey

/** 主语实参三态：`required` 必填、`optional` 可省、`none` 不接受该实参。 */
type BridgeSubjectArgs<K extends BridgeKey> =
  (typeof BRIDGE_SUBJECT_POLICY)[K] extends 'required' ? [subject: string]
    : (typeof BRIDGE_SUBJECT_POLICY)[K] extends 'optional' ? [subject?: string]
      : []

/**
 * 请求实参：主语三态 × body 可选性。
 * `required` 端点的 body **必须显式给**（契约允许时值为 `undefined`）：单实参无法区分「这是 body」
 * 还是「这是主语」，把这种歧义放进公开 API 比调用方多写一个 `undefined` 更贵。
 */
type BridgeArgs<K extends BridgeKey> =
  (typeof BRIDGE_SUBJECT_POLICY)[K] extends 'required'
    ? [body: BridgeRequestMap[K], subject: string]
    : undefined extends BridgeRequestMap[K]
      ? [body?: BridgeRequestMap[K], ...BridgeSubjectArgs<K>]
      : [body: BridgeRequestMap[K], ...BridgeSubjectArgs<K>]

export function bridgeCall<K extends BridgeKey>(endpoint: K, ...args: BridgeArgs<K>): Promise<BridgeResponse<K>>
export function bridgeCall<K extends BridgeKey>(endpoint: K, ...args: [unknown?, string?]): Promise<BridgeResponse<K>> {
  const [body, subject] = args
  // 空主语＝没有主语：`required` 端点不发请求直接失败（挡住绕过类型的 JS 路径／旧 bundle）；
  // `optional`／`none` 一律省略该头——空串不是「另一个模块」，发出去只会被服务端按非法身份 400。
  const blank = typeof subject !== 'string' || subject.trim().length === 0
  if (blank && BRIDGE_SUBJECT_POLICY[endpoint] === 'required') {
    const missingSubject: BridgeResponse<K> = { ok: false, message: `端点 ${endpoint} 缺少模块主语，未发出请求` }
    return Promise.resolve(missingSubject)
  }
  // 顶层附加字段按端点填（`BridgeExtrasOf`）：transport 自己不认端点，只把它们透传上来。
  return postBridge<BridgeValueMap[K], BridgeExtrasOf<K>>(BRIDGE_ENDPOINTS[endpoint], body, blank ? undefined : subject)
}

export function bridgeUpload(file: Blob, fileName: string): Promise<BridgeResponse<'assetUpload'>> {
  return uploadBridge<BridgeValueMap['assetUpload']>(BRIDGE_ENDPOINTS.assetUpload, file, fileName)
}

export { errorMessage } from './bridge-transport.ts'
export type { BridgeResult, BridgeSettingsView } from './bridge-transport.ts'
