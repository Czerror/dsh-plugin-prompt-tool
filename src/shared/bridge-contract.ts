/**
 * settings bridge 跨端契约（host 注册 / client 消费的唯一来源）。
 * 铁律：11 端点载荷统一成功 `{ ok: true, value }`、失败 `{ ok: false, code?, message? }`；
 * 端点附加字段只能以 value 旁的可选扩展字段出现（describe）。
 * 改路径或载荷形状必须同步更新 test/shared/bridge-contract.test.mjs。
 */
export const SETTINGS_BRIDGE_PREFIX = '/api/prompt-tool/settings'

/** 22 个桥端点路径（相对前缀）。新增端点必须同时登记到契约测试。 */
export const BRIDGE_ENDPOINTS = {
  meta: '/meta',
  describe: '/describe',
  models: '/models',
  mutate: '/mutate',
  configsValidate: '/configs-validate',
  skillFix: '/skill-fix',
  templates: '/templates',
  promptConfigs: '/prompt-configs',
  presetContent: '/preset-content',
  importPreset: '/import-preset',
  paramOverrides: '/param-overrides',
  presetVariables: '/preset-variables',
  importPresetPackage: '/import-preset-package',
  exportPreset: '/export-preset',
  presetDelete: '/preset-delete',
  presetClone: '/preset-clone',
  presetDuplicate: '/preset-duplicate',
  presetOpen: '/preset-open',
  charactersImport: '/characters-import',
  charactersList: '/characters-list',
  charactersDelete: '/characters-delete',
  charactersApply: '/characters-apply',
  charactersRemove: '/characters-remove',
} as const

export type BridgeEndpoint = (typeof BRIDGE_ENDPOINTS)[keyof typeof BRIDGE_ENDPOINTS]

/** 失败载荷：两端共用。 */
export type BridgeErrorPayload = { ok: false; code?: string; message?: string }
