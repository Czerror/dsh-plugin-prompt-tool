/** 引擎侧 TS 类型声明（运行期实现在 st-world-book.mjs；仅 src/ 侧导入需要）。 */
export interface WorldBookDiagnosticsSnapshot {
  records: Array<{ id: string; stage: string; reason: string; [key: string]: unknown }>
  truncated: boolean
  step: number
}
export function lastWorldBookDiagnostics(session: unknown): WorldBookDiagnosticsSnapshot
export function selectStWorldBook(...args: unknown[]): Set<Record<string, unknown>> & { diagnostics?: WorldBookDiagnosticsSnapshot }
