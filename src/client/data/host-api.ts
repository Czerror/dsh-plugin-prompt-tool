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
  /** 选择宿主机目录并返回绝对路径；取消时返回 null。 */
  pickDirectory(): Promise<string | null>
  openPath(path: string): Promise<void>
  sessionModel: SessionModelFace
  switchPreset(id: string): Promise<PromptToolPresetSwitchResult>
  currentSessionId(): string | undefined
  /** 读取官方 agent-presets roster，供预设工具能力选择器使用。 */
  listAgentPresets(): Promise<Array<{ id: string; name?: string; description?: string; trust?: 'system' | 'user' }>>
}

export interface PromptToolPresetSwitchResult {
  applied: boolean
  message?: string
}
