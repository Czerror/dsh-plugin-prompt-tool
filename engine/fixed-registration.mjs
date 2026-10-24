/**
 * 「固定注册效果」判据的唯一实现：只有 `system-section` 层的 `complete` /
 * `suppressRuntimeContext` 是注册期效果（无逐轮求值时机）。其他层写同名键是死配置。
 * `layer` 是声明缺省层——config 可能省略 layer，回退规则与
 * `injectionConfigSpec` 的 `config.layer ?? rule.layer ?? 'pre-step'` 一致。
 */
import { record } from './record.mjs'

export function isFixedRegistration(config, layer) {
  return record(config) && (config.layer ?? layer) === 'system-section'
    && (config.params?.complete === true || config.params?.suppressRuntimeContext === true)
}
