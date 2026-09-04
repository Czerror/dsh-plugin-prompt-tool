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
  openPath(path: string): Promise<void>
  sessionModel: SessionModelFace
  switchPreset(id: string): Promise<PromptToolPresetSwitchResult>
  currentSessionId(): string | undefined
}

export interface PromptToolPresetSwitchResult {
  applied: boolean
  message?: string
}
