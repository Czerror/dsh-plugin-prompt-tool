/**
 * 当前会话 id 来源。
 *
 * alpha.2 起官方把「当前选中会话」移出 Session Controller：`ISessions` 的注释
 * 明示 `navigation belongs to view owners`，`SessionListState.current` 已被删除，
 * `UiWorkspaceService.selection` 与 `UiSession.current` 均为 private，
 * `useSessions` 返回的 `SessionListState` 也不含 current。
 *
 * 唯一公开的读取路径是 ui-session 的 `SlotScopeAdapter`：`adapter.current` 给出
 * 当前会话作用域绑定，非 root 绑定自带作用域 ctx，经 `sessions.scopeOf` 反查
 * 得到 session id；绑定的 `key` 是作用域身份，作为兜底。
 *
 * 依赖以结构类型声明（只描述实际用到的成员），便于 node:test 以纯 mock 做
 * 确定性回归；同时让官方删除字段时类型检查能够报错，而不是静默降级。
 */

/** sessions 服务的使用子集：从作用域 ctx 反查会话 id。 */
export interface SessionIdSessionsLike {
  /** 接受任意对象形态的作用域 ctx；官方签名为 `(ctx: Context)`，参数更宽即兼容。 */
  scopeOf(ctx: object): string | undefined
}

/** 作用域绑定：kv 身份 + 可选的作用域 ctx。 */
export interface ScopeBindingLike {
  readonly key?: string | undefined
  readonly ctx?: unknown
}

/** ui-session 适配器的结构面：当前作用域绑定快照与变化通知。 */
export interface SessionIdAdapterLike {
  readonly current: {
    getSnapshot(): ScopeBindingLike
    subscribe(listener: () => void): () => void
  }
}

/**
 * 读当前会话 id。
 *
 * @param adapter - ui-session 的 `ctx.uiSession.adapter`。
 * @param sessions - `ctx.sessions`。
 * @returns 当前会话 id；无选中会话、root 绑定或 key 为空时返回 undefined。
 */
export function readCurrentSessionId(adapter: SessionIdAdapterLike, sessions: SessionIdSessionsLike): string | undefined {
  const binding = adapter.current.getSnapshot()
  const scopeCtx = binding.ctx
  if (typeof scopeCtx === 'object' && scopeCtx !== null) {
    const viaScope = sessions.scopeOf(scopeCtx)
    if (viaScope !== undefined && viaScope.length > 0) return viaScope
  }
  const key = binding.key
  return key === undefined || key.length === 0 ? undefined : key
}

/**
 * 订阅当前会话 id 的变化。
 *
 * 作用域绑定要等主视图 retain 该会话之后才有值（官方 `publishMain` 以
 * `retainedBy.mainView > 0` 为准），所以它晚于工作台首次打开——这是必须在
 * id 就绪时补一次加载的原因。只在 id **实际变化**时通知：绑定对象换引用
 * 不算变化，否则会空转重载。
 *
 * @param adapter - ui-session 的 `ctx.uiSession.adapter`。
 * @param sessions - `ctx.sessions`。
 * @param onChange - id 实际变化时回调（无参，调用方自行读取当前值）。
 * @returns 退订函数。
 */
export function subscribeSessionIdChange(
  adapter: SessionIdAdapterLike,
  sessions: SessionIdSessionsLike,
  onChange: () => void,
): () => void {
  let last = readCurrentSessionId(adapter, sessions)
  return adapter.current.subscribe(() => {
    const next = readCurrentSessionId(adapter, sessions)
    if (next === last) return
    last = next
    onChange()
  })
}
