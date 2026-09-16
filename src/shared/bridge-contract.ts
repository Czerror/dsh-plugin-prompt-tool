/**
 * settings bridge 跨端契约（host 注册 / client 消费的唯一来源）。
 * 铁律：所有端点载荷统一成功 `{ ok: true, value }`、失败 `{ ok: false, code?, message? }`；
 * 端点附加字段只能以 value 旁的可选扩展字段出现（describe）。
 * 改路径或载荷形状必须同步更新 test/shared/bridge-contract.test.mjs。
 */
import type { PersonaSpec } from './persona-section.ts'
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
  configsValidate: '/configs-validate',
  skillFix: '/skill-fix',
  skillsImport: '/skills-import',
  skillToggle: '/skill-toggle',
  skillsConfig: '/skills-config',
  templates: '/templates',
  promptConfigs: '/prompt-configs',
  agentsFile: '/agents-file',
  instructionsPolicy: '/instructions-policy',
  presetContent: '/preset-content',
  importPreset: '/import-preset',
  paramOverrides: '/param-overrides',
  persona: '/persona',
  presetVariables: '/preset-variables',
  customTools: '/custom-tools',
  importPresetPackage: '/import-preset-package',
  exportPreset: '/export-preset',
  presetDelete: '/preset-delete',
  presetClone: '/preset-clone',
  presetDuplicate: '/preset-duplicate',
  presetOpen: '/preset-open',
  charactersImport: '/characters-import',
  charactersImportStream: '/characters-import-stream',
  charactersList: '/characters-list',
  charactersDelete: '/characters-delete',
  charactersApply: '/characters-apply',
  charactersRemove: '/characters-remove',
  subagentToolPolicy: '/subagent-tool-policy',
  subagentToolPolicyPreview: '/subagent-tool-policy-preview',
  toolSurface: '/tool-surface',
  engineCapability: '/engine-capability',
  worldBookDiagnostics: '/world-book-diagnostics',
} as const

export type BridgeEndpoint = (typeof BRIDGE_ENDPOINTS)[keyof typeof BRIDGE_ENDPOINTS]

/** 失败载荷：两端共用。 */
export type BridgeErrorPayload = { ok: false; code?: string; message?: string }

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
  configsValidate: { promptConfigs: unknown[]; strategyDir?: string }
  skillFix: { folder: string }
  skillsImport: { files: Array<{ path: string; content: string }> }
  /** 技能启停（隐藏策略）：改名磁盘标记 SKILL.md ↔ SKILL.md.disabled。 */
  skillToggle: { folder: string; enabled: boolean; dir?: string }
  /** 技能管理配置（附加技能根 / 顺序 / rank 基数）：写 <DSH_HOME>/skills/.system/prompt-tool/config.yml。 */
  skillsConfig: { dirs?: string[]; order?: string[]; rankBase?: number }
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
  instructionsPolicy: { policy?: InstructionPolicyPatch; expectedRevision?: string | null } | undefined
  presetContent: undefined
  importPreset: { contents: Array<{ scope: 'preset' | 'agents'; content: string }>; expectedPresetId?: string }
  paramOverrides: { overrides?: Record<string, unknown>; promptConfigs?: unknown[]; rebuild?: boolean; expectedPresetId?: string }
  /** 顶层 persona 段读写（官方 @deepseek-ai/dsh-persona 行 config 同构）；省略 persona 键 = 读取。 */
  persona: { persona?: PersonaSpec | null; expectedPresetId?: string } | undefined
  presetVariables: { variables?: Record<string, string>; enabled?: boolean; expectedPresetId?: string }
  customTools: { customTools?: unknown[]; expectedPresetId?: string } | undefined
  /**
   * 预设包导入（含 SillyTavern JSON）。`preview: true` 只做同源转换并返回报告，不落盘；
   * 提交时若带 `expectedSourceDigest`，服务端用本次上传文件重算摘要并拒绝过期预览。
   * `expectedPreviewRevision` 是预览返回的版本凭据：绑定文件、实际选组、转换器版本与
   * 目标身份（含目标当前内容），服务端提交时重算，不符返回 409 且零写盘。
   * `promptOrderCharacterId` 用于多顺序组包时显式选择：预览缺省时先返回候选
   * （`state: 'needs-order-selection'`），提交时仍无法明确对应则拒绝。
   * 上述参数只接受声明的类型，其它类型一律 400（见 docs/SillyTavern.md）。
   */
  importPresetPackage: {
    files: Array<{ path?: string; name?: string; content?: string }>
    preview?: boolean
    expectedSourceDigest?: string
    expectedPreviewRevision?: string
    promptOrderCharacterId?: string
  }
  exportPreset: { id: string }
  presetDelete: { id: string }
  presetClone: { id: string; autoSuffix?: boolean }
  presetDuplicate: { id: string }
  presetOpen: { id: string }
  /** 角色卡 JSON 导入；`preview: true` 只转换并返回报告（不写角色库）；版本/选组语义与预设包一致。 */
  charactersImport: {
    files?: Array<{ path: string; content: string }>
    preview?: boolean
    expectedSourceDigest?: string
    expectedPreviewRevision?: string
    promptOrderCharacterId?: string
  }
  charactersImportStream: undefined
  charactersList: undefined
  charactersDelete: { id: string }
  charactersApply: { id: string }
  charactersRemove: { id: string }
  subagentToolPolicy: { policy?: unknown; expectedPresetId?: string } | undefined
  subagentToolPolicyPreview: { tool?: string; description?: string; prompt?: string; tool_profile?: string; character_id?: string; task_type?: string; additional_tools?: string[]; restrict_tools?: string[] }
  toolSurface: { sessionId: string; presetId?: never } | { presetId: string; sessionId?: never }
  engineCapability: ({ action: 'create' | 'remove'; capabilityId: string } | { action: 'create-recipe'; recipeId: string }) & { expectedPresetId?: string }
  /** 只读世界书诊断：只回当前授权会话最近一次选择的观测记录。 */
  worldBookDiagnostics: { sessionId?: string } | undefined
}

/** settings descriptor 的跨端最小结构。 */
export interface BridgeSettingsView {
  ns: string
  value: unknown
  base?: unknown
  revision: number
}

/**
 * 默认模型同步结果（预设保存链路带出，跨端统一形状）。
 *
 * 「预设已保存」与「宿主默认模型同步」是两件事：预设参数先落盘，随后插件把
 * provider/model/effort 写进官方 agent-default-model；后者可能因为服务未装配、
 * 宿主当前值已一致或写盘被拒而不同。四态都与失败区分：只有 `failed` 需要用户重试。
 */
export interface ModelSyncResult {
  status: 'synced' | 'unchanged' | 'unavailable' | 'failed'
  /** 安全提示：只带状态说明，不含凭证、路径或 provider 原始错误正文。 */
  message?: string
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
 * 不落盘进 preset.yml、不进入模型上下文，也不是写入凭证——提交仍以本次上传文件重算的
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
export interface WorldBookDiagnosticRecord {
  /** 配置 id（`lore-<来源条目>`）。 */
  id: string
  stage: 'excluded' | 'rejected' | 'candidate' | 'selected' | 'committed'
  /** 稳定原因码：disabled / delay / cooldown / recursion / primary-miss / secondary-miss /
   *  probability / group-lost / group-occupied / match-error / sticky / constant / key-match /
   *  ungrouped / group-winner / injected。 */
  reason: string
  [key: string]: unknown
}

/** 顺序组候选：多 prompt_order 组需要用户先选择时的有界选项（不含转换结果）。 */
export interface StOrderGroupCandidate {
  characterId: string
  entries: number
}

/** 导入预览状态：`ready` 才有报告与写入凭据；候选状态不得启用确认。 */
export type ImportPreviewState = 'ready' | 'needs-order-selection'

/** 端点级响应 value 契约（value 字段形状；扩展字段仍以 value 旁可选字段出现）。 */
export interface BridgeValueMap {
  meta: { meta: Record<string, unknown> }
  bootstrap: BridgeSettingsView
  describe: BridgeSettingsView
  models: { modelCatalog: Record<string, string[]> }
  modelReasoning: { reasoning: ModelReasoningView }
  mutate: BridgeSettingsView
  configsValidate: { valid: boolean; errors: Array<{ index: number; id: string; message: string }>; configs?: unknown[]; files?: unknown[] }
  skillFix: { folder: string; fixedFolder: string; name: string; actions: string[] }
  skillsImport: { path: string; count: number }
  skillToggle: { folder: string; enabled: boolean; changed: boolean; file: string; skillCatalog: unknown[] }
  /** 写入后的技能管理配置 + 生效目录（客户端据此刷新字段与目录列表）。 */
  skillsConfig: { dirs: string[]; order: string[]; rankBase: number; activeSkillsDirs: string[]; skillCatalog: unknown[] }
  templates: { templates?: unknown[]; toolTemplates?: unknown[] }
  promptConfigs: { promptConfigs: unknown[]; instructions?: InstructionsSnapshot }
  agentsFile: InstructionFileWriteResult
  instructionsPolicy: { policy: InstructionPolicy; revision: string | null; exists: boolean; error?: string }
  presetContent: Record<string, unknown>
  importPreset: { scopes: Array<'preset' | 'agents'> }
  /**
   * 参数/提示词配置写入结果。`modelSync` 只描述宿主默认模型同步的附加结果：
   * 预设写盘成功但默认模型未同步（unavailable/failed）时，UI 据此分开表达并允许重试。
   */
  paramOverrides: { overrides?: Record<string, unknown>; promptConfigs?: unknown[]; modelSync?: ModelSyncResult }
  persona: { persona: PersonaSpec | null }
  presetVariables: { variables: Record<string, string>; enabled: boolean }
  customTools: { customTools?: unknown[] }
  importPresetPackage: {
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
  }
  exportPreset: { id: string; name: string; content: string }
  presetDelete: { id: string }
  presetClone: { id: string }
  presetDuplicate: { id: string }
  presetOpen: { path: string }
  charactersImport: {
    id?: string
    name?: string
    preview?: boolean
    state?: ImportPreviewState
    candidates?: StOrderGroupCandidate[]
    sourceDigest?: string
    previewRevision?: string
    report?: StConversionReport
  }
  charactersImportStream: { id: string; name: string }
  charactersList: { characters: Array<{ id: string; name: string; description?: string; hasAvatar: boolean; imported: boolean }> }
  charactersDelete: { id: string }
  charactersApply: { id: string; count: number }
  charactersRemove: { id: string; count: number }
  subagentToolPolicy: { policy: unknown; defaultProfile?: string; errors?: string[] }
  subagentToolPolicyPreview: { result: unknown; errors?: string[] }
  toolSurface: {
    source: 'session' | 'preset'
    sessionId?: string
    presetId?: string
    tools: Array<{ name: string; description: string }>
  }
  engineCapability: { changed: boolean; addedModules?: string[]; removedModules?: string[]; capabilityIds: string[] }
  /** 只读世界书诊断：只回当前授权会话最近一次选择的观测记录（读取不重新求值）。 */
  worldBookDiagnostics: { records: WorldBookDiagnosticRecord[]; truncated: boolean; step: number; evaluated: boolean }
}
/** 编译期断言：请求/响应映射与 BRIDGE_ENDPOINTS 键集合完全一致（漏改任一侧 typecheck 失败）。 */
type AssertCoverage<K extends string, M extends object> =
  Exclude<K, keyof M> extends never
    ? Exclude<keyof M, K> extends never ? true : false
    : false
type _requestCoverage = AssertCoverage<keyof typeof BRIDGE_ENDPOINTS, BridgeRequestMap>
type _responseCoverage = AssertCoverage<keyof typeof BRIDGE_ENDPOINTS, BridgeValueMap>
