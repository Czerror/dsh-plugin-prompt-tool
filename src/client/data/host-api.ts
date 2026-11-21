/** 客户端使用的最小宿主能力面。 */

export interface SessionModelSnapshot {
  sessionId?: string
  selectable: boolean
  selection?: { provider?: string; model?: string; reasoningEffort?: string }
}

export interface SessionModelFace {
  subscribe(listener: () => void): () => void
  snapshot(): SessionModelSnapshot
  select(selection: { provider: string; model: string; reasoningEffort?: string }): Promise<void>
}

export interface PromptToolHostApi {
  isConnected(): boolean
  /** 选择宿主机目录并返回绝对路径；取消时返回 null。 */
  pickDirectory(): Promise<string | null>
  openPath(path: string): Promise<void>
  sessionModel: SessionModelFace
  currentSessionId(): string | undefined
  /**
   * 订阅「当前会话 id 的实际变化」，返回退订函数。
   *
   * 官方在 0.1.6-alpha.2 把当前选中会话移出 Session Controller，客户端改从
   * ui-session 的作用域绑定取值；该绑定要等主视图 retain 该会话之后才就绪
   * （官方 publishMain 以 `retainedBy.mainView > 0` 为准），因此晚于工作台首次
   * 打开。订阅它才能在 id 就绪时补一次加载，而不是等用户关掉重开。
   * 实现契约：绑定对象换引用不算变化，只有 id 取值变化才通知。
   */
  subscribeSessionChange(listener: () => void): () => void
}
