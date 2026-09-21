/**
 * 当前会话预设面：读官方会话投影 `agentPreset`（该会话真正运行的预设）。
 *
 * 为什么需要它：官方「新建会话」旁的预设选择器走会话级切换
 * （`agentPresets/select`），只作用于那个空白会话，记录成 `agent-preset/selected`
 * 事件并推进 `agentPreset` 投影；宿主默认预设（`agent-presets.default`）保持不变。
 * 插件的 `presetTemplate` 镜像的是宿主默认（官方设置页改默认那条路已由宿主侧双向
 * 同步覆盖），因此不订阅这个投影就看不到官方侧的选择。
 *
 * 读取路径与官方 ui-agent-preset 的 chip 同源：会话投影值。宿主未装 agent-presets
 * 时投影不存在，按「无记录」处理，不让工作台因此报错。
 * 依赖以结构类型声明，便于 node:test 以纯 mock 做确定性回归。
 */

import type { SessionPresetFace } from './host-api.ts'

/** 快照 Observable 的结构最小面（官方 ObservableSnapshot 同构）。 */
interface SnapshotLike<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

/** 客户端 sessions 服务与当前会话来源的使用子集（与 session-model-face 同源契约）。 */
export interface SessionPresetSessionsLike {
  currentSessionId(): string | undefined
  /** 会话切换信号（作用域绑定变化）；退订后静默。 */
  subscribeCurrent(listener: () => void): () => void
  binding(id: string): { session: { projections: { faceOf(key: string): SnapshotLike<unknown> } } } | undefined
}

/** 投影值 → 预设 id：非字符串或空串表示该会话没有记录预设。 */
function presetIdOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** 创建当前会话预设面（引用稳定快照 + 当前会话/投影双层订阅）。 */
export function createSessionPresetFace(sessions: SessionPresetSessionsLike): SessionPresetFace {
  /** 投影缺失（宿主未装 agent-presets）或 face 读取失败都按「无记录」。 */
  const faceOf = (id: string): SnapshotLike<unknown> | undefined => {
    try {
      return sessions.binding(id)?.session.projections.faceOf('agentPreset')
    } catch {
      return undefined
    }
  }
  const presetOf = (id: string | undefined): string | undefined =>
    id === undefined ? undefined : presetIdOf(faceOf(id)?.getSnapshot())
  return {
    snapshot: () => presetOf(sessions.currentSessionId()),
    subscribe(listener) {
      let watched: string | undefined
      let stopProjection: (() => void) | undefined
      const watchCurrent = (): void => {
        const id = sessions.currentSessionId()
        if (id === watched) return
        watched = id
        stopProjection?.()
        stopProjection = undefined
        if (id !== undefined) stopProjection = faceOf(id)?.subscribe(listener)
      }
      watchCurrent()
      const stopList = sessions.subscribeCurrent(() => {
        watchCurrent()
        listener()
      })
      return () => {
        stopList()
        stopProjection?.()
      }
    },
  }
}
