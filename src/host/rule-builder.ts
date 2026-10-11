/** 提示词配置 → 规则的纯构造函数：外部导入（SillyTavern / 角色卡 / 世界书）与卡片创建共用，运行时不调用。 */
import type { RuleAction, RuleCondition, RuleDefinition } from '../shared/rules.ts'
import type { PromptConfigSpec } from './prompt-configs.ts'
// @ts-expect-error 与旧条件层的缺省匹配对象同源。
import { LAYER_DEFAULT_SUBJECT } from '../../engine/schema.mjs'
// @ts-expect-error 「固定注册效果」判据只在引擎实现一份。
import { isFixedRegistration } from '../../engine/rule-spec.mjs'

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const condition = (items: RuleCondition[]): RuleCondition | undefined => items.length === 0 ? undefined : items.length === 1 ? items[0] : { all: items }

/** 可供外部导入/模板创建复用的纯转换；既有投递身份、策略和官方位置原样保留。 */
export function promptConfigToRule(config: PromptConfigSpec): RuleDefinition {
  if (!record(config) || typeof config.id !== 'string' || config.id.length === 0) throw new TypeError('旧提示词配置必须有 id')
  // 退役策略在入口拒绝：引擎侧本就不认它，静默转换只会产出必然被拒的规则。
  if (config.strategy === 'custom-fallback') {
    throw new TypeError(`规则 ${config.id} 的 custom-fallback 策略已退役：请改写为 anchor 条件 + anchor-notice 内容`)
  }
  const layer = config.layer ?? 'pre-step'
  const fixed = isFixedRegistration(config, layer)
  const gates: RuleCondition[] = []
  const payload = structuredClone(config) as PromptConfigSpec & Record<string, unknown>
  for (const key of ['name', 'enabled', 'group', 'exclusive', 'sequence', 'fieldSources', 'origin']) delete payload[key]
  payload.layer = layer
  // 只在离线/导入旧格式时显式记录旧业务阈值；新规则没有引擎内建长度默认。
  if (config.strategy === 'guide-auto' && !Object.hasOwn(config.params ?? {}, 'complexMinChars')) {
    payload.params = { ...payload.params, complexMinChars: 120 }
  }
  if (!fixed) {
    const scope = { ...(config.audience == null ? {} : { audience: config.audience }), ...(config.modelScope === undefined || config.modelScope === 'all' ? {} : { modelScope: config.modelScope }) }
    if (Object.keys(scope).length > 0) gates.push({ scope })
    if (config.promotion === 'main' || config.promotion === 'include-subagents') gates.push({ phase: { promoted: true, includeSubagents: config.promotion === 'include-subagents' } })
    if (config.match !== undefined) gates.push({ text: { ...config.match, subject: config.subject ?? LAYER_DEFAULT_SUBJECT[layer] } })
    for (const key of ['audience', 'modelScope', 'promotion', 'subject', 'match']) delete payload[key]
  }
  const text = [config.text, ...(config.texts ?? [])].filter((item): item is string => typeof item === 'string' && item.length > 0).join('\n\n')
  if (layer === 'tool-pipeline' && config.templateFile !== undefined && text.length === 0) throw new Error(`规则 ${config.id} 的工具结果来自模板，须先显式展开后迁移`)
  const actions: RuleAction[] = layer === 'agent-request'
    ? [{ id: 'request', kind: 'request-params', ...config.params, modelScope: 'all' }]
    : layer === 'tool-pipeline'
    ? [
        { id: 'before', kind: 'decision', phase: 'pre', decision: config.params?.preDecision ?? 'allow', ...(config.params?.toolNames === undefined ? {} : { toolNames: config.params.toolNames }), ...(config.params?.denyReason === undefined ? {} : { reason: config.params.denyReason }) },
        { id: 'after', kind: 'decision', phase: 'post', action: config.params?.postAction ?? 'accept', ...(config.params?.toolNames === undefined ? {} : { toolNames: config.params.toolNames }), text },
      ]
    : [{ id: 'inject', kind: 'inject-text', config: payload }]
  return { id: config.id, ...(config.name === undefined ? {} : { name: config.name }), ...(config.enabled === undefined ? {} : { enabled: config.enabled }), layer: layer as RuleDefinition['layer'],
    ...(config.group === undefined ? {} : { group: config.group }), ...(config.exclusive === undefined ? {} : { exclusive: config.exclusive }),
    ...(condition(gates) === undefined ? {} : { if: condition(gates) }), then: actions }
}
