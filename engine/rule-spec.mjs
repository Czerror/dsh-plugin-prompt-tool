/** module.yml.rules 的唯一运行时编译入口。 */
import { ACTION_KINDS, actionExecutionPoint, prepareAction, validateActionOptions } from './actions/index.mjs'
// 字段清单与动作声明同住 `actions/catalog.mjs`（`actions/index.mjs` 不再导出新面）。
import { ACTION_FIELDS } from './actions/catalog.mjs'
import { compileWhen, PREDICATE_FACTORIES, COMPOSITE_OPERATORS, FACT_PREDICATE_SUBJECTS, channelFactSubjects, channelTextSubjects } from './conditions/index.mjs'
import { createPromptConfigs, INJECT_CONFIG_FIELDS, KNOWN_LAYERS, SESSION_VARIABLES_DISABLED, assertLlmCallPatch } from './schema.mjs'
import { stripDeclaredRefs } from './interpolate.mjs'
import { matchesAudience, validateConfig } from './shared.mjs'
import { WATERFALL_POSITIONS } from './trigger.mjs'
import { ACTION_EXAMPLES } from './actions/examples.mjs'
import { PREDICATE_EXAMPLES } from './conditions/examples.mjs'
import { conjunction, expandActions } from './branch.mjs'
import { identityOf, textRegistrationName } from './delivery.mjs'

/** 规则字段：只有 `if`/`then`/`else`；旧名 `when`/`do` 留在名单里，只为把 unknown fields 换成一句「已退役，改用 X」。 */
const RULE_FIELDS = new Set(['id', 'name', 'enabled', 'layer', 'group', 'exclusive', 'if', 'then', 'else', 'when', 'do'])
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const nonempty = value => typeof value === 'string' && value.trim().length > 0

/** `prepend` 退役文案（动作层与 `inject-text.config` 共用）：等价档只有「注册到最外层」一档，而 `inject-text` 连它也不接受。 */
const PREPEND_RETIRED = '`prepend` 已取消 — 它是未文档化的注册后门（executor 直读 config.prepend），作用只有「注册到最外层」一档：非 inject-text 动作改用 `waterfallPosition: outermost`；`inject-text` 不接受该字段，没有等价写法'

/**
 * 条件树引用的全部「谓词 → 通道事实」对（含组合与否定）；`subject === undefined` = 作者漏写。
 * 树是数据：校验期读它，挂载期由 `rebindConditions` 用它重绑——`compileWhen` 的产物把 subject 关进闭包，读不回来。
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

function referencedActions(node, out = new Set()) {
  if (!record(node)) return out
  if (node.anchor?.after) out.add(node.anchor.after.action)
  for (const key of ['all', 'any', 'notAny']) {
    if (Array.isArray(node[key])) for (const child of node[key]) referencedActions(child, out)
  }
  if (node.not) referencedActions(node.not, out)
  return out
}

function validateActionLinks(rule) {
  const actions = new Map(rule.actions.map(action => [action.id, action]))
  const edges = new Map()
  for (const action of rule.actions) {
    const content = action.compiledConfig
    if (content?.fill === 'tool-catalog') {
      const source = actions.get(content.params.action)
      if (source?.kind !== 'tool-visibility' || !Array.isArray(source.allow)) {
        throw new TypeError(`rule ${rule.id}: tool-catalog action ${action.id} requires a same-rule tool-visibility action with allow`)
      }
      content.toolCatalogSource = { allow: source.allow, deny: source.deny, discovery: source.discovery }
    }
    const refs = referencedActions(action.conditions, referencedActions(rule.conditionTrees.when))
    edges.set(action.id, refs)
    if (refs.size && action.compiledConfig) action.compiledConfig.linkedDelivery = true
    for (const id of refs) {
      const target = actions.get(id)
      if (target === undefined) throw new TypeError(`rule ${rule.id}: unknown after action ${id}`)
      if (id === action.id) throw new TypeError(`rule ${rule.id}: action ${id} cannot reference itself in after`)
      const config = target.compiledConfig
      if (target.kind !== 'inject-text' || !['pre-step', 'runtime-context', 'turn-stop'].includes(config?.layer)
        || config.mergeMode === 'merged') throw new TypeError(`rule ${rule.id}: after action ${id} requires an independently delivered message or runtime-context`)
      for (const other of rule.actions) {
        if (other === target || other.compiledConfig === undefined) continue
        const conflict = config.layer === 'runtime-context'
          ? other.compiledConfig.layer === config.layer && textRegistrationName(config, 'contextName') === textRegistrationName(other.compiledConfig, 'contextName')
          : identityOf(config) === identityOf(other.compiledConfig)
        if (conflict) throw new TypeError(`rule ${rule.id}: after action ${id} has an ambiguous delivery identity`)
      }
      config.linkedDelivery = true
    }
  }
  const visiting = new Set(), visited = new Set()
  const visit = id => {
    if (visiting.has(id)) throw new TypeError(`rule ${rule.id}: cyclic after action reference at ${id}`)
    if (visited.has(id)) return
    visiting.add(id)
    for (const target of edges.get(id) ?? []) visit(target)
    visiting.delete(id); visited.add(id)
  }
  for (const id of actions.keys()) visit(id)
}

/** 命名快照在整个挂载 scope 内共享，关联目标不能借别的规则的同名贡献确认。 */
export function validateDeliverySources(sources) {
  const names = new Map()
  for (const source of sources) for (const rule of source.rules) {
    if (rule.enabled === false) continue
    for (const action of rule.actions) {
      if (action.compiledConfig?.layer !== 'runtime-context') continue
      const config = { ...action.compiledConfig, sourceModuleId: source.moduleId }
      const name = textRegistrationName(config, 'contextName')
      const previous = names.get(name)
      if (previous && (previous.linkedDelivery || config.linkedDelivery)) {
        throw new TypeError(`ambiguous runtime-context delivery identity ${JSON.stringify(name)}`)
      }
      names.set(name, config)
    }
  }
}

/**
 * **只用于动作级条件**：动作的判定绑定单一执行点，谓词要读的事实写错通道（或 `text` 省略
 * subject）等于该动作永不执行，而挂载与运行期都不报错（`availability.mjs` 对通道取不到的
 * 字段返回 UNAVAILABLE，`condition-facts.mjs#subjectTextOf` 取不到一律空串）。规则级 `if` 相反：
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
  if (Object.hasOwn(action.config, 'variables')) throw new TypeError('动作 config.variables 已退役；请显式提升为模块 variables，同名不同值须先解决冲突')
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
 * 的逐动作校验里点名拒绝；规则编译与导入转换共用本谓词。
 * 独占计数只认 `complete`：`suppressRuntimeContext` 不产生「多个 complete 段」冲突。
 * `layer` 是声明缺省层——导入转换的 config 可能省略 layer，回退规则与
 * `injectionConfigSpec` 的 `config.layer ?? rule.layer ?? 'pre-step'` 一致。
 */
export function isFixedRegistration(config, layer) {
  return record(config) && (config.layer ?? layer) === 'system-section'
    && (config.params?.complete === true || config.params?.suppressRuntimeContext === true)
}

/** 编译与宿主聚合共用的受众独占清单，身份保留到规则和动作。 */
export function completeRuleSections(rules, audience) {
  return rules.filter(rule => rule.enabled !== false).flatMap(rule => rule.actions.flatMap(action => {
    const config = action.compiledConfig ?? action.config
    return action.kind === 'inject-text' && config?.layer === 'system-section' && config.params?.complete === true
      && matchesAudience(config.audience, audience) ? [`${rule.id}/${action.id}`] : []
  }))
}

const AUDIENCE_ALL = ['main', 'subagent']

/**
 * 条件树 → 受众上下界；`exact` 表示结果是否能安全取补。
 *
 * `all` 求交时跳过无法收窄的子条件：AND 只会更窄，结果仍是「可能命中」的上界，
 * 但不再精确——此时取补会错误排除受众，所以 `not` / `notAny` 遇非精确子节点返回未知。
 * `any` 任一分支不精确即整体未知（保守）。
 */
function audienceInfo(tree) {
  if (!record(tree)) return undefined
  if (record(tree.scope)) {
    const { audience, modelScope } = tree.scope
    // 同节点带 pro/flash 时结果还依赖模型，不能取补；缺省与 all 只按受众收窄。
    if (audience === 'main' || audience === 'subagent') {
      return { audiences: new Set([audience]), exact: modelScope === undefined || modelScope === 'all' }
    }
  }
  for (const operator of COMPOSITE_OPERATORS) {
    const value = tree[operator]
    if (value === undefined) continue
    // 非法形状（`all: null` 之类）不猜语义：按无法收窄处理，与重构前的宿主判据一致。
    if (operator !== 'not' && !Array.isArray(value)) return undefined
    switch (operator) {
      case 'all': {
        let audiences = new Set(AUDIENCE_ALL)
        let exact = true
        for (const child of value) {
          const childInfo = audienceInfo(child)
          if (childInfo === undefined) {
            exact = false
            continue
          }
          audiences = new Set([...audiences].filter((audience) => childInfo.audiences.has(audience)))
          if (!childInfo.exact) exact = false
        }
        return { audiences, exact }
      }
      case 'any': {
        const audiences = new Set()
        for (const child of value) {
          const childInfo = audienceInfo(child)
          if (childInfo === undefined || !childInfo.exact) return undefined
          for (const audience of childInfo.audiences) audiences.add(audience)
        }
        return { audiences, exact: true }
      }
      case 'not': {
        const childInfo = audienceInfo(value)
        if (childInfo === undefined || !childInfo.exact) return undefined
        return { audiences: new Set(AUDIENCE_ALL.filter((audience) => !childInfo.audiences.has(audience))), exact: true }
      }
      case 'notAny': {
        const childInfo = audienceInfo({ any: value })
        if (childInfo === undefined || !childInfo.exact) return undefined
        return { audiences: new Set(AUDIENCE_ALL.filter((audience) => !childInfo.audiences.has(audience))), exact: true }
      }
      default:
        // 新算子未声明受众语义：不收窄，交给调用方保守处理。
        return undefined
    }
  }
  return undefined
}

/**
 * 条件树 → 受众事实（受众判据的唯一实现）：这条规则可能作用于哪些受众。
 *
 * `undefined` = 无法静态收窄，由调用方按保守方向处理。语义与 AND/OR 一致：
 * - `all` 求交：AND 只会更窄，无法收窄的子条件不扩大结果（结果是上界，不可取补）；
 * - `any` 保守：任一分支无法收窄，整体就无法排除另一个受众；
 * - `not` / `notAny` 只对精确子节点取补；`scope.audience` 是唯一能精确收窄的谓词。
 *
 * 算子集合来自 `COMPOSITE_OPERATORS`（与 `compileWhen` / `composite` 同源）；
 * 新增算子若没补受众语义，`test/engine/rule-audiences.test.mjs` 的映射表先红。
 */
export function audienceOf(tree) {
  return audienceInfo(tree)?.audiences
}

/**
 * 动作级受众事实：规则级 `when` 与动作级 `conditions` 的合取。
 *
 * 规则级 `else` 的动作自带 `not(if)` 并标记 `bypassRuleWhen`——它的受众已由动作条件
 * 决定，再叠 `when` 会得到 `when ∧ ¬when` 的空集。未知 `actionId` 是防御分支：
 * 调用方只在遍历真实动作时使用，遇到未知 id 按两个受众处理。
 */
export function actionAudiences(rule, actionId) {
  const actions = Array.isArray(rule?.actions) ? rule.actions : []
  const action = actions.find((item) => record(item) && item.id === actionId)
  if (action === undefined) return new Set(AUDIENCE_ALL)
  const own = audienceOf(action.conditions)
  const when = action.bypassRuleWhen === true ? undefined : audienceOf(rule?.conditionTrees?.when)
  if (when === undefined && own === undefined) return new Set(AUDIENCE_ALL)
  if (when === undefined) return new Set(own)
  if (own === undefined) return new Set(when)
  return new Set([...when].filter((audience) => own.has(audience)))
}

export function ruleActionExecution(action) {
  const fixed = action.kind === 'inject-text' && isFixedRegistration(action.config)
  return { ...actionExecutionPoint(action), lifecycle: fixed ? 'registration' : 'event' }
}

/** 通用门只属于 when；固定系统段的 audience 保留为注册目标。 */
function normalizeActionGates(action, execution) {
  const inject = action.kind === 'inject-text'
  if (!inject && action.kind !== 'request-params') return
  const target = inject ? action.config : action
  if (inject) {
    // 这三个键在 `rule-runtime.mjs` 组装注入配置时被逐条覆盖（group/exclusive/enabled），
    // 动作不另建启停和互斥状态，避免出现第二个规则总闸。
    for (const field of ['enabled', 'group', 'exclusive']) {
      if (target[field] !== undefined) throw new TypeError(`action ${action.id}: config.${field} 属于规则层，移到 rule.${field}`)
    }
  }
  const fields = inject ? ['audience', 'modelScope', 'promotion'] : ['audience', 'modelScope']
  for (const field of fields) {
    const value = target[field]
    if (inject && field === 'audience' && target.layer === 'system-section' && execution.lifecycle === 'registration' && ['main', 'subagent'].includes(value)) continue
    const neutral = value == null || value === '' || (field === 'modelScope' && value === 'all') || (field === 'promotion' && value === 'none')
    if (!neutral) throw new TypeError(`action ${action.id}: ${inject ? 'config.' : ''}${field} is a legacy gate; move it to rule.if`)
    delete target[field]
  }
}

/** options.promptConfigOptions 拥有模板/策略路径；configOrder 使用规则 id，moduleId 只标记来源。 */
export function compileRules(specs, options = {}) {
  if (!Array.isArray(specs)) throw new TypeError('rules must be an array')
  // 条件的绑定**不在编译期**：`preset` 谓词的取法要挂载 scope 的 ctx（`conditions/preset.mjs`），
  // 准备期拿不到。这里显式剥掉挂载期选项——传了也不生效，免得调用方以为已经绑好。
  // variableStore 与 ctx/standingMountFor 同理：绑定发生在挂载期，准备期传了也不生效。
  const { ctx: _ctx, standingMountFor: _standingMountFor, variableStore: _variableStore, ...conditionOptions } = options
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
    const when = compileWhen(ruleIf, conditionOptions)
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
      // 声明路径（YAML / JSON / 导入）表达不了函数，而 `structuredClone` 对函数抛
      // DataCloneError——报错提示「改用函数」等于把人引向死路。`match` 出现即拒，
      // 条件写在规则级 `if` 或分支节点里。
      if (source.match !== undefined) {
        throw new TypeError(`rule ${spec.id}: action ${source.id}.match 已取消 — 声明路径写不了函数，条件改用 rule.if`)
      }
      const action = structuredClone(source)
      if (action.kind === 'inject-text') {
        action.config = injectionConfigSpec(spec, action, options)
      }
      const execution = ruleActionExecution(action)
      // 未知键检查必须在 normalizeActionGates **之后**：中性旧 audience/modelScope/promotion
      // 由它删除、非中性旧门由它报「move it to rule.if」，那些键因此既不会落在未知键名单里，
      // 也不会被静默丢弃。声明式 config.subject/match 已删除，不再进入这张旧门名单。
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
      const actionWhen = compileWhen(actionConditions, conditionOptions)
      if (actionWhen !== undefined && execution.lifecycle === 'registration') {
        throw new TypeError(`action ${action.id}: registration effects do not support conditional branches`)
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
    return {
      id: spec.id, name: spec.name, layer: spec.layer, group: spec.group, exclusive: spec.exclusive === true, enabled: spec.enabled !== false,
      sequence, when, actions, promptConfigOptions: options.promptConfigOptions,
      // 绑定所需的树：规则级 `if` + 每个动作展开后的条件（动作那半与 `action.conditions` 同一引用）。
      // **只有引擎内部读它**（`rebindConditions` 绑定、`actionAudiences` 推导受众）——调用方与挂载缝都不需要知道这个形状。
      conditionTrees: {
        ...(ruleIf === undefined ? {} : { when: structuredClone(ruleIf) }),
        actions: Object.fromEntries(actions.filter(action => action.conditions !== undefined).map(action => [action.id, action.conditions])),
      },
    }
  })
  validateRuleGroups(rules)
  for (const audience of ['main', 'subagent']) {
    const complete = completeRuleSections(rules, audience)
    if (complete.length > 1 || (complete.length > 0 && options.personaComplete === true)) {
      throw new TypeError(`rules: multiple complete system sections are active for ${audience}: ${complete.join(', ')}`)
    }
  }
  if (pendingConfigs.length) {
    const compiled = createPromptConfigs(pendingConfigs.map(item => item.source), { ...options.promptConfigOptions, ...(moduleId === undefined ? {} : { sourceModuleId: moduleId }) })
    const byId = new Map(compiled.map(config => [config.id, config]))
    for (const item of pendingConfigs) {
      const config = byId.get(item.source.id)
      Object.assign(config, { sequence: item.sequence, ruleId: item.ruleId, ruleActionId: item.action.id, ruleActionIndex: item.actionIndex })
      // 停用标记在这里打，不在 `injectionConfigSpec`：那是校验**之前**，标记会变成作者可写的字段。
      // 校验之后打标，作者手写同名键按未知键 fail loud；执行期据此跳过会话变量合并。
      if (options.variablesEnabled === false) config[SESSION_VARIABLES_DISABLED] = true
      // 模块级 ST 递归开关（module.yml 顶层）：与上一行同源同时序，作者写同名键按未知键 fail loud。
      if (options.contextActivationRecursive === true) config.contextActivationRecursive = true
      item.action.compiledConfig = config
    }
  }
  for (const rule of rules) validateActionLinks(rule)
  validateDeliverySources([{ moduleId, rules }])
  return rules
}

/**
 * 树里是否需要挂载期的输入：
 * - `preset` 谓词：`conditions/preset.mjs` 把服务查询基准绑在**构造期**；
 * - `phase` 谓词（且未显式 `subscribe: false`）：订阅模式要从挂载缝的追踪器池里取实例
 *   （见 `promotion-pool.mjs`），否则每个编译出的谓词各建一份、各自订阅、各自喂事件。
 * - `anchor.after`：引用目标需要挂载来源的真实模块身份。
 *
 * 其余原语只用节点选项。只重绑需要重绑的树：调用方对不含这些节点的条件谓词做的包装/替换
 * 不会被覆盖，「挂载缝接管绑定」与「调用方仍可注入自定义判定」两件事不冲突。
 */
function needsMountContext(node) {
  if (node === null || typeof node !== 'object') return false
  if (Array.isArray(node)) return node.some(needsMountContext)
  if (Object.hasOwn(node, 'preset')) return true
  // variable 要读挂载 scope 的变量适配器（准备期没有）。
  if (Object.hasOwn(node, 'variable')) return true
  if (Object.hasOwn(node, 'phase') && node.phase?.subscribe !== false) return true
  if (node.anchor?.after !== undefined) return true
  return Object.values(node).some(needsMountContext)
}

/**
 * 把需要挂载期 ctx 的条件绑定到挂载缝：**`compileRules` 只编译与校验，绑定由 `mountRuleSources`
 * 在这里完成**（`rule-runtime.mjs`）。
 *
 * 为什么不在编译期绑：`preset` 谓词要挂载 scope 的 ctx，准备期拿不到——编译期绑出来的 preset
 * 条件恒 UNAVAILABLE，而且是静默的。树只在本模块读：调用方与挂载缝都不需要知道
 * `conditionTrees` 的形状；没有该字段的产物（已绑好的输入）原样保留。
 */
export function rebindConditions(sources, context = {}) {
  if (!Array.isArray(sources)) throw new TypeError('sources must be an array')
  for (const source of sources) {
    for (const rule of source?.rules ?? []) {
      const trees = rule.conditionTrees
      if (trees === undefined) continue
      const targets = new Map(rule.actions.filter(action => action.compiledConfig !== undefined)
        .map(action => [action.id, { ...action.compiledConfig, sourceModuleId: source.moduleId }]))
      const binding = { ...context, moduleId: source.moduleId, resolveAction: id => targets.get(id) }
      if (trees.when !== undefined && needsMountContext(trees.when)) rule.when = compileWhen(trees.when, binding)
      for (const action of rule.actions ?? []) {
        const tree = trees.actions?.[action.id]
        if (tree !== undefined && needsMountContext(tree)) action.actionWhen = compileWhen(tree, binding)
      }
    }
  }
  return sources
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
