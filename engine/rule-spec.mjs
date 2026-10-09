/** module.yml.rules 的唯一运行时编译入口。旧声明仅由离线迁移器读取。 */
import { ACTION_KINDS, actionExecutionPoint, prepareAction, validateActionOptions } from './actions/index.mjs'
import { compileWhen, PREDICATE_FACTORIES, COMPOSITE_OPERATORS, channelTextSubjects } from './conditions/index.mjs'
import { createPromptConfigs, KNOWN_LAYERS } from './schema.mjs'
import { WATERFALL_POSITIONS } from './trigger.mjs'
import { ACTION_EXAMPLES } from './actions/examples.mjs'
import { PREDICATE_EXAMPLES } from './conditions/examples.mjs'
import { conjunction, expandActions } from './branch.mjs'

/** 规则字段：只有 `if`/`then`/`else`；旧名 `when`/`do` 留在名单里，只为把 unknown fields 换成一句「已退役，改用 X」。 */
const RULE_FIELDS = new Set(['id', 'name', 'enabled', 'layer', 'group', 'exclusive', 'if', 'then', 'else', 'when', 'do'])
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const nonempty = value => typeof value === 'string' && value.trim().length > 0

/**
 * 条件树引用的全部 `text` subject（含组合与否定）；`undefined` = 作者漏写 subject。
 * 树是数据，只能在校验期读——`compileWhen` 的产物把 subject 关进闭包，读不回来。
 */
function textSubjects(node, out = []) {
  if (!record(node)) return out
  for (const [key, value] of Object.entries(node)) {
    if (key === 'text' && record(value)) out.push(value.subject)
    else if (key === 'not') textSubjects(value, out)
    else if ((key === 'all' || key === 'any' || key === 'notAny') && Array.isArray(value)) {
      for (const child of value) textSubjects(child, out)
    }
  }
  return out
}

/**
 * **只用于动作级条件**：动作的判定绑定单一执行点，subject 写错通道等于该动作永不执行，
 * 而挂载与运行期都不报错（`availability.mjs` 对通道取不到的字段返回 UNAVAILABLE，
 * `condition.mjs#subjectTextOf` 取不到一律空串）。规则级 `if` 相反：它在该规则每个动作的
 * 执行点上各自求值，「缺事实即不执行」是三值语义的设计意图（见 `test/engine/rules.test.mjs`
 * 的缺事实用例），因此编译期不拒绝。
 */
function assertTextSubject(subject, allowed, label) {
  if (subject === undefined) {
    throw new TypeError(`${label}: text needs an explicit subject — 省略时判定恒为「缺事实」，规则永不命中`)
  }
  if (!allowed.includes(subject)) {
    throw new TypeError(
      `${label}: text subject ${JSON.stringify(subject)} is unavailable at this execution point`
      + ` — 本执行点可用 ${allowed.length > 0 ? allowed.join(', ') : '（无）'}；写死条件不会命中`,
    )
  }
}

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
    if (!neutral) throw new TypeError(`action ${action.id}: ${inject ? 'config.' : ''}${field} is a legacy gate; move it to rule.if`)
    delete target[field]
  }
}

/** 注册制层：内容在 agent 装配时注册一次，没有逐轮求值时机，因此不接受分支条件。 */
const REGISTRATION_LAYERS = new Set(['system-section', 'runtime-context'])

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
    // 旧名已按引擎重构退役：显式拒绝并给出新名，比 "unknown fields" 更可直接照做。
    if (spec.when !== undefined) throw new TypeError(`rule ${spec.id}: "when" 已退役，改用 "if"`)
    if (spec.do !== undefined) throw new TypeError(`rule ${spec.id}: "do" 已退役，改用 "then"`)
    const ruleIf = spec.if
    // 规则级 `if` 跨执行点各自求值，不在这里判定（见 assertTextSubject 的说明）；
    // 这份 subject 集合只用来跳过 `else` 注入进动作条件的 `not(if)` 节点。
    const ruleSubjects = new Set(textSubjects(ruleIf))
    const ruleThen = spec.then
    if (!Array.isArray(ruleThen) || ruleThen.length === 0) throw new TypeError(`rule ${spec.id}.then must be a non-empty array`)
    const sequence = options.configOrder?.[spec.id] ?? index * 10
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw new TypeError(`rule ${spec.id}: invalid configOrder`)
    const when = compileWhen(ruleIf, options)
    // 规则级 `if` 由 `rule.when` 判定，then 分支的动作不再重复叠加它；规则级 `else` 的动作
    // 自带 `not(if)` 并标记跳过规则级判定——否则两者自相矛盾，else 分支永远不会执行。
    const expanded = [
      ...expandActions(ruleThen, {}, `rule ${spec.id}.then`),
      ...(spec.else === undefined ? [] : expandActions(spec.else, {
        outer: ruleIf === undefined ? [] : [{ not: ruleIf }],
        bypass: true,
      }, `rule ${spec.id}.else`)),
    ]
    const actionIds = new Set()
    const actions = expanded.map(({ node: source, conditions, bypass }, actionIndex) => {
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
      // 动作级条件只在本动作的执行点求值：subject 必须由该通道真实提供。规则级注入进来的
      // 节点（`then` 分支条件的 outer、`else` 的 `not(if)`）已按并集判定，此处跳过。
      const actionConditions = conjunction(conditions)
      for (const subject of textSubjects(actionConditions)) {
        if (!ruleSubjects.has(subject)) {
          assertTextSubject(subject, channelTextSubjects(execution.channel), `rule ${spec.id}: action ${action.id}`)
        }
      }
      // 空条件数组经 conjunction → undefined → compileWhen 直接返回 undefined（无条件动作）。
      const actionWhen = compileWhen(actionConditions, options)
      const branchLayer = action.kind === 'inject-text' ? action.config.layer : spec.layer ?? 'pre-step'
      if (actionWhen !== undefined && (REGISTRATION_LAYERS.has(branchLayer) || execution.lifecycle === 'registration')) {
        throw new TypeError(`action ${action.id}: layer ${branchLayer} has no per-turn evaluation point — move the branch to pre-step / subagent-* / tool-pipeline / turn-stop`)
      }
      return Object.assign(action, { execution, channelOrder, waterfallPosition, actionIndex, actionWhen, bypassRuleWhen: bypass })
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
    const action = compileRules([{ id: kind, then: [{ ...example, id: 'example' }] }])[0].actions[0]
    return { kind, example, channel: action.execution.channel, phase: action.execution.phase, lifecycle: action.execution.lifecycle, supportsWhen: action.execution.lifecycle === 'event' }
  })
  return { predicates, actions, composites: [...COMPOSITE_OPERATORS], waterfallPositions: [...WATERFALL_POSITIONS] }
}
