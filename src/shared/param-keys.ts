/**
 * 引擎行为参数键（按预设存储：激活预设 preset.yml 的 params + promptConfigs）。
 * 不进 Config schema、不进 settings namespace——每预设一份，随预设走（官方范式：
 * Config = 部署轴，引擎行为在预设文件）。
 *
 * 派生自 ENGINE_PARAM_KEYS（唯一权威）+ 少量附加键：
 *  - 锚定/引导内容键：writePreset 映射进 near-anchor/router-guide 的 promptConfig
 *    params（策略消费），须排除出 variables.yml（避免同一键双落盘为模板变量）；
 *  - promptConfigs：settings 提示词配置数组键。
 * 注意：variables.yml 的占位键（spec.variables 空值登记，供世界书条目 {{key}} 动态
 * 引用）走另一套通道，不属于 PARAM_KEYS——两套体系不互串。
 * 放 shared：host（write-preset）与 config/settings-bridge 共用，单一来源。
 */
import { ENGINE_PARAM_KEYS } from './engine-params.ts'

const EXTRA_PARAM_KEYS = [
  // 锚定/引导内容键：writePreset 映射进 near-anchor/router-guide 的 promptConfig
  // params（策略消费），须排除出 variables.yml（避免同一键双落盘为模板变量）。
  'buildPattern', 'complexPattern', 'firstTurnBuild', 'firstTurnInspect', 'firstTurnDeep',
  'guideWeak', 'guideDeep',
  'promptConfigs',
] as const

export const PARAM_KEYS: ReadonlySet<string> = new Set([...ENGINE_PARAM_KEYS, ...EXTRA_PARAM_KEYS])

