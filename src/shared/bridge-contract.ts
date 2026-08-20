/**
 * settings bridge 跨端契约（host 注册 / client 消费的唯一来源）。
 * 铁律：8 端点载荷统一成功 `{ ok: true, value }`、失败 `{ ok: false, code?, message? }`；
 * 端点附加字段只能以 value 旁的可选扩展字段出现（describe / import-directory）。
 * 改路径或载荷形状必须同步更新 test/shared/bridge-contract.test.mjs。
 */
export const SETTINGS_BRIDGE_PREFIX = '/api/prompt-tool/settings'

/** 8 个桥端点路径（相对前缀）。新增端点必须同时登记到契约测试。 */
export const BRIDGE_ENDPOINTS = {
  meta: '/meta',
  describe: '/describe',
  mutate: '/mutate',
  restoreOriginals: '/restore-originals',
  configsValidate: '/configs-validate',
  importDirectory: '/import-directory',
  skillFix: '/skill-fix',
  templates: '/templates',
  promptConfigs: '/prompt-configs',
  presetContent: '/preset-content',
  importPreset: '/import-preset',
  paramOverrides: '/param-overrides',
} as const

export type BridgeEndpoint = (typeof BRIDGE_ENDPOINTS)[keyof typeof BRIDGE_ENDPOINTS]

/** 失败载荷：两端共用。 */
export type BridgeErrorPayload = { ok: false; code?: string; message?: string }
