/**
 * 当前会话模型选择面工厂（官方 session 投影 + session.selectModel 通道）。
 *
 * 与官方 ui-model-selection（composer 模型位 / /model 弹层）同一事实源：
 * 显示 = sessions 投影 `modelSelection.next` ?? 宿主默认（调用方回退）；
 * 写入 = session.selectModel —— 宿主 session-controller 校验路由、追加
 * `model/selection` 事件，并把同一选择持久化为新会话默认（agent-default-model），
 * 因此宿主侧（composer 选择器）与本插件 UI 双向同源。
 *
 * 依赖以结构类型声明（客户端 sessions 服务与 session remote 的使用子集），
 * 便于 node:test 以纯 mock 做确定性回归。
 */

import type { SessionModelFace, SessionModelSnapshot } from './prompt-tool-types.ts'

/** 快照 Observable 的结构最小面（官方 ObservableSnapshot 同构）。 */
interface SnapshotLike<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

/** 客户端 sessions 服务的使用子集（list 快照 + binding 投影 + 子代理地址探测）。 */
export interface SessionModelSessionsLike {
  list: SnapshotLike<{ current: string | undefined }>
  binding(id: string): { session: { projections: { faceOf(key: string): SnapshotLike<unknown> } } } | undefined
  subagentAddress(id: string): unknown
}

/** session.selectModel remote 的结构面（RemoteResult 同构）。 */
export type SessionModelSelectFn = (request: {
  sessionId: string
  provider: string
  model: string
  reasoningEffort?: string
}) => Promise<{ ok: true } | { ok: false; error: { code?: string; message?: string } }>

/** 从 modelSelection 投影值提取有效选择（next；缺 provider/model 视为无会话级选择）。 */
function projectionSelection(value: unknown): SessionModelSnapshot['selection'] {
  if (value === null || typeof value !== 'object') return undefined
  const next = (value as { next?: unknown }).next
  if (next === null || next === undefined || typeof next !== 'object') return undefined
  const record = next as Record<string, unknown>
  const provider = typeof record.provider === 'string' && record.provider.length > 0 ? record.provider : undefined
  const model = typeof record.model === 'string' && record.model.length > 0 ? record.model : undefined
  if (provider === undefined || model === undefined) return undefined
  return {
    provider,
    model,
    ...(typeof record.reasoningEffort === 'string' && record.reasoningEffort.length > 0
      ? { reasoningEffort: record.reasoningEffort }
      : {}),
  }
}

/** 创建当前会话模型选择面（引用稳定快照 + 列表/投影双层订阅）。 */
export function createSessionModelFace(sessions: SessionModelSessionsLike, selectModel: SessionModelSelectFn): SessionModelFace {
  let cached: SessionModelSnapshot = { selectable: false }
  const snapshot = (): SessionModelSnapshot => {
    const sessionId = sessions.list.getSnapshot().current
    const selectable = sessionId !== undefined && sessions.subagentAddress(sessionId) === undefined
    const selection = sessionId === undefined
      ? undefined
      : projectionSelection(sessions.binding(sessionId)?.session.projections.faceOf('modelSelection').getSnapshot())
    // uSES 引用稳定：逐字段比较，值不变复用旧引用（否则每次 getSnapshot 新对象导致死循环重渲染）。
    if (cached.sessionId === sessionId && cached.selectable === selectable
      && cached.selection?.provider === selection?.provider
      && cached.selection?.model === selection?.model
      && cached.selection?.reasoningEffort === selection?.reasoningEffort) return cached
    cached = {
      ...(sessionId === undefined ? {} : { sessionId }),
      selectable,
      ...(selection === undefined ? {} : { selection }),
    }
    return cached
  }
  return {
    snapshot,
    subscribe(listener) {
      let watched: string | undefined
      let stopProjection: (() => void) | undefined
      const watchCurrent = (): void => {
        const id = sessions.list.getSnapshot().current
        if (id === watched) return
        watched = id
        stopProjection?.()
        stopProjection = undefined
        if (id !== undefined) {
          stopProjection = sessions.binding(id)?.session.projections.faceOf('modelSelection').subscribe(listener)
        }
      }
      watchCurrent()
      const stopList = sessions.list.subscribe(() => {
        watchCurrent()
        listener()
      })
      return () => {
        stopList()
        stopProjection?.()
      }
    },
    async select(selection) {
      const sessionId = sessions.list.getSnapshot().current
      if (sessionId === undefined) throw new Error('当前没有活动会话')
      const result = await selectModel({ sessionId, ...selection })
      if (!result.ok) throw new Error(`${result.error.code ?? 'session/model-unavailable'}: ${result.error.message ?? 'selectModel failed'}`)
    },
  }
}
