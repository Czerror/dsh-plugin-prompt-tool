/** `rule-runtime.mjs` 的手写声明：只声明 `src/` 消费的导出。 */
import type { StandingMountFor } from './conditions/index.mjs'
import type { PromotionPool } from './promotion-pool.mjs'
import type { PreStepPromotion } from './pre-step-source.mjs'
import type { WarnOnce } from './shared.mjs'

/** 变量读写通道（插件侧的模块变量适配器）；引擎只按这三个方法调用。 */
export interface RuleVariableStore {
  read(moduleId: string): unknown
  commit(moduleId: string, request: unknown): unknown
  publish(moduleId: string): void
}

/** 清单检查事实通道（宿主读取器）；引擎只调用 read，undefined 表示不可用。 */
export interface RuleManifestCheck {
  read(moduleId: string): boolean | undefined
}

/** 判定上报载荷；仅覆盖插件依赖面（宿主按 `RuleOutcomeReport` 消费它）。 */
export interface RuleOutcomeReport {
  moduleId?: string
  ruleId: string
  channel: string
  outcome: string
}

/** 一次挂载的规则来源；规则对象是 `rule-spec.mjs#compileRules` 的产物。 */
export interface RuleSourceLike {
  moduleId: string
  rules: readonly unknown[]
}

export interface MountRuleSourcesOptions {
  agent?: unknown
  plugin?: string
  warnOnce?: WarnOnce
  variableStore?: RuleVariableStore
  /** 清单 checks 事实；缺省＝manifest 条件恒不可用。 */
  manifestCheck?: RuleManifestCheck
  /** 官方预设兜底；缺省＝没有兜底（预设条件恒不命中）。 */
  standingMountFor?: StandingMountFor
  /** 注入的晋升相位实例对；缺省从协调器或自建池取。 */
  promotion?: PreStepPromotion
  promotionPool?: PromotionPool
  onOutcome?(report: RuleOutcomeReport): void
}

/** 所有规则来源的唯一装配入口；返回 disposer。可归因挂载错误携带 sourceModuleId，原错误保留在 cause。 */
export function mountRuleSources(
  ctx: unknown,
  sources: ReadonlyArray<RuleSourceLike>,
  options?: MountRuleSourcesOptions,
): () => void
