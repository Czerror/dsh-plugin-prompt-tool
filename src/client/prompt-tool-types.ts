/** 客户端共享类型：提示词配置草稿、层能力矩阵与引擎 /meta 载荷。 */

/** 当前会话模型选择快照（uSES 兼容：引用稳定，值不变不换新引用）。 */
export interface SessionModelSnapshot {
  /** 当前会话 id；无活动会话时 undefined。 */
  sessionId?: string
  /** 是否可经官方 selectModel 切换（子代理会话 = false）。 */
  selectable: boolean
  /** 会话级有效选择（投影 next）；无投影时 undefined，调用方回退宿主默认。 */
  selection?: { provider?: string; model?: string; reasoningEffort?: string }
}

/** 当前会话模型选择面：订阅 + 快照 + 官方 session.selectModel 写入通道。 */
export interface SessionModelFace {
  /** 订阅会话切换与 modelSelection 投影帧（宿主侧切换实时回流）。 */
  subscribe(listener: () => void): () => void
  /** 当前快照：显示 = 投影 next ?? 宿主默认（调用方回退）。 */
  snapshot(): SessionModelSnapshot
  /** 官方 session.selectModel：对当前会话生效，宿主侧同时保存为新会话默认。 */
  select(selection: { provider: string; model: string; reasoningEffort?: string }): Promise<void>
}

/** alpha.1 @Remote 客户端的最小宿主能力面：替代已删除的 IApiClient。 */
export interface PromptToolHostApi {
  /** 官方 uiWorkspace 目录选择；取消时返回 null。 */
  pickDirectory(): Promise<string | null>
  /** 官方 session remote 打开 Host 桌面路径。 */
  openPath(path: string): Promise<void>
  /** 当前会话模型选择面（官方 session 投影 + selectModel 通道）。 */
  sessionModel: SessionModelFace
  /**
   * 官方 agentPresets.select：空会话立即换到目标预设。
   * 官方拒绝（例如会话已有 turn）时返回原因，调用方继续更新默认值。
   */
  switchPreset(id: string): Promise<PromptToolPresetSwitchResult>
  /** 官方 sessions snapshot 中当前会话 id；只读且不持久化。 */
  currentSessionId(): string | undefined
}

/** 官方 preset 切换结果。 */
export interface PromptToolPresetSwitchResult {
  /** true = 当前空会话已按官方 API 重组。 */
  applied: boolean
  /** 官方拒绝原因；applied=false 且无 message = 当前没有可切换的会话。 */
  message?: string
}

/** 客户端侧的提示词配置草稿：与宿主 PromptConfigSpec 同构，字段全部宽松。 */
export interface PromptConfigDraft {
  id: string
  name?: string
  enabled?: boolean
  layer?: string
  strategy?: string
  position?: string
  dedupe?: string
  promotion?: string
  /** 消息受众：缺省/null = 公用；main=仅主会话；subagent=仅子代理。 */
  audience?: string | null
  modelScope?: string
  configKind?: string
  order?: number
  role?: string
  group?: string
  exclusive?: boolean
  mergeMode?: string
  sourceKind?: string
  form?: string
  summary?: string
  text?: string
  texts?: string[]
  templateFile?: string
  fill?: string
  variables?: Record<string, string>
  params?: Record<string, unknown>
  identity?: { field: string; value: string }
}

/** 包内内置模板条目：文件 + 原文 + 解析后的单条配置（与生成目录 prompt-configs/*.yml 同构）。 */
export interface PromptConfigTemplateEntry {
  file: string
  content: string
  spec: PromptConfigDraft
}

/** 每个注入层可用的字段开关。 */
export interface LayerFieldPolicy {
  position: boolean
  dedupe: boolean
  promotion: boolean
  audience: boolean
  modelScope: boolean
  merge: boolean
  order: boolean
  role: boolean
  placeholder: boolean
}

/** settings bridge /meta 返回的引擎能力矩阵。 */
export interface EngineMeta {
  /** 可用预设模板清单（UI 预设切换器）。 */
  presets?: Array<{ id: string; name: string; user?: boolean; renderable?: boolean; description?: string; meta?: Record<string, unknown> }>
  /** 插件目录内置模板清单（「新建预设」选择器数据源）。 */
  builtinTemplates?: Array<{ id: string; name: string }>
  layers: string[]
  strategies: string[]
  slotKinds: string[]
  positions: string[]
  dedupes: string[]
  promotions: string[]
  audienceModes: string[]
  modelScopes: string[]
  roles: string[]
  mergeModes: string[]
  fills: string[]
  layerFieldPolicies: Record<string, LayerFieldPolicy>
  layerLabels: Record<string, { title: string; detail: string }>
}

/** 配置校验错误条目（编辑器导入失败展示与列表校验共用）。 */
export interface ValidationErrorEntry {
  index: number
  id: string
  message: string
}
