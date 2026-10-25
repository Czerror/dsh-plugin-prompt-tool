/**
 * settings bridge 跨端契约（host 注册 / client 消费的唯一来源）。
 * 铁律：所有端点载荷统一成功 `{ ok: true, value }`、失败 `{ ok: false, code?, message? }`；
 * 端点附加字段只能以 value 旁的可选扩展字段出现（describe）。
 * 改路径或载荷形状必须同步更新 test/shared/bridge-contract.test.mjs。
 */
import type { PersonaSnapshot, PersonaSpec, PersonaSourcesRequest, PersonaSourcesSnapshot } from './persona-section.ts'
import type { ModuleVariablesRequest, ModuleVariablesSnapshot } from './module-variables.ts'
import type { RulesRequest, RulesSnapshot } from './rules.ts'
import type { ModuleConfigIdentity, ModuleConfigOrderSnapshot } from './module-config-order.ts'
import type { AssetSummary, BridgeAssetImportRequest, ImportKind, ModuleExportRequest, ModuleExportResult } from './asset-transfer.ts'
import type { PublicationFields } from './publication.ts'
import type { EngineEditorGroup, InjectionPoint, ModuleFacts } from './engine-capabilities.ts'
import type { OfficialOrdersView } from './official-orders.ts'
import { isModuleId } from './module-ids.ts'
import type { SkillCatalogEntry, SkillContentSnapshot, SkillPolicyChange, SkillsCatalogSnapshot } from './skills.ts'
import type {
  InstructionFileWriteResult,
  InstructionPolicy,
  InstructionPolicyPatch,
  InstructionsSnapshot,
} from './instructions.ts'

export const SETTINGS_BRIDGE_PREFIX = '/api/prompt-tool/settings'

/** JSON bridge 的统一内存缓冲上限；超过后改用原始文件流端点。 */
export const MAX_BRIDGE_BODY_BYTES = 32 * 1024 * 1024
/** 角色卡原始文件流上限；独立于 JSON bridge，避免 base64 膨胀。 */
export const MAX_CHARACTER_CARD_STREAM_BYTES = 64 * 1024 * 1024

/** 桥端点路径（相对前缀）。新增端点必须同时登记到契约测试。 */
export const BRIDGE_ENDPOINTS = {
  meta: '/meta',
  bootstrap: '/bootstrap',
  describe: '/describe',
  models: '/models',
  modelReasoning: '/model-reasoning',
  mutate: '/mutate',
  skillsList: '/skills-list',
  skillPolicy: '/skill-policy',
  skillRead: '/skill-read',
  skillWrite: '/skill-write',
  skillsFolders: '/skills-folders',
  skillsImport: '/skills-import',
  skillsImportDirectory: '/skills-import-directory',
  skillCreate: '/skill-create',
  skillDelete: '/skill-delete',
  templates: '/templates',
  promptConfigs: '/prompt-configs',
  agentsFile: '/agents-file',
  instructionsPolicy: '/instructions-policy',
  paramOverrides: '/param-overrides',
  triggers: '/triggers',
  rules: '/rules',
  persona: '/persona',
  personaSources: '/persona-sources',
  moduleVariables: '/module-variables',
  customTools: '/custom-tools',
  importModulePackage: '/import-module-package',
  assetUpload: '/asset-upload',
  assetRelease: '/asset-release',
  exportModule: '/export-module',
  moduleDelete: '/module-delete',
  moduleClone: '/module-clone',
  moduleDuplicate: '/module-duplicate',
  moduleOpen: '/module-open',
  moduleName: '/module-name',
  moduleEnable: '/module-enable',
  moduleConfigOrder: '/module-config-order',
  toolSurface: '/tool-surface',
  moduleCapability: '/module-capability',
  contextActivationDiagnostics: '/context-activation-diagnostics',
  ruleDiagnostics: '/rule-diagnostics',
} as const

export type BridgeEndpoint = (typeof BRIDGE_ENDPOINTS)[keyof typeof BRIDGE_ENDPOINTS]

export type BridgeEndpointKey = keyof typeof BRIDGE_ENDPOINTS

/** 失败载荷：两端共用。 */
export type BridgeErrorPayload = { ok: false; code?: string; message?: string; conflicts?: string[] }

/**
 * **编辑目标**只在请求头里声明：body 是各端点自己的载荷形状，不掺公共键。
 *
 * 身份是 `模块 id`（模块目录名）。加上卡自身的 id 就唯一确定一张配置卡——模块 id 形状受限
 * 且复制必带 `-copy` 后缀（`duplicateUserModule`），卡 id 在模块内唯一（引擎 `createPromptConfigs`
 * 拒绝重复），所以「模块 id + 卡 id」不存在重复可能。
 */
export const EDIT_TARGET_HEADER = 'x-module-id'

/** 一次读写的主语是哪个模块：`required` 没有主语就不能执行，`optional` 缺省只做全局段，`none` 与模块无关。 */
export type BridgeSubjectPolicy = 'required' | 'optional' | 'none'

/**
 * 主语策略表——客户端类型约束与服务端归属门的**唯一名单**（`satisfies Record` 覆盖保证漏标即 typecheck 失败）。
 * 判据＝服务端 handler 是否读 `tx.editDir()`：`required` 缺主语必须拒绝，不得回退启用表首项。
 * 不用 `: Record<...>` 注解：注解会把每项加宽成 `BridgeSubjectPolicy`，客户端就再也读不到单个端点的字面量。
 */
export const BRIDGE_SUBJECT_POLICY = {
  meta: 'none',
  /** 空主语只回全局段。 */
  bootstrap: 'optional',
  describe: 'required',
  models: 'none',
  modelReasoning: 'none',
  mutate: 'optional',
  skillsList: 'none',
  skillPolicy: 'none',
  skillRead: 'none',
  skillWrite: 'none',
  skillsFolders: 'none',
  skillsImport: 'none',
  skillsImportDirectory: 'none',
  skillCreate: 'none',
  skillDelete: 'none',
  templates: 'none',
  promptConfigs: 'optional',
  agentsFile: 'none',
  instructionsPolicy: 'none',
  /**
   * 空主语 = **全局层**（存储根 `config.yml` 的 `layerSettings`），不是「没有目标」：
   * 固定卡（指令卡）是全局段，它的参数设置区写全局层；有主语时读写该模块 `module.yml`。
   * 优先级「模块显式键 ＞ 全局键」由服务端 `module-params.ts#resolveModuleParams` 一处判定，
   * 端点与客户端都不重复判。
   */
  paramOverrides: 'optional',
  triggers: 'none',
  rules: 'required',
  persona: 'required',
  personaSources: 'none',
  moduleVariables: 'required',
  customTools: 'required',
  importModulePackage: 'none',
  assetUpload: 'none',
  assetRelease: 'none',
  exportModule: 'none',
  /** 在用判据。 */
  moduleDelete: 'optional',
  moduleClone: 'none',
  moduleDuplicate: 'none',
  moduleOpen: 'none',
  moduleName: 'required',
  moduleEnable: 'none',
  moduleConfigOrder: 'none',
  toolSurface: 'none',
  moduleCapability: 'required',
  contextActivationDiagnostics: 'none',
  ruleDiagnostics: 'none',
} satisfies Record<BridgeEndpointKey, BridgeSubjectPolicy>

/** 请求头声明的模块 id 与 handler 实际归属不一致：归属门拒绝，绝不按请求头改归属。 */
export const MODULE_SUBJECT_CONFLICT = 'module-subject-conflict'
/** 请求头带模块身份但形状非法：边界显式拒绝（400），不静默当作缺席。 */
export const MODULE_IDENTITY_INVALID = 'module-identity-invalid'
/** 模块没声明这次读写要用的节：判据只看 `module.yml` 顶层键存在性（键不存在＝没声明），解析失败另有错误码。 */
export const MODULE_NOT_DECLARED = 'module-not-declared'

/**
 * 主语头三态：`absent` 只表示请求头**完全没有**（`undefined` / `null`）；
 * 其余非 `ok` 一律 `invalid`（空串、纯空白、重复头数组、非字符串、超长、非法字符）。
 */
export type SubjectHeaderState = { state: 'ok'; id: string } | { state: 'absent' } | { state: 'invalid' }

/** 读主语头：带了身份但形状非法一律 `invalid`，由边界显式拒绝（400），不当作「未声明」降级。 */
export function readSubjectHeader(value: unknown): SubjectHeaderState {
  if (value === undefined || value === null) return { state: 'absent' }
  if (typeof value !== 'string') return { state: 'invalid' }
  const id = value.trim()
  return id.length > 0 && id.length <= 64 && isModuleId(id) ? { state: 'ok', id } : { state: 'invalid' }
}

/** 读编辑目标（旧语义：形状非法当「未声明」）；形状非法由边界显式拒绝（400），不再回退启用表首项。 */
export function readEditTarget(value: unknown): string | undefined {
  const header = readSubjectHeader(value)
  return header.state === 'ok' ? header.id : undefined
}

/** 插件可编辑模块的身份与展示元数据；不可渲染的项保留身份供用户修复。 */
export interface ModuleSummary {
  id: string
  name: string
  user?: boolean
  renderable?: boolean
  description?: string
  meta?: Record<string, unknown>
  broken?: string
  /** 是否在存储根 `config.yml` 的启用表里（启用即参与运行时装配）。 */
  enabled?: boolean
  /** 该模块的身份与能力派生事实（与 `/bootstrap` 的 `moduleFacts` 同源同形）；
   *  模块损坏或事实算不出时缺席，绝不下发部分字段。 */
  facts?: ModuleFacts
  /** 该模块 `module.yml` 的顶层键名（＝它声明了哪些节）；只下发键名不下发内容。
   *  定义不可解析（损坏）时与 `facts` 同口径缺席——客户端据此保守放行，不把「读不到」当「没声明」。 */
  declares?: string[]
}

/**
 * 端点级请求体契约（body 形状；无请求体端点 = undefined）。
 * 与 BRIDGE_ENDPOINTS 一一对应：新增端点必须同时补请求/响应映射，否则编译期断言失败。
 * 载荷仍统一走 { ok, value } 包装（见 BridgeResult），这里收敛每端的 value 具体形状。
 */
export interface BridgeRequestMap {
  meta: undefined
  /** 可选 sessionId：服务端据此解析该本地 Agent 的工作区，返回对应指令文件快照。 */
  bootstrap: { sessionId?: string } | undefined
  describe: undefined
  /** 省略 body 或 `refresh: true`（显式刷新越过 10 分钟目录 TTL）。 */
  models: { refresh?: boolean } | undefined
  modelReasoning: { provider: string; model: string }
  mutate: { ops: unknown[]; expectedRevision?: number }
  /** 技能清单：按会话工作区扫描官方六类技能根，调用策略取自各技能文件的 frontmatter。 */
  skillsList: { sessionId?: string } | undefined
  /** 调用策略开关：改写该技能 SKILL.md frontmatter 的官方两个键（正文不动）；
   *  path 必须命中服务端当次扫描的同名条目，否则按陈旧界面拒绝。 */
  skillPolicy: { name: string; path: string; sessionId?: string } & SkillPolicyChange
  /** 技能描述、Markdown 正文和完整原文摘要；重新扫描同名同路径身份。 */
  skillRead: { name: string; path: string; sessionId?: string }
  /** 仅保存描述与正文，保持其余 frontmatter，并用完整原文摘要拒绝并发覆盖。 */
  skillWrite: { name: string; path: string; sessionId?: string; content: string; description: string; expectedRevision: string }
  /** 添加 / 移除引用的技能文件夹（只记状态，不复制文件）。 */
  skillsFolders: { folders: string[]; sessionId?: string }
  /** overwrite 仅包含用户已确认覆盖的技能目录名；缺省时遇到同名返回冲突且不写盘。 */
  skillsImport: { files: Array<{ path: string; content: string }>; overwrite?: string[] }
  skillsImportDirectory: { path: string; overwrite?: string[] }
  skillCreate: { name: string; description: string; content: string }
  skillDelete: { name: string; path: string; sessionId?: string }
  templates: undefined
  /** 可选 sessionId：与 /bootstrap 同源解析当前工作区（单读与聚合读取必须一致）。 */
  promptConfigs: { sessionId?: string } | undefined
  /**
   * 单文件写盘：fileId/contextId 必须命中服务端当次解析的白名单；
   * expectedRevision 是客户端已读取的字节版本（乐观并发控制，服务端重读校验）。
   */
  agentsFile: {
    sessionId?: string
    contextId: string
    fileId: string
    expectedRevision: string | null
    content: string
  }
  /**
   * 指令文件卡策略（独立存储，默认禁用）：省略 `policy` = 读取；
   * 写入必须带读取时的 `expectedRevision`（文件缺失为 null）。
   */
  /** 逐文件启停/名称；无 policy 时读取，写入仍校验原始字节版本。 */
  instructionsPolicy: { policy?: InstructionPolicyPatch; expectedRevision?: string | null } | undefined
  paramOverrides: { overrides?: Record<string, unknown>; promptConfigs?: unknown[]; rebuild?: boolean; expectedModuleId?: string; refreshOnly?: boolean }
  /** 退役端点（410）：不再接受任何请求体。 */
  triggers: undefined
  rules: RulesRequest
  /** 独立主/子人设卡；省略 persona 读取，写入必须携带读取时的完整定义版本。 */
  persona: { persona?: PersonaSpec | null; expectedModuleId?: string; expectedRevision?: string; refreshOnly?: boolean } | undefined
  personaSources: PersonaSourcesRequest | undefined
  moduleVariables: ModuleVariablesRequest
  customTools: { customTools?: unknown[]; expectedModuleId?: string; refreshOnly?: boolean } | undefined
  /**
   * 模块包导入（原生/ST/PNG/ZIP）。`preview: true` 只转换并返回报告，不写目标；
   * 提交必须携带 expectedSourceDigest 和 expectedPreviewRevision，服务端重算并拒绝过期预览。
   * `expectedPreviewRevision` 是预览返回的版本凭据：绑定文件、实际选组、转换器版本与
   * 目标身份（含目标当前内容），服务端提交时重算，不符返回 409 且零写盘。
   * `promptOrderCharacterId` 用于多顺序组包时显式选择：预览缺省时先返回候选
   * （`state: 'needs-order-selection'`），提交时仍无法明确对应则拒绝。
   * 上述参数只接受声明的类型，其它类型一律 400（见 docs/SillyTavern.md）。
   */
  importModulePackage: BridgeAssetImportRequest
  assetUpload: undefined
  assetRelease: { sourceId: string }
  exportModule: ModuleExportRequest
  moduleDelete: { id: string; refreshOnly?: boolean }
  moduleClone: { id: string; autoSuffix?: boolean; refreshOnly?: boolean }
  moduleDuplicate: { id: string; refreshOnly?: boolean }
  moduleOpen: { id: string }
  moduleName: { name?: string; expectedRevision?: string; expectedModuleId?: string; refreshOnly?: boolean }
  moduleEnable: { id: string; enabled: boolean; refreshOnly?: false } | { refreshOnly: true; id?: never; enabled?: never }
  moduleConfigOrder: ({ moduleId: string } | { moduleId?: string; entries: ModuleConfigIdentity[]; expectedRevision: string }) & { refreshOnly?: boolean } | undefined
  toolSurface: { sessionId: string; presetId?: never } | { presetId: string; sessionId?: never }
  moduleCapability: (
    | { action: 'create' | 'remove'; capabilityId: string }
    | { action: 'create-recipe'; recipeId: string }
    | { action?: undefined }
  ) & { expectedModuleId?: string; refreshOnly?: boolean }
  /** 只读世界书诊断：只回当前授权会话最近一次选择的观测记录。 */
  contextActivationDiagnostics: { sessionId?: string } | undefined
  /** 只读规则判定计数：无请求体，读取不触发求值。 */
  ruleDiagnostics: undefined
}

/** settings descriptor 的跨端最小结构。 */
export interface BridgeSettingsView {
  ns: string
  value: unknown
  base?: unknown
  revision: number
}

/**
 * 一条 provider/model 路由的推理档位元数据（官方模型元数据的展示子集）。
 *
 * `known` 区分「查过且该路由不提供档位」与「尚未取得元数据」：前者 UI 必须隐藏档位
 * 选择而不是拿固定列表伪造能力；后者只是还没查到，不能据此判断模型没有推理能力。
 * 目录/元数据只作展示，不是授权白名单——查询失败不影响保存任意模型 id。
 */
export interface ModelReasoningView {
  known: boolean
  efforts: Array<{ id: string; name: string; description?: string }>
  defaultEffort?: string
}

/**
 * SillyTavern 转换报告（ST-03）：host 在真实转换路径上生成的**只读派生元数据**。
 * 不落盘进 module.yml、不进入模型上下文，也不是写入凭证——提交仍以本次上传文件重算的
 * `sourceDigest` 为准；预览返回的摘要不能替代后端对目标/类型/大小的既有校验。
 */
export type StConversionClass = 'equivalent' | 'degraded' | 'unsupported' | 'excluded'

export interface StConversionEntryReport {
  /** 来源条目身份：上传文件显示名内的原 identifier/uid（不含绝对路径）。 */
  sourceId: string
  /** 来源在文件内的序号（prompts 数组下标或世界书 entries 序号）。 */
  sourceIndex: number
  /** 生成的目标配置 id（被排除的条目没有目标）。多文件合并后重写为**最终** id。 */
  targetId?: string
  /** 同源生成的 promptConfigs 下标：合并重命名时用它把 targetId 关联到最终配置。 */
  targetIndex?: number
  /** 来源显示名（多文件合并时用于区分条目来自哪个上传文件）。 */
  sourceName?: string
  /** 来源在本次合并中的序号（0 起）。 */
  sourceFileIndex?: number
  layer?: string
  order?: number
  role?: string
  position?: string
  classification: StConversionClass
  /** 稳定原因码（如 depth-collapsed / system-role-downgrade / marker-dropped）。 */
  codes: string[]
}

export interface StConversionDiagnostic {
  code: string
  severity: 'warning' | 'info'
  message: string
  /** 源身份定位：来源条目 id（与 targetId 分开表达，不混用同一字段）。 */
  entryId?: string
  /** 目标身份定位：生成/合并后的最终配置 id（源条目被排除时缺省）。 */
  targetId?: string
  field?: string
}

export interface StConversionReport {
  /** 转换器版本：解释本次生成使用了哪一版语义。 */
  converter: string
  /** 来源显示名（上传文件名，不含绝对路径）。 */
  sourceName: string
  /** prompt_order 分组；`selected` 标记本次实际采用的组。 */
  orderGroups: Array<{ characterId: string; selected: boolean; entries: number }>
  entries: StConversionEntryReport[]
  diagnostics: StConversionDiagnostic[]
  summary: {
    /** 来源条目总数（prompts + 世界书条目 + 角色卡正文段）。 */
    inputs: number
    /** 生成的 promptConfigs 数量。 */
    converted: number
    /** 生成但被禁用的条目数。 */
    disabled: number
    excluded: number
    unsupported: number
    degraded: number
    /** 需要用户确认的诊断数（warning 级）。 */
    needsReview: number
  }
  /** 记录超出上限时为 true：只截断展示，不影响转换结果。 */
  truncated?: boolean
}

/** 世界书入选/落选诊断记录（只读派生数据，由引擎真实求值路径产生）。 */
export interface ContextActivationDiagnosticRecord {
  /** 配置 id（`lore-<来源条目>`）。 */
  id: string
  stage: 'excluded' | 'rejected' | 'candidate' | 'selected' | 'committed'
  /** 稳定原因码：disabled / delay / cooldown / recursion / primary-miss / secondary-miss /
   *  probability / group-lost / group-occupied / match-error / sticky / constant / key-match /
   *  ungrouped / group-winner / injected。 */
  reason: string
  [key: string]: unknown
}

/** 规则判定类别：`unavailable` = 条件因缺事实无法判定（三值语义）；`miss` = 条件按设计不满足。 */
export type RuleOutcomeKind = 'hit' | 'miss' | 'unavailable' | 'error' | 'disabled'

/** 单条规则的判定计数（只读派生数据）；只含身份与计数，不含规则正文、事件载荷或会话文本。 */
export interface RuleDiagnosticRecord {
  moduleId?: string
  ruleId: string
  channel: string
  hit: number
  miss: number
  unavailable: number
  error: number
}

/** 顺序组候选：多 prompt_order 组需要用户先选择时的有界选项（不含转换结果）。 */
export interface StOrderGroupCandidate {
  characterId: string
  entries: number
}

/** 导入预览状态：`ready` 才有报告与写入凭据；候选状态不得启用确认。 */
export type ImportPreviewState = 'ready' | 'needs-order-selection' | 'needs-kind-selection'

/** 引擎实际消费的实例参数；只下发可序列化约束，未知扩展键仍由原配置保留。 */
export interface LayerParamContract {
  type: 'string' | 'boolean' | 'object' | 'enum'
  values?: readonly string[]
}

/** 声明编辑目录由引擎提供；示例同时经过声明编译器验证。 */
export interface TriggerEditorMeta {
  predicates: Array<{ kind: string; example: Record<string, unknown> }>
  actions: Array<{ kind: string; example: Record<string, unknown>; channel: string; phase: string; supportsWhen: boolean }>
  composites: string[]
  waterfallPositions: string[]
}

export interface LayerContract {
  strategies: readonly string[]
  content: 'text' | 'request' | 'stream' | 'tool-result' | 'subagent-result'
  variables: boolean
  messageMetadata: boolean
  params: Readonly<Record<string, LayerParamContract>>
}

/**
 * /meta 与 /bootstrap 的 meta 段下发的层契约：九层顺序 + 编辑组主归属。
 * 只含可序列化白名单字段（组 id / displayLayer / relatedLayers / hook）：
 * 不含路径、行级配置、校验函数或服务实例 —— 展示归属不扩大写权限。
 * 插件与内置引擎同步发布，这些字段由当前 bridge 完整下发。
 */
export interface EngineMetaLayerContract {
  /** 九层固定顺序（引擎 LAYER_ORDER，host 不另写一份）。 */
  layerOrder: readonly InjectionPoint[]
  /**
   * `inject-text` 真正可绑定的六层（请求配置、流控制、工具管线由各自动作承担）：
   * 动作的 `config.layer` 下拉用它；`layerOrder` / `layers` 保持九层，供视图筛选与规则级 `layer`。
   * bootstrap 之前的空加载快照不含本键，与同为空的 `layers` 是同一档退化。
   */
  injectionLayers?: readonly InjectionPoint[]
  /** 编辑组主归属总表（能力组 id = 能力 id）；前端据此组织九层卡片。 */
  editorGroups: readonly EngineEditorGroup[]
  /** 每层真实可编辑的行为契约，来自独立可分发的 engine/schema.mjs。 */
  layerContracts: Record<InjectionPoint, LayerContract>
}

/** 物化配置的只读排序投影；不能作为客户端提供的写盘序号。 */
export interface PromptConfigSourceView {
  sequence?: number
}

/** `/meta` 与 `/bootstrap` 的 meta 段：层契约 + 官方装配刻度。`officialOrders` 缺席＝服务降级或档位名不匹配，消费方必须退化。 */
export interface BridgeMetaSection {
  meta: Record<string, unknown> & EngineMetaLayerContract & { officialOrders?: OfficialOrdersView }
}

/**
 * `/bootstrap` 与 `/describe` 共用的**模块与模型事实段**：host 侧同一段 extras 构造的产物（`collectDescribeExtras`）。
 *
 * 信封四键（`ns`/`value`/`base?`/`revision`）在 {@link BridgeSettingsView} 里，两者与 descriptor 在响应体同一层平铺。
 *
 * **条件存在的键标 `?` 并注明缺席条件**——它们不是"宽松"，而是记录真实语义。某个键将来变成必有时
 * **只需去掉 `?`**，编译器会指出 host 构造处是否补齐（这就是这份声明对升级的价值）。
 */
export interface BridgeSessionExtras {
  /** 条件：目录非空且声明了 params / layerSettings；**空主语时整键缺席**（JSON.stringify 丢 undefined）。 */
  moduleParams?: Record<string, unknown>
  /** 条件：模块事实可算；算不出时整个键缺席，**绝不**下发部分字段。 */
  moduleFacts?: ModuleFacts
  /** 条件：宿主 agent-default-model 设置在位。 */
  hostDefaultModel?: { provider?: string; model?: string; reasoningEffort?: string }
  templatePreStepCount: number
  modelsAvailable: boolean
  providers: string[]
  modelCatalog: Record<string, string[]>
  /** 条件：模型探测失败时才有；成功时整键缺席。 */
  modelsError?: string
  activeSkillsDirs: string[]
  skillCatalog: SkillCatalogEntry[]
  skillsComplete: boolean
  skillFolders: string[]
}

/**
 * `/bootstrap` 在组装处**额外**加的会话段——`/describe` **不下发**这些键。
 *
 * 与 {@link BridgeSessionExtras} 分开声明是刻意的：两个端点的字段集不同，套用同一份会让 `/describe`
 * 声称自己下发 `meta`／`promptConfigs` 等并不存在的键，那正是本轮要消灭的「类型骗人」。
 */
export interface BridgeBootstrapExtras {
  /** meta 段：响应里是 `meta: { meta: <引擎元数据> }` 的一层包裹，形状见 {@link BridgeMetaSection}。 */
  meta: BridgeMetaSection
  overrides: { overrides: Record<string, unknown> }
  /** 全局层参数（存储根 `config.yml` 的 layerSettings）；软失败时为空表，首屏照常。 */
  globalParams: Record<string, unknown>
  /** 条件：目标模块目录非空且声明了 variables / variablesEnabled。 */
  variables?: ModuleVariablesSnapshot
  /**
   * 配置卡数组。**元素的完整形状是客户端视图**（client 的 `PromptConfigDraft`：id／kind／层／内容字段），
   * 契约只保证「这是一个数组」——消费方按既有的 shape guard 文化自行收窄，不在这里假装知道卡片的形状。
   */
  promptConfigs: { promptConfigs: unknown[] }
  instructions: InstructionsSnapshot
}

/**
 * 端点级**顶层附加字段**契约：响应体里与 `value` 平铺的那些键（不含 `ok`）。
 *
 * 与 {@link BridgeValueMap} 分开是刻意的——那个描述 `value` **字段本身**的形状（`/bootstrap` 的
 * `value` 只是 settings descriptor），这个描述它旁边的扩展字段。**按端点声明**而不是一份共用：
 * 共用会让每个端点都"看起来"有别人的字段（在 `/meta` 上读 `skillCatalog` 编译通过、运行期
 * `undefined`），而按端点声明把这种误读变成编译错误。
 */
export interface BridgeExtrasMap {
  /** `/bootstrap`：会话段（`meta`／`overrides`／`globalParams`／`variables?`／`promptConfigs`／`instructions`）＋ 模块与模型事实段。 */
  bootstrap: BridgeBootstrapExtras & BridgeSessionExtras
  /** `/describe`：只有模块与模型事实段，**没有**会话段（它不下发 `meta`／`promptConfigs` 等键）。 */
  describe: BridgeSessionExtras
}

/** 端点未声明顶层附加字段时是恒等交叉（`A & unknown` 不改变 `A`）。 */
export type BridgeExtrasOf<K extends BridgeEndpointKey> = K extends keyof BridgeExtrasMap ? BridgeExtrasMap[K] : unknown

/** 一次 bridge 调用的成功响应体：`value` 字段 ＋ 该端点的顶层附加字段。 */
export type BridgeResponse<K extends BridgeEndpointKey> =
  ({ ok: true; value: BridgeValueMap[K] } & BridgeExtrasOf<K>) | BridgeErrorPayload

/** 端点级响应 value 契约（value 字段形状；扩展字段仍以 value 旁可选字段出现）。 */
export interface BridgeValueMap {
  /** `/meta` 与 `/bootstrap` 的 meta 段（形状与缺席语义见 {@link BridgeMetaSection}）。 */
  meta: BridgeMetaSection
  bootstrap: BridgeSettingsView
  describe: BridgeSettingsView
  models: { modelCatalog: Record<string, string[]> }
  modelReasoning: { reasoning: ModelReasoningView }
  mutate: BridgeSettingsView
  /** 技能清单 + 引用目录 + 技能根（客户端据此渲染来源筛选与调用策略）。 */
  skillsList: SkillsCatalogSnapshot & { folders: string[]; roots: string[] }
  skillPolicy: SkillsCatalogSnapshot
  skillRead: SkillContentSnapshot
  skillWrite: SkillContentSnapshot
  skillsFolders: SkillsCatalogSnapshot & { folders: string[] }
  skillsImport: { path: string; count: number; overwritten: number; warning?: string }
  skillCreate: { id: string; path: string }
  skillDelete: { id: string; path: string }
  skillsImportDirectory: { path: string; count: number; overwritten: number; warning?: string }
  templates: { templates?: unknown[]; toolTemplates?: unknown[] }
  promptConfigs: { promptConfigs: Array<Record<string, unknown> & PromptConfigSourceView>; instructions?: InstructionsSnapshot }
  agentsFile: InstructionFileWriteResult
  instructionsPolicy: { policy: InstructionPolicy; revision: string | null; exists: boolean; error?: string }
  /** 参数/提示词配置只保存当前模块，不同步宿主全局默认模型。 */
  paramOverrides: { overrides?: Record<string, unknown>; effective?: Record<string, unknown>; promptConfigs?: unknown[] } & PublicationFields
  triggers: { triggers: unknown[]; revision: string; meta: TriggerEditorMeta }
  rules: RulesSnapshot
  persona: PersonaSnapshot & PublicationFields
  personaSources: PersonaSourcesSnapshot
  moduleVariables: ModuleVariablesSnapshot
  customTools: { customTools?: unknown[] } & PublicationFields
  importModulePackage: {
    id?: string
    backupPath?: string
    preview?: boolean
    state?: ImportPreviewState
    /** 候选状态下的歧义来源文件显示名（不含绝对路径）。 */
    sourceName?: string
    candidates?: StOrderGroupCandidate[]
    sourceDigest?: string
    previewRevision?: string
    report?: StConversionReport
    summary?: AssetSummary
    kinds?: ImportKind[]
  } & PublicationFields
  assetUpload: { sourceId: string; name: string; bytes: number }
  assetRelease: { released: boolean }
  exportModule: ModuleExportResult
  /** 删除成功但旧副本清理失败时，隐藏目录的绝对路径（清理未完成，内容可能不完整）。 */
  moduleDelete: { id: string; backupPath?: string } & PublicationFields
  moduleClone: { id: string } & PublicationFields
  moduleDuplicate: { id: string } & PublicationFields
  moduleOpen: { path: string }
  moduleName: { name: string; revision: string } & PublicationFields
  moduleEnable: { enabled: string[] } & PublicationFields
  moduleConfigOrder: ModuleConfigOrderSnapshot & PublicationFields
  toolSurface: {
    source: 'session' | 'preset'
    sessionId?: string
    presetId?: string
    tools: Array<{ name: string; description: string }>
  }
  moduleCapability: { changed: boolean; addedModules?: string[]; removedModules?: string[]; capabilityIds: string[] } & PublicationFields
  /** 只读世界书诊断：只回当前授权会话最近一次选择的观测记录（读取不重新求值）。 */
  contextActivationDiagnostics: { records: ContextActivationDiagnosticRecord[]; truncated: boolean; step: number; evaluated: boolean }
  /** 只读规则判定计数：按「模块 + 规则 + 通道」聚合，读取不重新求值；`dropped` 仅在超出 512 身份上限时出现，该字段保留给外部消费者与后续 UI，当前工作台不渲染。状态栏另用 `configs` 报全仓启用/总配置卡数，配置读取失败时该字段缺席。 */
  ruleDiagnostics: { records: RuleDiagnosticRecord[]; dropped?: number; configs?: ModuleConfigOrderSnapshot }
}
/** 编译期断言：请求/响应映射与 BRIDGE_ENDPOINTS 键集合完全一致（漏改任一侧 typecheck 失败）。 */
type AssertCoverage<K extends string, M extends object> =
  Exclude<K, keyof M> extends never
    ? Exclude<keyof M, K> extends never ? true : false
    : false
type _requestCoverage = AssertCoverage<keyof typeof BRIDGE_ENDPOINTS, BridgeRequestMap>
type _responseCoverage = AssertCoverage<keyof typeof BRIDGE_ENDPOINTS, BridgeValueMap>
