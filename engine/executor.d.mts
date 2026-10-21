/** `executor.mjs` 的手写声明：只声明 `src/` 消费的导出。 */
import type { PreStepSource } from './pre-step-source.mjs'
import type { WarnOnce } from './shared.mjs'

/** `runPreStepBatch` 的入参；`decision` 原样回传，故用泛型保住宿主类型。 */
export interface PreStepBatchOptions<T> {
  /** 一次批执行的来源；ctx/onOutcome/promotion 都在来源里。 */
  sources: ReadonlyArray<PreStepSource>
  /** 批级判定 ctx；缺省取第一个 source.ctx（来源 resolve 已绑自己的 ctx）。 */
  ctx?: unknown
  agent?: unknown
  payload?: unknown
  decision: T
  /** 已确认投递身份的进程内快路径（纯缓存）。 */
  memo?: Map<string, Set<string>>
  warnOnce?: WarnOnce
  ruleFrame?: unknown
}

/** 执行一批 pre-step 注入与规则动作，返回注入后的 decision。 */
export function runPreStepBatch<T>(options: PreStepBatchOptions<T>): Promise<T>

/** 记一次宿主已接纳的注入消息（由调用方在 `session/event` 里转发）。 */
export function confirmDelivered(
  memo: Map<string, Set<string>> | null | undefined,
  session: unknown,
  event: unknown,
): void
