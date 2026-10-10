/** 提示词配置 → 规则的纯构造函数：外部导入（SillyTavern / 角色卡 / 世界书）与卡片创建共用，运行时不调用。 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseDocument } from 'yaml'
import type { RuleAction, RuleCondition, RuleDefinition } from '../shared/rules.ts'
import type { PromptConfigSpec } from './prompt-configs.ts'
import { packageEngineDir } from './manifest.ts'
// @ts-expect-error 与旧条件层的缺省匹配对象同源。
import { LAYER_DEFAULT_SUBJECT } from '../../engine/schema.mjs'
// @ts-expect-error 「固定注册效果」判据只在引擎实现一份。
import { isFixedRegistration } from '../../engine/rule-spec.mjs'

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const condition = (items: RuleCondition[]): RuleCondition | undefined => items.length === 0 ? undefined : items.length === 1 ? items[0] : { all: items }

/** 旧业务参数快照的读取与补全：ST／角色卡导入的旧填充器需要它补旧条件默认与指令提示策略。 */
export interface LegacyPolicyDefaults {
  fillers: { envFacts: { text: string }; skillCatalog: { text: string; params: Record<string, unknown> } }
  instructionHint: Record<string, string>
  promotionGate: Record<string, string>
  customFallback: { fallbackAfter: number }
}
/** 旧非空行为由显式模板快照保存，转换器不再持有另一份业务文案。 */
export function legacyPolicyDefaults(): LegacyPolicyDefaults {
  const file = join(dirname(packageEngineDir()), 'templates', 'policies', 'legacy-defaults.yml')
  const doc = parseDocument(readFileSync(file, 'utf8'), { logLevel: 'silent' })
  if (doc.errors.length > 0) throw new Error(`旧业务策略模板无法解析：${doc.errors[0]!.message}`)
  const value: unknown = doc.toJS()
  if (!record(value) || value.version !== 1 || !record(value.fillers) || !record(value.fillers.envFacts)
    || typeof value.fillers.envFacts.text !== 'string' || !record(value.fillers.skillCatalog)
    || typeof value.fillers.skillCatalog.text !== 'string' || !record(value.fillers.skillCatalog.params)
    || !record(value.instructionHint) || !record(value.promotionGate) || !record(value.customFallback)
    || !Number.isSafeInteger(value.customFallback.fallbackAfter)) throw new Error('旧业务策略模板形状无效')
  const { instructionHint, promotionGate } = value
  if (['projectTemplate', 'globalTemplate', 'suffixTemplate', 'messageTemplate'].some(key => typeof instructionHint[key] !== 'string')
    || ['reasoningPattern', 'reasoningNegativePattern', 'reasoningFlags'].some(key => typeof promotionGate[key] !== 'string')) throw new Error('旧业务策略模板形状无效')
  return value as unknown as LegacyPolicyDefaults
}

export function fillMissing(target: Record<string, unknown>, defaults: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(defaults)) if (!Object.hasOwn(target, key)) target[key] = structuredClone(value)
}

/** 只处理已登记填充器字段；显式空正文、空参数及外部模板归原作者。 */
function migrateFillerDefaults(config: PromptConfigSpec): PromptConfigSpec {
  if (config.strategy !== 'placeholder' || !['env-facts', 'skill-catalog', 'instruction-hint'].includes(config.fill ?? '')) return config
  const next = structuredClone(config)
  const params = { ...next.params }
  const bodyDeclared = Object.hasOwn(next, 'text') || Object.hasOwn(next, 'texts') || Object.hasOwn(params, 'text')
  if (typeof next.templateFile === 'string' && next.templateFile.length > 0) throw new Error(`动态填充规则 ${next.id} 的正文或参数来自外部模板，须先显式展开再迁移，不能猜测旧默认行为`)
  const defaults = legacyPolicyDefaults()
  if (config.fill === 'env-facts') {
    if (!bodyDeclared) next.text = defaults.fillers.envFacts.text
  } else if (config.fill === 'skill-catalog') {
    if (!bodyDeclared) next.text = defaults.fillers.skillCatalog.text
    fillMissing(params, defaults.fillers.skillCatalog.params)
  } else if (!bodyDeclared && !(typeof params.file === 'string' && params.file.trim().length > 0)) {
    fillMissing(params, Object.fromEntries(['projectTemplate', 'globalTemplate', 'suffixTemplate'].map(key => [key, defaults.instructionHint[key]])))
  }
  if (Object.keys(params).length > 0) next.params = params
  return next
}

/** 可供外部导入/模板创建复用的纯转换；既有投递身份、策略和官方位置原样保留。 */
export function promptConfigToRule(config: PromptConfigSpec): RuleDefinition {
  if (!record(config) || typeof config.id !== 'string' || config.id.length === 0) throw new TypeError('旧提示词配置必须有 id')
  config = migrateFillerDefaults(config)
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
  if (config.strategy === 'custom-fallback') {
    const rawWords = config.params?.anchorWords
    const first = config.params?.firstTurnWord
    const keys = Array.isArray(rawWords) && rawWords.length > 0 ? rawWords.map(String).filter(word => word.length > 0)
      : typeof first === 'string' && first.length > 0 ? [first] : []
    gates.push({ anchor: { keys, fallbackAfter: legacyPolicyDefaults().customFallback.fallbackAfter } })
    payload.strategy = 'anchor-notice'
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
