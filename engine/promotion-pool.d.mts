/** `promotion-pool.mjs` 的手写声明：池按配置复用并统一喂事件。 */
import type { PromotionTracker } from './compaction-epoch.mjs'

export interface PromotionPool {
  tracker(promoteEvents: readonly string[], options?: Record<string, unknown>): PromotionTracker
  dispose(): void
}

export function createPromotionPool(ctx: unknown): PromotionPool
