/** `pre-step-source.mjs` 的手写声明：来源形状与批合并的唯一权威。 */
import type { PromotionTracker } from './compaction-epoch.mjs'

/** pre-step 条目；只声明调度/批执行读取的字段。 */
export interface PreStepConfigLike {
  id: string
  layer?: string
  position?: string
  promotion?: string
  audience?: string | null
  modelScope?: string
  dedupe?: string
  texts?: string[]
  params?: Record<string, unknown>
  variables?: Record<string, unknown>
  sequence?: number
  order?: number
  sourceModuleId?: string
  /** 规则实例；批执行器据此把判定上报分给来源。 */
  rule?: unknown
  /** 由来源生产者绑定 ctx 的逐条求值事务。 */
  resolve?(input: Record<string, unknown>): unknown
}

/** 来源侧判定上报；moduleId 等归属由 source 自己闭包，不在此重复。 */
export interface PreStepOutcomeReport {
  ruleId: string
  channel: string
  outcome: string
}

export type PreStepOutcomeSink = (report: PreStepOutcomeReport) => void

/** 执行 owner 唯一持有的晋升实例对；source 只携带同一引用。 */
export interface PreStepPromotion {
  main: PromotionTracker
  withSubagents: PromotionTracker
}

/** 一次 pre-step 注册；ctx/onOutcome/promotion 都是来源事实。 */
export interface PreStepSource {
  sourceId: string
  configs: readonly PreStepConfigLike[]
  ruleActions?: readonly unknown[]
  ctx: unknown
  onOutcome?: PreStepOutcomeSink
  promotion?: PreStepPromotion
}

export interface CreatePreStepSourceOptions {
  sourceId: string
  configs: readonly PreStepConfigLike[]
  ruleActions?: readonly unknown[]
  ctx: unknown
  onOutcome?: PreStepOutcomeSink
  promotion?: PreStepPromotion
}

/** 批执行所需的扁平事实；report 是三参内部适配器（来源 onOutcome 是对象 sink）。 */
export interface ComposedPreStepSources {
  configs: PreStepConfigLike[]
  ruleActions: unknown[]
  promotion?: PreStepPromotion
  report?: (rule: { id: string }, channel: string, outcome: string) => void
}

export function createPreStepSource(options: CreatePreStepSourceOptions): PreStepSource
export function promotionOwnerOf(sources: ReadonlyArray<PreStepSource>): PreStepPromotion | undefined
export function composePreStepSources(sources: ReadonlyArray<PreStepSource>): ComposedPreStepSources
