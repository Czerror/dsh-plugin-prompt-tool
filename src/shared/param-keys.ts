/**
 * 引擎行为参数键（按预设存储：激活预设 preset.yml 的 params + promptConfigs）。
 * 不进 Config schema、不进 settings namespace——每预设一份，随预设走（官方范式：
 * Config = 部署轴，引擎行为在预设文件）。
 *
 * 派生自 ENGINE_PARAM_KEYS（唯一权威）+ 少量附加键：
 *  - 锚定/引导内容键：writePreset 映射进 near-anchor/router-guide 的 promptConfig
 *    params（策略消费），参与参数读回与 settings 写入拦截；
 *  - promptConfigs：settings 提示词配置数组键。
 * 注意：variables.yml 的占位键（spec.variables 空值登记，供世界书条目 {{key}} 动态
 * 引用）只读顶层 variables；本集合不再用于推断哪些 params 是模板变量。
 * 放 shared：config/settings-bridge 共用，单一来源。
 */
import { ENGINE_PARAM_KEYS } from './engine-params.ts'

const EXTRA_PARAM_KEYS = [
  // 锚定/引导内容键：writePreset 映射进 near-anchor/router-guide 的 promptConfig
  // params（策略消费），与顶层 variables 独立。
  'buildPattern', 'complexPattern', 'firstTurnBuild', 'firstTurnInspect', 'firstTurnDeep',
  'guideWeak', 'guideDeep',
  'promptConfigs',
] as const

export const PARAM_KEYS: ReadonlySet<string> = new Set([...ENGINE_PARAM_KEYS, ...EXTRA_PARAM_KEYS])

