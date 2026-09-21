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

/**
 * 当前会话预设面：官方会话投影 `agentPreset`（该会话真正运行的预设）。
 *
 * 官方会话级切换（新建会话 chip → `agentPresets/select`）只改那个空白会话、
 * 不改宿主默认预设，所以插件镜像宿主默认的 `presetTemplate` 必须读这个投影才能
 * 跟随官方侧的选择。
 */
export interface SessionPresetFace {
  /** 当前会话记录的预设 id；无会话、无投影或无记录时 undefined。 */
  snapshot(): string | undefined
  /** 会话切换或该会话预设变化时通知；退订后静默。 */
  subscribe(listener: () => void): () => void
}

export interface PromptToolHostApi {
  /** 选择宿主机目录并返回绝对路径；取消时返回 null。 */
  pickDirectory(): Promise<string | null>
  openPath(path: string): Promise<void>
  sessionModel: SessionModelFace
  /** 当前会话记录的官方预设（会话级切换的事实来源）。 */
  sessionPreset: SessionPresetFace
  switchPreset(id: string): Promise<PromptToolPresetSwitchResult>
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
  /** 读取官方 agent-presets roster，供预设工具能力选择器使用。 */
  listAgentPresets(): Promise<Array<{ id: string; name?: string; description?: string; trust?: 'system' | 'user' }>>
}

export interface PromptToolPresetSwitchResult {
  applied: boolean
  message?: string
}
