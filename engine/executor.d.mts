/** `executor.mjs` 的手写声明：只声明 `src/` 消费的导出。 */
import type { PromotionTracker } from './compaction-epoch.mjs'
import type { WarnOnce } from './shared.mjs'

/** 去重身份：merged 组按位置命名空间（`merged:<position>`），否则取 `identity.value`。 */
export function identityOf(config: Record<string, unknown>): string

/** pre-step 条目；仅覆盖插件依赖面（引擎按需读字段，未列出的字段不参与声明用途）。 */
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
  /** 规则实例；调度器据此反查来源模块。 */
  rule?: unknown
  /** 由调用方提供的逐条求值事务；引擎不校验其内部形状。 */
  resolve?(input: Record<string, unknown>): unknown
}

/** `runPreStepBatch` 的入参；`decision` 原样回传，故用泛型保住宿主类型。 */
export interface PreStepBatchOptions<T> {
  ctx?: unknown
  agent?: unknown
  payload?: unknown
  decision: T
  configs: ReadonlyArray<PreStepConfigLike>
  /** 已编译的规则动作条目（含 `handler`/`actionWhen`）；形状归 `rule-runtime.mjs`。 */
  ruleActions?: readonly unknown[]
  promotion: { main: PromotionTracker; withSubagents: PromotionTracker }
  /** 已确认投递身份的进程内快路径（纯缓存）。 */
  memo?: Map<string, Set<string>>
  warnOnce?: WarnOnce
  ruleFrame?: unknown
  /** 判定上报：`(rule, channel, outcome)`；dispatcher 借此做只读记账。 */
  onOutcome?(rule: { id: string }, channel: string, outcome: string): void
}

/** 执行一批 pre-step 注入与规则动作，返回注入后的 decision。 */
export function runPreStepBatch<T>(options: PreStepBatchOptions<T>): Promise<T>

/** 记一次宿主已接纳的注入消息（由调用方在 `session/event` 里转发）。 */
export function confirmDelivered(
  memo: Map<string, Set<string>> | null | undefined,
  session: unknown,
  event: unknown,
): void
