/**
 * 引擎行为参数键（按预设存储：激活预设 preset.yml 的 layerSettings + promptConfigs）。
 * 不进 Config schema、不进 settings namespace——每预设一份，随预设走（官方范式：
 * Config = 部署轴，引擎行为在预设文件）。
 *
 * = ENGINE_PARAM_KEYS（唯一权威）+ promptConfigs，不再有旁路键清单。
 * 锚定/引导内容键（buildPattern、complexPattern、firstTurnBuild 等）已并入
 * ENGINE_PARAM_DEFINITIONS：它们本来就被 writePreset 映射进 near-anchor / router-guide
 * 的 promptConfig params，只挂在白名单里会让保存链「白名单接受、值校验拒绝」永久断层。
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
