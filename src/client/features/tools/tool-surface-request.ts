import type { BridgeRequestMap, BridgeValueMap } from '../../../shared/bridge-contract.ts'
import { bridgeCall, type BridgeResult } from '../../data/bridge-client.ts'

export type ToolSurfaceSource = BridgeRequestMap['toolSurface']
export type ToolSurfaceResult = BridgeResult<BridgeValueMap['toolSurface']>
export type ToolSurfaceEntry = BridgeValueMap['toolSurface']['tools'][number]

/** 每次读取独占一个生命周期；切换来源、刷新和卸载后不接收旧响应。 */
export function loadToolSurface(source: ToolSurfaceSource, accept: (result: ToolSurfaceResult) => void): () => void {
  let active = true
  if ((source.sessionId ?? source.presetId ?? '').length > 0) {
    void bridgeCall('toolSurface', source).then((result) => {
      if (active) accept(result)
    })
  }
  return () => { active = false }
}
