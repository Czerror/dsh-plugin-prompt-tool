/** ST 转换出口的载荷构造：把一条转换中间产物包成 `inject-text` 规则。运行时不调用。 */
import type { RuleAction, RuleDefinition } from '../shared/rules.ts'
import type { PromptConfigSpec } from './prompt-configs.ts'

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

/** 这些是规则级字段，不进入动作 payload；层另写入 payload。 */
const RULE_LEVEL_KEYS = ['name', 'enabled', 'group', 'exclusive', 'sequence', 'fieldSources', 'origin'] as const

/** 退役策略在入口拒绝：引擎侧本就不认它，静默转换只会产出必然被拒的规则。 */
function assertConvertible(config: PromptConfigSpec): void {
  if (!record(config) || typeof config.id !== 'string' || config.id.length === 0) throw new TypeError('旧提示词配置必须有 id')
  if (config.strategy === 'custom-fallback') {
    throw new TypeError(`规则 ${config.id} 的 custom-fallback 策略已退役：请使用规则条件与 static 正文`)
  }
}

/** 可供外部导入复用的纯转换；投递身份、策略与官方位置原样保留。 */
export function promptConfigToRule(config: PromptConfigSpec): RuleDefinition {
  assertConvertible(config)
  const layer = config.layer ?? 'pre-step'
  const payload = structuredClone(config) as PromptConfigSpec & Record<string, unknown>
  for (const key of RULE_LEVEL_KEYS) delete payload[key]
  payload.layer = layer
  const inject: RuleAction = { id: 'inject', kind: 'inject-text', config: payload }
  return {
    id: config.id,
    layer: layer as RuleDefinition['layer'],
    ...(config.name === undefined ? {} : { name: config.name }),
    ...(config.enabled === undefined ? {} : { enabled: config.enabled }),
    ...(config.group === undefined ? {} : { group: config.group }),
    ...(config.exclusive === undefined ? {} : { exclusive: config.exclusive }),
    then: [inject],
  }
}
