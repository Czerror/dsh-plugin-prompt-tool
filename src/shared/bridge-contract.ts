/**
 * settings bridge 跨端契约（host 注册 / client 消费的唯一来源）。
 * 铁律：30 个端点载荷统一成功 `{ ok: true, value }`、失败 `{ ok: false, code?, message? }`；
 * 端点附加字段只能以 value 旁的可选扩展字段出现（describe）。
 * 改路径或载荷形状必须同步更新 test/shared/bridge-contract.test.mjs。
 */
export const SETTINGS_BRIDGE_PREFIX = '/api/prompt-tool/settings'

/** JSON bridge 的统一内存缓冲上限；超过后改用原始文件流端点。 */
export const MAX_BRIDGE_BODY_BYTES = 32 * 1024 * 1024
/** 角色卡原始文件流上限；独立于 JSON bridge，避免 base64 膨胀。 */
export const MAX_CHARACTER_CARD_STREAM_BYTES = 32 * 1024 * 1024

/** 桥端点路径（相对前缀）。新增端点必须同时登记到契约测试。 */
export const BRIDGE_ENDPOINTS = {
  meta: '/meta',
  bootstrap: '/bootstrap',
  describe: '/describe',
  models: '/models',
  mutate: '/mutate',
  configsValidate: '/configs-validate',
  skillFix: '/skill-fix',
  skillsImport: '/skills-import',
  templates: '/templates',
  promptConfigs: '/prompt-configs',
  presetContent: '/preset-content',
  importPreset: '/import-preset',
  paramOverrides: '/param-overrides',
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
  bootstrap: undefined
  describe: undefined
  models: undefined
  mutate: { ops: unknown[]; expectedRevision?: number }
  configsValidate: { promptConfigs?: unknown; strategyDir?: string }
  skillFix: { folder: string }
  skillsImport: { files: Array<{ path: string; content: string }> }
  templates: undefined
  promptConfigs: undefined
  presetContent: undefined
  importPreset: { contents: Array<{ scope: 'preset' | 'agents'; content: string }> }
  paramOverrides: { overrides?: Record<string, unknown>; promptConfigs?: unknown; rebuild?: boolean }
  presetVariables: { variables?: Record<string, string>; enabled?: boolean }
  customTools: { customTools?: unknown[] } | undefined
  importPresetPackage: { files: Array<{ path?: string; name?: string; content?: string }> }
  exportPreset: { id: string }
  presetDelete: { id: string }
  presetClone: { id: string; autoSuffix?: boolean }
  presetDuplicate: { id: string }
  presetOpen: { id: string }
  charactersImport: { files?: Array<{ path: string; content: string }> }
  charactersImportStream: undefined
  charactersList: undefined
  charactersDelete: { id: string }
  charactersApply: { id: string }
  charactersRemove: { id: string }
  subagentToolPolicy: { policy?: unknown } | undefined
  subagentToolPolicyPreview: { tool?: string; description?: string; prompt?: string; tool_profile?: string; character_id?: string; task_type?: string; additional_tools?: string[]; restrict_tools?: string[] }
  toolSurface: { sessionId: string }
}

/** settings descriptor 的跨端最小结构。 */
export interface BridgeSettingsView {
  ns: string
  value: unknown
  base?: unknown
  revision: number
}

/** 端点级响应 value 契约（value 字段形状；扩展字段仍以 value 旁可选字段出现）。 */
export interface BridgeValueMap {
  meta: { meta: Record<string, unknown> }
  bootstrap: BridgeSettingsView
  describe: BridgeSettingsView
  models: { modelCatalog: Record<string, string[]> }
  mutate: BridgeSettingsView
  configsValidate: { valid: boolean; errors: Array<{ index: number; id: string; message: string }>; configs?: unknown[]; files?: unknown[] }
  skillFix: { folder: string; fixedFolder: string; name: string; actions: string[] }
  skillsImport: { path: string; count: number }
  templates: { templates?: unknown[]; toolTemplates?: unknown[] }
  promptConfigs: { promptConfigs: unknown[] }
  presetContent: Record<string, unknown>
  importPreset: { scopes: Array<'preset' | 'agents'> }
  paramOverrides: { overrides?: Record<string, unknown>; promptConfigs?: unknown[] }
  presetVariables: { variables: Record<string, string>; enabled: boolean }
  customTools: { customTools?: unknown[] }
  importPresetPackage: { id: string }
  exportPreset: { id: string; name: string; content: string }
  presetDelete: { id: string }
  presetClone: { id: string }
  presetDuplicate: { id: string }
  presetOpen: { path: string }
  charactersImport: { id: string; name: string }
  charactersImportStream: { id: string; name: string }
  charactersList: { characters: Array<{ id: string; name: string; description?: string; hasAvatar: boolean; imported: boolean }> }
  charactersDelete: { id: string }
  charactersApply: { id: string; count: number }
  charactersRemove: { id: string; count: number }
  subagentToolPolicy: { policy: unknown; defaultProfile?: string; errors?: string[] }
  subagentToolPolicyPreview: { result: unknown; errors?: string[] }
  toolSurface: { tools: Array<{ name: string; description: string }> }
}
/** 编译期断言：请求/响应映射与 BRIDGE_ENDPOINTS 键集合完全一致（漏改任一侧 typecheck 失败）。 */
type AssertCoverage<K extends string, M extends object> =
  Exclude<K, keyof M> extends never
    ? Exclude<keyof M, K> extends never ? true : false
    : false
type _requestCoverage = AssertCoverage<keyof typeof BRIDGE_ENDPOINTS, BridgeRequestMap>
type _responseCoverage = AssertCoverage<keyof typeof BRIDGE_ENDPOINTS, BridgeValueMap>
