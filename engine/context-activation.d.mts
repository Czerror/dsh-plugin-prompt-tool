/** 上下文激活诊断的只读类型声明。 */
export interface ContextActivationDiagnosticsSnapshot {
  records: Array<{ id: string; stage: string; reason: string; [key: string]: unknown }>
  truncated: boolean
  step: number
  /** false = 该会话尚未求值；true = 已求值（records 为空表示本次没有参与/入选条目）。 */
  evaluated: boolean
}
export function lastContextActivationDiagnostics(session: unknown): ContextActivationDiagnosticsSnapshot
export function selectContextActivation(...args: unknown[]): Set<Record<string, unknown>> & { diagnostics?: { records: unknown[]; truncated: boolean } }
export function conversationMessages(session: unknown, pending?: unknown[]): Array<{ id: unknown; role: string; text: string }>
