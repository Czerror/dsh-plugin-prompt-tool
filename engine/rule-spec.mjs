/** module.yml.rules 的唯一运行时编译入口。旧声明仅由离线迁移器读取。 */
import { ACTION_KINDS, actionExecutionPoint, prepareAction, validateActionOptions } from './actions/index.mjs'
// 字段清单与动作声明同住 `actions/catalog.mjs`（`actions/index.mjs` 不再导出新面）。
import { ACTION_FIELDS, MATCH_ACTION_KINDS } from './actions/catalog.mjs'
import { compileWhen, PREDICATE_FACTORIES, COMPOSITE_OPERATORS, FACT_PREDICATE_SUBJECTS, channelFactSubjects, channelTextSubjects } from './conditions/index.mjs'
import { createPromptConfigs, INJECT_CONFIG_FIELDS, KNOWN_LAYERS, SESSION_VARIABLES_DISABLED, assertLlmCallPatch } from './schema.mjs'
import { stripDeclaredRefs } from './interpolate.mjs'
import { validateConfig } from './shared.mjs'
import { WATERFALL_POSITIONS } from './trigger.mjs'
import { ACTION_EXAMPLES } from './actions/examples.mjs'
import { PREDICATE_EXAMPLES } from './conditions/examples.mjs'
import { conjunction, expandActions } from './branch.mjs'

/** 规则字段：只有 `if`/`then`/`else`；旧名 `when`/`do` 留在名单里，只为把 unknown fields 换成一句「已退役，改用 X」。 */
const RULE_FIELDS = new Set(['id', 'name', 'enabled', 'layer', 'group', 'exclusive', 'if', 'then', 'else', 'when', 'do'])
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const nonempty = value => typeof value === 'string' && value.trim().length > 0

/** `prepend` 退役文案（动作层与 `inject-text.config` 共用）：等价档只有「注册到最外层」一档，而 `inject-text` 连它也不接受。 */
const PREPEND_RETIRED = '`prepend` 已取消 — 它是未文档化的注册后门（executor 直读 config.prepend），作用只有「注册到最外层」一档：非 inject-text 动作改用 `waterfallPosition: outermost`；`inject-text` 不接受该字段，没有等价写法'

/**
 * 条件树引用的全部「谓词 → 通道事实」对（含组合与否定）；`subject === undefined` = 作者漏写。
 * 树是数据，只能在校验期读——`compileWhen` 的产物把 subject 关进闭包，读不回来。
 * `text` 的 subject 由作者声明；事实谓词读的事实取自谓词侧的 `FACT_PREDICATE_SUBJECTS`
 * （唯一登记处，见 `conditions/subject.mjs`），本函数不再逐谓词手抄。
 */
function conditionSubjects(node, out = []) {
  if (!record(node)) return out
  for (const [key, value] of Object.entries(node)) {
    if (key === 'text' && record(value)) out.push({ predicate: 'text', subject: value.subject })
    else if (Object.hasOwn(FACT_PREDICATE_SUBJECTS, key)) out.push({ predicate: key, subject: FACT_PREDICATE_SUBJECTS[key] })
    else if (key === 'not') conditionSubjects(value, out)
    else if ((key === 'all' || key === 'any' || key === 'notAny') && Array.isArray(value)) {
      for (const child of value) conditionSubjects(child, out)
    }
  }
  return out
}

/**
 * **只用于动作级条件**：动作的判定绑定单一执行点，谓词要读的事实写错通道（或 `text` 省略
 * subject）等于该动作永不执行，而挂载与运行期都不报错（`availability.mjs` 对通道取不到的
 * 字段返回 UNAVAILABLE，`condition.mjs#subjectTextOf` 取不到一律空串）。规则级 `if` 相反：
 * 它在该规则每个动作的执行点上各自求值，「缺事实即不执行」是三值语义的设计意图（见
 * `test/engine/rules.test.mjs` 的缺事实用例），因此编译期不拒绝。
 */
function assertSubject(predicate, subject, allowed, label) {
  if (subject === undefined) {
    throw new TypeError(`${label}: ${predicate} needs an explicit subject — 省略时判定恒为「缺事实」，规则永不命中`)
  }
  if (!allowed.includes(subject)) {
    throw new TypeError(
      `${label}: ${predicate} subject ${JSON.stringify(subject)} is unavailable at this execution point`
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
    // 剥离复用插值语法（同一条 REFERENCE_RE）：花括号内空白与 `::参数` 形态也算引用。
    const strip = text => stripDeclaredRefs(text, keys)
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

/**
 * 「固定注册效果」判据的**唯一实现**：只有 `system-section` 层的 `complete` /
 * `suppressRuntimeContext` 是注册期效果（无逐轮求值时机）。其他层写同名键是死配置
 * ——`params` 不做键白名单（pre-step 的 params 承载策略参数），所以在 `compileRules`
 * 的逐动作校验里点名拒绝；装配兜底（agent-assembly）与写盘门控（settings-bridge）复用
 * 本谓词，避免各自再写一份「system-section 才算独占」。
 * 独占计数只认 `complete`：`suppressRuntimeContext` 不产生「多个 complete 段」冲突。
 * `layer` 是声明缺省层——装配兜底读的是原始声明，config 可能省略 layer，回退规则与
 * `injectionConfigSpec` 的 `config.layer ?? rule.layer ?? 'pre-step'` 一致。
 */
export function isFixedRegistration(config, layer) {
  return record(config) && (config.layer ?? layer) === 'system-section'
    && (config.params?.complete === true || config.params?.suppressRuntimeContext === true)
}

export function ruleActionExecution(action) {
  const fixed = action.kind === 'guard' || (action.kind === 'inject-text' && isFixedRegistration(action.config))
  return { ...actionExecutionPoint(action), lifecycle: fixed ? 'registration' : 'event' }
}

/** 通用门只属于 when；固定系统段的 audience 保留为注册目标。 */
function normalizeActionGates(action, execution) {
  const inject = action.kind === 'inject-text'
  if (!inject && action.kind !== 'request-params') return
  const target = inject ? action.config : action
  if (inject) {
    // 这三个键在 `rule-runtime.mjs` 组装注入配置时被逐条覆盖（group/exclusive/enabled），
    // 写在动作上既不生效、又会被 st-render 的互斥认领按声明序消费后清空。
    for (const field of ['enabled', 'group', 'exclusive']) {
      if (target[field] !== undefined) throw new TypeError(`action ${action.id}: config.${field} 属于规则层，移到 rule.${field}`)
    }
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
    // 规则级 `if` 跨执行点各自求值，不在这里判定（见 assertSubject 的说明）。`else` 的动作自带
    // 这个 `not(if)`，校验时按**对象身份**剔除（`branch.mjs#expandActions` 保留 `outer` 元素
    // 引用）——按 subject 名字跳过会连带跳过嵌套分支里同名、但来自另一个执行点的死条件。
    const ruleNegation = ruleIf === undefined ? undefined : { not: ruleIf }
    const ruleThen = spec.then
    if (!Array.isArray(ruleThen) || ruleThen.length === 0) throw new TypeError(`rule ${spec.id}.then must be a non-empty array`)
    const sequence = options.configOrder?.[spec.id] ?? index * 10
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw new TypeError(`rule ${spec.id}: invalid configOrder`)
    const when = compileWhen(ruleIf, options)
    // 规则级 else 依赖 `not(if)` 才能与 then 互斥；没有 if 时 else 会退化成无条件动作。
    if (spec.else !== undefined && (ruleIf === undefined || ruleIf === null)) {
      throw new TypeError(`rule ${spec.id}: else requires an if — 规则级 else 不能脱离 if 存在`)
    }
    // 规则级 `if` 由 `rule.when` 判定，then 分支的动作不再重复叠加它；规则级 `else` 的动作
    // 自带 `not(if)` 并标记跳过规则级判定——否则两者自相矛盾，else 分支永远不会执行。
    const expanded = [
      ...expandActions(ruleThen, {}, `rule ${spec.id}.then`),
      ...(spec.else === undefined ? [] : expandActions(spec.else, {
        outer: [ruleNegation],
        bypass: true,
      }, `rule ${spec.id}.else`)),
    ]
    const actionIds = new Set()
    const actions = expanded.map(({ node: source, conditions, bypass }, actionIndex) => {
      if (!record(source) || !nonempty(source.id)) throw new TypeError(`rule ${spec.id}: action id must be non-empty`)
      if (actionIds.has(source.id)) throw new TypeError(`rule ${spec.id}: duplicate action id ${source.id}`)
      actionIds.add(source.id)
      if (!Object.hasOwn(ACTION_KINDS, source.kind)) throw new TypeError(`rule ${spec.id}: unknown action ${source.kind}`)
      // 带 `kind` 的节点同时写分支键时，`expandActions` 只认无 `kind` 的分支节点——分支会被
      // 静默丢掉（条件不生效、动作照旧执行），因此点名拒绝而不是当未知键。
      const branchKeys = ['if', 'then', 'else'].filter(key => source[key] !== undefined)
      if (branchKeys.length > 0) throw new TypeError(`rule ${spec.id}: action ${source.id} 写了 ${branchKeys.join(', ')} — 分支必须写成无 \`kind\` 的节点`)
      // 旧动作级开关已退役：显式拒绝并给出新名（比 unknown fields 更可直接照做）。
      if (source.when !== undefined) throw new TypeError(`rule ${spec.id}: action ${source.id}: "when" 已退役，改用 "if"`)
      if (source.prepend !== undefined) throw new TypeError(`rule ${spec.id}: action ${source.id}: ${PREPEND_RETIRED}`)
      // 声明路径上的 `match` 只能是函数（`prepare*` 里 `typeof === 'function'` 才过滤）；
      // 对象形态恒命中 = 「配了门却没拦住」，比未知键更隐蔽。
      if (MATCH_ACTION_KINDS.has(source.kind) && source.match !== undefined && typeof source.match !== 'function') {
        throw new TypeError(`rule ${spec.id}: action ${source.id}.match 必须是函数 — 对象形态恒命中，改用 rule.if`)
      }
      const action = structuredClone(source)
      if (action.kind === 'inject-text') {
        action.config = injectionConfigSpec(spec, action, options)
        if (action.config.strategy === 'custom-fallback') throw new TypeError(`action ${action.id}: migrate custom-fallback to an anchor condition and anchor-notice content`)
      }
      const execution = ruleActionExecution(action)
      // 未知键检查必须在 normalizeActionGates **之后**：中性旧门由它删除、非中性旧门由它报
      // 「move it to rule.if」，那些键因此既不会落在未知键名单里，也不会被静默丢弃。
      normalizeActionGates(action, execution)
      validateConfig(`rule ${spec.id}: action ${action.id}`, action, ACTION_FIELDS[action.kind])
      if (action.kind === 'request-params') {
        // patch / unset 的子键同属 LlmCallConfig（键集与值规则复用 schema 的 assertLlmCallPatch）：
        // 拼错的键与非法值今天会被静默忽略（补丁不生效），与动作级未知键是同一类失效。
        for (const field of ['patch', 'unset']) {
          if (record(action[field])) assertLlmCallPatch(action[field], `action ${action.id}.${field}`)
        }
      }
      if (action.kind === 'inject-text') {
        if (action.config.prepend !== undefined) throw new TypeError(`rule ${spec.id}: action ${action.id}: ${PREPEND_RETIRED}`)
        validateConfig(`rule ${spec.id}: action ${action.id} config`, action.config, INJECT_CONFIG_FIELDS)
        // F27：complete / suppressRuntimeContext 是 system-section 的注册期效果。写在别的层上
        // 既不注册成独占段、又会被独占计数误算，逐动作点名拒绝（params 子键不做白名单）。
        // 出现即拒（`false` 除外）：`'yes'` / `1` 这类值同样落不到任何注册期效果上。
        if (action.config.layer !== 'system-section' && record(action.config.params)) {
          for (const flag of ['complete', 'suppressRuntimeContext']) {
            if (action.config.params[flag] !== undefined && action.config.params[flag] !== false) {
              throw new TypeError(`rule ${spec.id}: action ${action.id}: config.params.${flag} 只属于 layer system-section — 当前 layer 是 ${JSON.stringify(action.config.layer)}`)
            }
          }
        }
      }
      const channelOrder = action.channelOrder ?? sequence
      if (!Number.isSafeInteger(channelOrder) || channelOrder < 0) throw new TypeError(`action ${action.id}: channelOrder must be a non-negative safe integer`)
      const waterfallPosition = action.waterfallPosition ?? 'default'
      if (!WATERFALL_POSITIONS.has(waterfallPosition)) throw new TypeError(`action ${action.id}: invalid waterfallPosition`)
      if (execution.lifecycle === 'registration' && (when !== undefined || waterfallPosition !== 'default')) throw new TypeError(`action ${action.id}: registration effects do not support when or waterfall positioning`)
      if (action.kind === 'inject-text' && waterfallPosition !== 'default') throw new TypeError(`action ${action.id}: inject-text placement belongs to its official layer, not waterfallPosition`)
      if (action.kind === 'inject-text') {
        validateActionOptions(action)
        if (!record(action.config)) throw new TypeError(`action ${action.id}: config must be an object`)
        // 原始声明保持不变；正文身份由 `injectionConfigSpec` 保证（`config.id` 非空，不再兜第二次）。
        pendingConfigs.push({ action, source: { ...action.config }, sequence: channelOrder, ruleId: spec.id, actionIndex })
      } else prepareAction(action, { promptConfigOptions: options.promptConfigOptions })
      // 动作级条件只在本动作的执行点求值：谓词要读的事实必须由该通道真实提供，否则是死条件。
      // 规则级 `if` 自身不在这里校验（它跨执行点求值）；`else` 注入的 `not(if)` 按**对象身份**
      // 剔除——因此嵌套分支的 `if` 照样校验，同名 subject 不再被规则级 `if` 连带跳过。
      const actionConditions = conjunction(conditions)
      const ownConditions = conjunction(conditions.filter(node => node !== ruleNegation))
      for (const { predicate, subject } of conditionSubjects(ownConditions)) {
        assertSubject(predicate, subject,
          predicate === 'text' ? channelTextSubjects(execution.channel) : channelFactSubjects(execution.channel),
          `rule ${spec.id}: action ${action.id}`)
      }
      // 空条件数组经 conjunction → undefined → compileWhen 直接返回 undefined（无条件动作）。
      const actionWhen = compileWhen(actionConditions, options)
      const branchLayer = action.kind === 'inject-text' ? action.config.layer : spec.layer ?? 'pre-step'
      if (actionWhen !== undefined && (REGISTRATION_LAYERS.has(branchLayer) || execution.lifecycle === 'registration')) {
        throw new TypeError(`action ${action.id}: layer ${branchLayer} has no per-turn evaluation point — move the branch to pre-step / subagent-* / tool-pipeline / turn-stop`)
      }
      return Object.assign(action, { execution, channelOrder, waterfallPosition, actionIndex, actionWhen, bypassRuleWhen: bypass, conditions: structuredClone(actionConditions) })
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
  // 独占只可能是 system-section 的 complete：其他层的同名键在逐动作校验处已被拒绝，
  // 所以这里不再重复层判定（`isFixedRegistration` 只服务 lifecycle 与两处运行期消费方）。
  const complete = rules.filter(rule => rule.enabled).flatMap(rule => rule.actions).filter(action => action.config?.params?.complete === true)
  if (complete.length > 1 || (complete.length > 0 && options.personaComplete === true)) throw new TypeError('rules: multiple complete system sections are active')
  if (pendingConfigs.length) {
    const compiled = createPromptConfigs(pendingConfigs.map(item => item.source), { ...options.promptConfigOptions, ...(moduleId === undefined ? {} : { sourceModuleId: moduleId }) })
    const byId = new Map(compiled.map(config => [config.id, config]))
    for (const item of pendingConfigs) {
      const config = byId.get(item.source.id)
      Object.assign(config, { sequence: item.sequence, ruleId: item.ruleId, ruleActionIndex: item.actionIndex })
      // 停用标记在这里打，不在 `injectionConfigSpec`：那是校验**之前**，标记会变成作者可写的字段。
      // 校验之后打标，作者手写同名键按未知键 fail loud；执行期据此跳过会话变量合并。
      if (options.variablesEnabled === false) config[SESSION_VARIABLES_DISABLED] = true
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
