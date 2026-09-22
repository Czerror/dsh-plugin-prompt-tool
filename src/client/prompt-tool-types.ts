/** 客户端共享类型：提示词配置草稿、层能力矩阵与引擎 /meta 载荷。 */
import type { EngineMetaLayerContract, PromptConfigSourceView, StConversionReport, StOrderGroupCandidate } from '../shared/bridge-contract.ts'
import type { OfficialOrdersView } from '../shared/official-orders.ts'
import type { AssetImportRequest, AssetSummary } from '../shared/asset-transfer.ts'

/**
 * 导入预览态（预设包与角色卡 JSON 共用）：文件与凭据在确认时原样回传。
 * `previewRevision` 是服务端算的版本（绑定文件、选组、转换器与目标身份），
 * 客户端不计算、只回传；凭据本身不是写入授权。
 */
export interface ImportPreviewState extends AssetImportRequest {
  sourceDigest: string
  previewRevision?: string
  report?: StConversionReport
  groupCharacterId?: string
  summary?: AssetSummary
}

/** 顺序组候选（多 prompt_order 组无法明确对应时先让用户选组，再重新预览）。 */
export interface ImportOrderCandidates {
  sourceName?: string
  candidates: StOrderGroupCandidate[]
}

/** 卡片来源：预设卡，或指向用户磁盘指令文件的文件卡（服务端生成，客户端只读）。 */
export type CardOrigin =
  | { kind: 'preset'; presetId: string }
  | { kind: 'instruction-file'; fileId: string; contextId: string | null }

/**
 * 条件判定的组合逻辑取值域：与 engine/anchor-match.mjs 的 MATCH_LOGIC 同域。
 * 下拉的取值与展示顺序表在 prompt-config-policy.ts 的 MATCH_LOGICS（同一取值域）；
 * 与引擎的逐值对拍守卫见 test/client/prompt-config-form-layout.test.mjs。
 */
export type MatchLogic = 'any' | 'all' | 'not' | 'notAny'

/**
 * 条件判定的匹配段（与引擎 match 同构，字段全部可选）：
 * 键默认按字面文本匹配（正则元字符自动转义），`/pattern/flags` 形态或 `useRegex` 才走正则；
 * 引擎要求主键与副键至少有一个非空，`logic` 缺省 any。
 */
export interface PromptConfigMatch {
  keys: string[]
  secondaryKeys?: string[]
  logic?: MatchLogic
  caseSensitive?: boolean
  wholeWords?: boolean
  useRegex?: boolean
}

/** 客户端侧的提示词配置草稿：与宿主 PromptConfigSpec 同构，字段全部宽松。 */
export interface PromptConfigDraft extends PromptConfigSourceView {
  id: string
  name?: string
  enabled?: boolean
  layer?: string
  /** 条件判定的匹配对象（缺省由层决定）；仅条件层可写，其余层声明即引擎报错。 */
  subject?: string
  /** 条件判定的匹配段；缺省 = 无条件命中。仅条件层可写。 */
  match?: PromptConfigMatch
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
  /** 视图元数据：来源归属；不写进 preset.yml，也不参与预设序列化。 */
  origin?: CardOrigin
  /** 视图元数据：指令文件读取状态（ready 之外不可编辑、不可保存）。 */
  contentStatus?: 'ready' | 'missing' | 'unreadable' | 'too-large'
  /** 视图元数据：读取失败或保存失败的诊断信息。 */
  contentMessage?: string
  /** 视图元数据：正文相对基线已改动（文件卡）。 */
  contentDirty?: boolean
  /** 视图元数据：外部编辑造成版本冲突，必须先重新读取。 */
  contentConflict?: boolean
  /** 视图元数据：该会话装配仍由官方指令行负责，独立来源本次不注入正文。 */
  contentOwnerConflict?: boolean
  /** 视图元数据：该文件正在保存。 */
  contentSaving?: boolean
}

/** 包内内置模板条目：文件 + 原文 + 解析后的单条配置（与生成目录 prompt-configs/*.yml 同构）。 */
export interface PromptConfigTemplateEntry {
  file: string
  content: string
  spec: PromptConfigDraft
}

/**
 * 层字段能力矩阵（11 项）的**唯一常量表**：{@link LayerFieldPolicy} 与
 * prompt-config-policy.ts 的 EMPTY_POLICY 都从本表派生，两处不再各自数一遍字段。
 * 取值与 engine/schema.mjs 每层 `fields` 的键集一致（对拍守卫见 test/client/mirror-guards.test.mjs）。
 */
export const LAYER_FIELD_POLICY_KEYS = [
  'position', 'dedupe', 'promotion', 'audience', 'modelScope', 'merge',
  'order', 'role', 'placeholder', 'subject', 'match',
] as const
export type LayerFieldPolicyKey = (typeof LAYER_FIELD_POLICY_KEYS)[number]

/** 每个注入层可用的字段开关（键集由 {@link LAYER_FIELD_POLICY_KEYS} 派生）。 */
export type LayerFieldPolicy = Record<LayerFieldPolicyKey, boolean>

/** settings bridge /meta 返回的引擎能力矩阵。层行为、顺序和编辑组见 {@link EngineMetaLayerContract}。 */
export interface EngineMeta extends Partial<EngineMetaLayerContract> {
  /**
   * 官方装配档位的区段刻度（B8 W2）：`from`/`to` 都是**运行期**从官方服务求得的值，
   * 客户端不得硬编码任何档位数值。只用于 `system-section` / `runtime-context` 两层的
   * order 快捷填值；服务降级或官方档位名不匹配时整张表缺席，此时**不渲染**刻度下拉
   * （数字输入仍是唯一真相与唯一写入通道）。
   */
  officialOrders?: OfficialOrdersView
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
  /** 实际可发出的注入角色（pre-step 只接受 user）；表单只提供这些值。 */
  roles: string[]
  /** 仍可加载的旧输入角色（含 assistant）；不等于可以继续新建。 */
  acceptedRoles?: string[]
  mergeModes: string[]
  fills: string[]
  /** 条件判定的匹配对象清单；旧宿主可能不下发。 */
  subjects?: string[]
  /** 层 → 缺省匹配对象映射（「层缺省」选项的说明文本）；旧宿主可能不下发。 */
  layerDefaultSubjects?: Record<string, string>
  layerFieldPolicies: Record<string, LayerFieldPolicy>
  layerLabels: Record<string, { title: string; detail: string }>
}

/** 配置校验错误条目（编辑器导入失败展示与列表校验共用）。 */
export interface ValidationErrorEntry {
  index: number
  id: string
  message: string
}
