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
  subagents?: string
  modelScope?: string
  configKind?: string
  order?: number
  role?: string
  group?: string
  exclusive?: boolean
  priority?: number
  mergeMode?: string
  mergeGroup?: string
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

/** 每个注入层可用的字段开关。 */
export interface LayerFieldPolicy {
  position: boolean
  dedupe: boolean
  promotion: boolean
  subagents: boolean
  modelScope: boolean
  merge: boolean
  order: boolean
  priority: boolean
  role: boolean
  placeholder: boolean
}

/** settings bridge /meta 返回的引擎能力矩阵。 */
export interface EngineMeta {
  layers: string[]
  strategies: string[]
  slotKinds: string[]
  positions: string[]
  dedupes: string[]
  promotions: string[]
  subagentModes: string[]
  modelScopes: string[]
  roles: string[]
  mergeModes: string[]
  fills: string[]
  layerFieldPolicies: Record<string, LayerFieldPolicy>
  layerLabels: Record<string, { title: string; detail: string }>
}
