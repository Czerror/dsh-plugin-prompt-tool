/** module.yml.rules 的唯一运行时编译入口。旧声明仅由离线迁移器读取。 */
import { ACTION_KINDS, actionExecutionPoint, prepareAction, validateActionOptions } from './actions/index.mjs'
import { compileWhen, PREDICATE_FACTORIES, COMPOSITE_OPERATORS } from './conditions/index.mjs'
import { createPromptConfigs, KNOWN_LAYERS } from './schema.mjs'
import { WATERFALL_POSITIONS } from './trigger.mjs'
import { ACTION_EXAMPLES } from './actions/examples.mjs'
import { PREDICATE_EXAMPLES } from './conditions/examples.mjs'

const RULE_FIELDS = new Set(['id', 'name', 'enabled', 'layer', 'group', 'exclusive', 'when', 'do'])
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const nonempty = value => typeof value === 'string' && value.trim().length > 0

/** 规则及物化身份的唯一安全边界；host 保存、导入与直接编译共用。 */
export function assertRuleId(id) {
  if (!nonempty(id)) throw new TypeError('rule id must be a non-empty string')
  if (id === '.' || id === '..') throw new TypeError(`rule id ${JSON.stringify(id)} must not be a dot directory`)
  const reserved = '/\\\0:*?"<>|'
  for (const char of reserved) if (id.includes(char)) throw new TypeError(`rule id ${JSON.stringify(id)} contains path separators or reserved filename characters`)
  for (let index = 0; index < id.length; index++) if (id.charCodeAt(index) < 0x20) throw new TypeError(`rule id ${JSON.stringify(id)} contains control characters`)
}

/** 注入叶子的唯一身份投影；稳定动作 id 保证重排不改变投递身份。 */
export function injectionConfigSpec(rule, action, options = {}) {
  if (action?.kind !== 'inject-text' || !record(action.config)) throw new TypeError('inject-text config must be an object')
  const config = { ...action.config, id: action.config.id ?? `rule:${encodeURIComponent(rule.id)}:${encodeURIComponent(action.id)}`, layer: action.config.layer ?? rule.layer ?? 'pre-step' }
  const variables = record(options.variables) ? options.variables : {}
  if (options.variablesEnabled === false) {
    const keys = new Set(Object.keys(variables))
    const strip = text => typeof text === 'string' ? text.replace(/\{\{([A-Za-z0-9_.\u4e00-\u9fff-]+)\}\}/g, (match, key) => keys.has(key) ? '' : match) : text
    if (config.text !== undefined) config.text = strip(config.text)
    if (Array.isArray(config.texts)) config.texts = config.texts.map(strip)
    if (record(config.params) && typeof config.params.text === 'string') config.params = { ...config.params, text: strip(config.params.text) }
  } else config.variables = { ...variables, ...(record(config.variables) ? config.variables : {}) }
  return config
}

/** 非空同组任一成员声明互斥，整组最多允许一条 enabled；运行时不替作者选赢家。 */
export function validateRuleGroups(rules) {
  const groups = new Map()
  for (const rule of rules) {
    if (!nonempty(rule.group)) continue
    const group = groups.get(rule.group) ?? []; group.push(rule); groups.set(rule.group, group)
  }
  for (const [name, group] of groups) {
    if (group.some(rule => rule.exclusive === true) && group.filter(rule => rule.enabled !== false).length > 1) {
      throw new TypeError(`rules: exclusive group ${JSON.stringify(name)} has multiple enabled rules`)
    }
  }
}

export function ruleActionExecution(action) {
  const fixed = action.kind === 'guard' || (action.kind === 'inject-text'
    && (action.config?.params?.complete === true || action.config?.params?.suppressRuntimeContext === true))
  return { ...actionExecutionPoint(action), lifecycle: fixed ? 'registration' : 'event' }
}

/** 通用门只属于 when；固定系统段的 audience 保留为注册目标。 */
function normalizeActionGates(action, execution) {
  const inject = action.kind === 'inject-text'
  if (!inject && action.kind !== 'request-params') return
  const target = inject ? action.config : action
  if (inject) {
    if (target.enabled !== undefined && target.enabled !== true) throw new TypeError(`action ${action.id}: move config.enabled to rule.enabled`)
    delete target.enabled
  }
  const fields = inject ? ['audience', 'modelScope', 'promotion', 'subject', 'match'] : ['audience', 'modelScope']
  for (const field of fields) {
    const value = target[field]
    if (inject && field === 'audience' && target.layer === 'system-section' && execution.lifecycle === 'registration' && ['main', 'subagent'].includes(value)) continue
    const neutral = value == null || value === '' || (field === 'modelScope' && value === 'all') || (field === 'promotion' && value === 'none')
    if (!neutral) throw new TypeError(`action ${action.id}: ${inject ? 'config.' : ''}${field} is a legacy gate; move it to rule.when`)
    delete target[field]
  }
}

/** options.promptConfigOptions 拥有模板/策略路径；configOrder 使用规则 id，moduleId 只标记来源。 */
export function compileRules(specs, options = {}) {
  if (!Array.isArray(specs)) throw new TypeError('rules must be an array')
  const ids = new Set()
  const pendingConfigs = []
  const moduleId = options.moduleId ?? options.sourceModuleId
  const rules = specs.map((spec, index) => {
    if (!record(spec)) throw new TypeError(`rules[${index}] must be an object`)
    const unknown = Object.keys(spec).filter(key => !RULE_FIELDS.has(key))
    if (unknown.length) throw new TypeError(`rules[${index}] unknown fields: ${unknown.join(', ')}`)
    assertRuleId(spec.id)
    if (ids.has(spec.id)) throw new TypeError(`rules: duplicate id ${spec.id}`)
    ids.add(spec.id)
    for (const key of ['enabled', 'exclusive']) if (spec[key] !== undefined && typeof spec[key] !== 'boolean') throw new TypeError(`rule ${spec.id}.${key} must be boolean`)
    for (const key of ['name', 'group']) if (spec[key] !== undefined && typeof spec[key] !== 'string') throw new TypeError(`rule ${spec.id}.${key} must be string`)
    if (spec.layer !== undefined && !KNOWN_LAYERS.has(spec.layer)) throw new TypeError(`rule ${spec.id}: unknown layer ${spec.layer}`)
    if (!Array.isArray(spec.do) || spec.do.length === 0) throw new TypeError(`rule ${spec.id}.do must be a non-empty array`)
    const sequence = options.configOrder?.[spec.id] ?? index * 10
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw new TypeError(`rule ${spec.id}: invalid configOrder`)
    const when = compileWhen(spec.when, options)
    const actionIds = new Set()
    const actions = spec.do.map((source, actionIndex) => {
      if (!record(source) || !nonempty(source.id)) throw new TypeError(`rule ${spec.id}: action id must be non-empty`)
      if (actionIds.has(source.id)) throw new TypeError(`rule ${spec.id}: duplicate action id ${source.id}`)
      actionIds.add(source.id)
      if (!Object.hasOwn(ACTION_KINDS, source.kind)) throw new TypeError(`rule ${spec.id}: unknown action ${source.kind}`)
      const action = structuredClone(source)
      if (action.kind === 'inject-text') {
        action.config = injectionConfigSpec(spec, action, options)
        if (action.config.strategy === 'custom-fallback') throw new TypeError(`action ${action.id}: migrate custom-fallback to an anchor condition and anchor-notice content`)
      }
      const execution = ruleActionExecution(action)
      normalizeActionGates(action, execution)
      const channelOrder = action.channelOrder ?? sequence
      if (!Number.isSafeInteger(channelOrder) || channelOrder < 0) throw new TypeError(`action ${action.id}: channelOrder must be a non-negative safe integer`)
      const waterfallPosition = action.waterfallPosition ?? 'default'
      if (!WATERFALL_POSITIONS.has(waterfallPosition)) throw new TypeError(`action ${action.id}: invalid waterfallPosition`)
      if (execution.lifecycle === 'registration' && (when !== undefined || waterfallPosition !== 'default')) throw new TypeError(`action ${action.id}: registration effects do not support when or waterfall positioning`)
      if (action.kind === 'inject-text' && waterfallPosition !== 'default') throw new TypeError(`action ${action.id}: inject-text placement belongs to its official layer, not waterfallPosition`)
      if (action.kind === 'inject-text') {
        validateActionOptions(action)
        if (!record(action.config)) throw new TypeError(`action ${action.id}: config must be an object`)
        // 原始声明保持不变；稳定动作身份只在未提供正文身份时补入运行时编译输入。
        pendingConfigs.push({ action, source: { ...action.config, id: action.config.id ?? `${spec.id}:${action.id}` }, sequence: channelOrder, ruleId: spec.id, actionIndex })
      } else prepareAction(action, { promptConfigOptions: options.promptConfigOptions })
      return Object.assign(action, { execution, channelOrder, waterfallPosition, actionIndex })
    })
    const pointOrders = new Map()
    for (const action of actions) {
      const key = `${action.execution.channel}:${action.execution.phase}:${action.waterfallPosition}`
      const previous = pointOrders.get(key)
      if (previous !== undefined && previous.channelOrder !== action.channelOrder) throw new TypeError(`rule ${spec.id}: conflicting channelOrder for actions ${previous.id} and ${action.id} at ${key}`)
      pointOrders.set(key, action)
    }
    return { id: spec.id, name: spec.name, layer: spec.layer, group: spec.group, exclusive: spec.exclusive === true, enabled: spec.enabled !== false, sequence, when, actions, promptConfigOptions: options.promptConfigOptions }
  })
  validateRuleGroups(rules)
  const complete = rules.filter(rule => rule.enabled).flatMap(rule => rule.actions).filter(action => action.config?.params?.complete === true)
  if (complete.length > 1 || (complete.length > 0 && options.personaComplete === true)) throw new TypeError('rules: multiple complete system sections are active')
  if (pendingConfigs.length) {
    const compiled = createPromptConfigs(pendingConfigs.map(item => item.source), { ...options.promptConfigOptions, ...(moduleId === undefined ? {} : { sourceModuleId: moduleId }) })
    const byId = new Map(compiled.map(config => [config.id, config]))
    for (const item of pendingConfigs) {
      const config = byId.get(item.source.id)
      Object.assign(config, { sequence: item.sequence, ruleId: item.ruleId, ruleActionIndex: item.actionIndex })
      item.action.compiledConfig = config
    }
  }
  return rules
}

export function getRuleEditorMeta() {
  const predicates = Object.keys(PREDICATE_FACTORIES).map(kind => ({ kind, example: { [kind]: structuredClone(PREDICATE_EXAMPLES[kind]) } }))
  for (const kind of COMPOSITE_OPERATORS) {
    const child = { phase: { promoted: false } }
    predicates.push({ kind, example: { [kind]: kind === 'not' ? child : [child] } })
  }
  for (const { example } of predicates) compileWhen(example)
  const actions = Object.keys(ACTION_KINDS).map(kind => {
    const example = { kind, ...structuredClone(ACTION_EXAMPLES[kind]) }
    // 新规则的投递身份由稳定 rule/action id 派生；迁移的显式 config.id 仍保留。
    if (kind === 'inject-text') delete example.config.id
    const action = compileRules([{ id: kind, do: [{ ...example, id: 'example' }] }])[0].actions[0]
    return { kind, example, channel: action.execution.channel, phase: action.execution.phase, lifecycle: action.execution.lifecycle, supportsWhen: action.execution.lifecycle === 'event' }
  })
  return { predicates, actions, composites: [...COMPOSITE_OPERATORS], waterfallPositions: [...WATERFALL_POSITIONS] }
}
