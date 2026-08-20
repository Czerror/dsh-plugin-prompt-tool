/** 客户端共享类型：提示词配置草稿、层能力矩阵与引擎 /meta 载荷。 */

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
  presets?: Array<{ id: string; name: string }>
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
