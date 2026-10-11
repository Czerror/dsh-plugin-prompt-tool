/**
 * 引擎行为参数键（按模块存储：激活模块 module.yml 的 layerSettings + promptConfigs）。
 * 不进 Config schema、不进 settings namespace——每模块一份，随模块走（官方范式：
 * Config = 部署轴，引擎行为在 module.yml）。
 *
 * = ENGINE_PARAM_KEYS + promptConfigs。
 * 注意：variables.yml 的占位键（spec.variables 空值登记，供世界书条目 {{key}} 动态
 * 引用）只读顶层 variables；本集合不再用于推断哪些 params 是模板变量。
 * 放 shared：config/settings-bridge 共用，单一来源。
 */
import { ENGINE_PARAM_KEYS } from './engine-params.ts'

const EXTRA_PARAM_KEYS = [
  // 提示词配置数组：settings 载荷键，不是引擎行为参数。
  'promptConfigs',
] as const

export const PARAM_KEYS: ReadonlySet<string> = new Set([...ENGINE_PARAM_KEYS, ...EXTRA_PARAM_KEYS])
