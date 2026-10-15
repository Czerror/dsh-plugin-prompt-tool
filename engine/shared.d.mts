/** `shared.mjs` 的手写声明：只声明 `src/` 消费的导出。 */

/** 会话对象的结构化最小形状：引擎只读 `header.delegationDepth` 判主子身份。 */
export interface SessionLike {
  header?: { delegationDepth?: number } | null
}

/** 主子身份判据：`delegationDepth > 0` 即子代理。 */
export function isDelegated(session: SessionLike | null | undefined): boolean

/** 视为晋升信号的 durable 会话事件类型，按 `promoteOn` 词表分档。 */
export const PROMOTE_EVENTS: {
  'tool-call': string[]
  'assistant-message': string[]
  either: string[]
}

/** 按消息去重的有界告警出口。 */
export type WarnOnce = (message: string, key?: string) => void

export function createWarnOnce(ctx: { logger?: { warn(message: string): void } } | undefined, pluginName: string): WarnOnce
