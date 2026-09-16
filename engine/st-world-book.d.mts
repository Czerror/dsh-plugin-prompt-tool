/** 引擎侧 TS 类型声明（运行期实现在 st-world-book.mjs；仅 src/ 侧导入需要）。 */
export interface WorldBookDiagnosticsSnapshot {
  records: Array<{ id: string; stage: string; reason: string; [key: string]: unknown }>
  truncated: boolean
  step: number
  /** false = 该会话尚未求值；true = 已求值（records 为空表示本次没有参与/入选条目）。 */
  evaluated: boolean
}
export function lastWorldBookDiagnostics(session: unknown): WorldBookDiagnosticsSnapshot
export function selectStWorldBook(...args: unknown[]): Set<Record<string, unknown>> & { diagnostics?: { records: unknown[]; truncated: boolean } }
