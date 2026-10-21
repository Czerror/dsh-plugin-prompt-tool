/**
 * 晋升相位追踪器池：同一挂载内按配置复用追踪器，事件由池**统一喂**。
 *
 * 为什么需要池：`createEpochPromotion` 自己不订阅任何事件（它的 ctx 参数完全用不到，
 * 见 `compaction-epoch.mjs` 的条目容器注释），初始相位靠 `status()` 触发的**全量冷扫**建立。
 * 此前 `executor` 每次 pre-step apply 建两份、`phase` 每个编译谓词建一份、
 * `instruction-hint` 每次 apply 建一份，各自订阅、各自喂——重复建的代价就是重复冷扫。
 *
 * **池自己订阅**：订阅随池的归属走（自建池随所在挂载释放，注入池由创建者释放），
 * 调用方不需要记住「注入时谁来喂事件」——忘了就是相位停在冷扫那一刻的静默失效。
 *
 * 状态仍按 `session.id` 分条（追踪器内部的 `sessionState`）：池只合并**实例与订阅**，
 * 不共享会话状态，也不改变「状态是快路径、真相在事件流」这条纪律。
 */
import { createEpochPromotion } from './compaction-epoch.mjs'

/**
 * 进缓存的选项键：**任何影响判定的配置都必须登记**，否则同 key 会掩盖不同行为。
 * 与 `createEpochPromotion` 读取的选项一一对应。
 */
const KEYED_OPTIONS = [
  'includeSubagents',
  'promoteGate',
  'promoteAfterFirstResponse',
  'reasoningPattern',
  'reasoningNegativePattern',
  'reasoningFlags',
  'maxPromoteSteps',
]

const trackKey = (promoteEvents, options) => JSON.stringify([
  // 追踪器内部是 `new Set(promoteEvents)`：声明顺序无判定语义，不排序会把同一配置缓存成两份。
  [...promoteEvents].sort(),
  // 固定键序，避免书写顺序造成同配置两份。
  KEYED_OPTIONS.map(key => [key, options[key]]),
])

/**
 * @param {object} ctx 归属上下文（`ctx.on` 用来订阅 `session/event`）
 * @returns {{ tracker: (promoteEvents: readonly string[], options?: object) => object, dispose: () => void }}
 */
export function createPromotionPool(ctx) {
  const trackers = new Map()
  let disposed = false
  // 喂给池内所有实例：追踪器对未 scan 的会话本身是 no-op（首次 `status()` 会全量重建），
  // 因此统一喂不会把状态喂给还没建立相位的会话。
  const release = ctx.on('session/event', (session, event) => {
    for (const tracker of trackers.values()) tracker.observe(session, event)
  })
  return {
    /** 按配置取追踪器：同配置复用、异配置分建（配置不同就是不同的相位语义）。 */
    tracker(promoteEvents, options = {}) {
      const key = trackKey(promoteEvents, options)
      let tracker = trackers.get(key)
      if (tracker === undefined) {
        tracker = createEpochPromotion(promoteEvents, options)
        trackers.set(key, tracker)
      }
      return tracker
    },
    /** 释放订阅并丢弃实例；追踪器本身没有 disposer（状态随闭包回收）。 */
    dispose() {
      if (disposed) return
      disposed = true
      trackers.clear()
      release?.()
    },
  }
}
