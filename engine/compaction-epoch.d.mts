/** `compaction-epoch.mjs` 的手写声明：只声明 `src/` 消费的导出。 */

/** epoch 感知的晋升相位追踪器；仅覆盖插件依赖面（宿主只把它交给 pre-step 批执行）。 */
export interface PromotionTracker {
  /**
   * 该 agent 当前相位；`boundary` 是最后一次成功压缩的 seq（压缩前为 -1），
   * `promoted` 表示该边界之后存在 durable 晋升信号。
   */
  status(agent?: unknown): { boundary: number; promoted: boolean }
  /** 增量喂入 `session/event`。 */
  observe(session: unknown, event: unknown): void
}

export interface EpochPromotionOptions {
  includeSubagents?: boolean
  promoteGate?: boolean
  promoteAfterFirstResponse?: boolean
  maxPromoteSteps?: number
  reasoningPattern?: string
  reasoningNegativePattern?: string
  reasoningFlags?: string
}

/** 建一份相位追踪器；`promoteEvents` 是 durable 事件类型集合（见 `shared.mjs#PROMOTE_EVENTS`）。 */
export function createEpochPromotion(promoteEvents: Iterable<string>, options?: EpochPromotionOptions): PromotionTracker
export function isSuccessfulCompactionEnd(event: unknown): boolean
