/**
 * 预设 id 安全化的共享常量（host 与 client 共用）。
 *
 * 宿主 agent-presets 会扫描多个根，shipped（内置，随发行包分发）根排在最前、用户根在最后，
 * 且「靠前的根赢同名 id」：用户预设根里与内置同名的目录永远不会被挂载。插件因此必须避免
 * 用这些 id 作为生成/激活的预设目录名。判定与探测见 host/preset-id-safety.ts。
 */

/** 与宿主内置预设重名时，插件改用/生成的安全 id 前缀（`standard` → `pt-standard`）。 */
export const SAFE_PRESET_PREFIX = 'pt-'

/** 默认激活预设 id：`standard` 会被内置同名预设遮蔽，故默认值本身就用安全 id。 */
export const DEFAULT_PRESET_ID = `${SAFE_PRESET_PREFIX}standard`
