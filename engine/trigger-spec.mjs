/** 旧 triggers 声明供离线迁移与历史契约验证；新运行时只编译 rules。 */
import { ACTION_KINDS, actionExecutionPoint, prepareAction, registerAction } from './actions.mjs'
import { WATERFALL_POSITIONS, orderTriggers, registrationOptions, wireTriggerObservers } from './trigger.mjs'
import { compileWhen } from './conditions/index.mjs'
import { conjunction, expandActions } from './branch.mjs'
export { compileWhen, COMPOSITE_OPERATORS, PREDICATE_FACTORIES } from './conditions/index.mjs'
const DECLARATION_FIELDS = Object.freeze(['id', 'channel', 'channelOrder', 'waterfallPosition', 'phase', 'if', 'then', 'else', 'when', 'do'])
const ACTION_PHASES = Object.freeze(['before-next', 'after-next'])

/** `then`/`do` 归一化为动作声明数组；分支节点留到 `expandActions` 展开。 */
function actionList(value, label) {
  const list = Array.isArray(value) ? value : [value]
  if (list.length === 0) throw new TypeError(`${label} must be an action declaration or a non-empty array of them`)
  return list
}

/** 展开后的叶子必须是已知动作。 */
function assertActionKind(action, at) {
  if (action === null || typeof action !== 'object' || Array.isArray(action)) {
    throw new TypeError(`trigger-spec: ${at} must be an action declaration object`)
  }
  if (typeof action.kind !== 'string' || !Object.hasOwn(ACTION_KINDS, action.kind)) {
    throw new TypeError(
      `trigger-spec: ${at}.kind must be one of ${Object.keys(ACTION_KINDS).join(', ')} — got ${JSON.stringify(action.kind)}`,
    )
  }
  return action
}

/**
 * 声明级 `if` 与动作自身分支条件的合取；来自**声明级** `else` 的动作跳过声明级判定
 * （它的条件里已含 `not(if)`）。两个条件缺省都表示无条件。
 */
function actionGate(declarationWhen, action) {
  const own = action.actionWhen
  const base = action.bypassRuleWhen === true ? undefined : declarationWhen
  if (base === undefined) return own
  if (own === undefined) return base
  return subject => base(subject) === true && own(subject) === true
}

/**
 * 编译一条声明：校验字段 + 编译 `when` + 归一化 `do`。
 *
 * @param {object} spec 声明（`{ id, channel, when?, do, channelOrder?, waterfallPosition?, phase? }`）
 * @param {object} [context] 同 {@link compileWhen}，另可提供 promptConfigOptions（createPromptConfigs 的模板/策略编译选项）。
 * @returns {{id: string, channel: string, channelOrder: number, waterfallPosition: string, phase: string, when: Function|undefined, actions: object[], promptConfigOptions?: object}}
 */
export function compileDeclaration(spec, context = {}) {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new TypeError('trigger-spec: trigger declaration must be an object')
  }
  const unknown = Object.keys(spec).filter((key) => !DECLARATION_FIELDS.includes(key))
  if (unknown.length > 0) {
    throw new TypeError(
      `trigger-spec: unknown trigger field(s) ${unknown.sort().join(', ')} — allowed: ${[...DECLARATION_FIELDS].sort().join(', ')}`,
    )
  }
  if (typeof spec.id !== 'string' || spec.id.length === 0) {
    throw new TypeError('trigger-spec: trigger id must be a non-empty string')
  }
  if (typeof spec.channel !== 'string' || spec.channel.length === 0) {
    throw new TypeError(`trigger-spec: trigger ${spec.id}: channel must be a non-empty event name`)
  }
  const label = `trigger-spec: trigger ${spec.id}`
  // 旧名已按引擎重构退役：显式拒绝并给出新名。
  if (spec.when !== undefined) throw new TypeError(`${label}: "when" 已退役，改用 "if"`)
  if (spec.do !== undefined) throw new TypeError(`${label}: "do" 已退役，改用 "then"`)
  const triggerIf = spec.if
  const triggerThen = spec.then
  if (triggerThen === undefined) throw new TypeError(`${label}: then is required`)
  const channelOrder = spec.channelOrder ?? 0
  if (!Number.isSafeInteger(channelOrder) || channelOrder < 0) {
    throw new TypeError(`trigger-spec: trigger ${spec.id}: channelOrder must be a non-negative safe integer`)
  }
  const waterfallPosition = spec.waterfallPosition ?? 'default'
  if (!WATERFALL_POSITIONS.has(waterfallPosition)) {
    throw new TypeError(`trigger-spec: trigger ${spec.id}: waterfallPosition must be one of ${[...WATERFALL_POSITIONS].join(', ')}`)
  }
  // 声明级 `if` 由注册侧判定；声明级 `else` 的动作自带 `not(if)` 并跳过它，否则自相矛盾。
  const expanded = [
    ...expandActions(actionList(triggerThen, `${label}.then`), {}, `${label}.then`),
    ...(spec.else === undefined ? [] : expandActions(actionList(spec.else, `${label}.else`), {
      outer: triggerIf === undefined ? [] : [{ not: triggerIf }],
      bypass: true,
    }, `${label}.else`)),
  ]
  const when = compileWhen(triggerIf, context)
  const actions = expanded.map(({ node, conditions, bypass }, index) => Object.assign(
    { ...assertActionKind(node, `action[${index}]`) },
    { actionWhen: compileWhen(conjunction(conditions), context), bypassRuleWhen: bypass },
  ))
  // 保存期复用注册入口的纯准备阶段；不绑定 ctx，不创建预算或监听器。
  for (const action of actions) prepareAction(action, {
    when: action.actionWhen ?? when, promptConfigOptions: context.promptConfigOptions, ...registrationOptions({ waterfallPosition }),
  })
  const phase = spec.phase ?? actionExecutionPoint(actions[0]).phase
  if (!ACTION_PHASES.includes(phase)) {
    throw new TypeError(`trigger-spec: trigger ${spec.id}: phase must be one of ${ACTION_PHASES.join(', ')}`)
  }
  for (const action of actions) {
    const point = actionExecutionPoint(action)
    if (spec.channel !== point.channel) {
      throw new TypeError(`trigger-spec: trigger ${spec.id}: action ${action.kind} channel must be ${point.channel}`)
    }
    if (phase !== point.phase) {
      throw new TypeError(`trigger-spec: trigger ${spec.id}: action ${action.kind} phase must be ${point.phase}`)
    }
  }
  return {
    id: spec.id,
    channel: spec.channel,
    channelOrder,
    waterfallPosition,
    phase,
    when,
    actions,
    ...(context.promptConfigOptions === undefined ? {} : { promptConfigOptions: context.promptConfigOptions }),
  }
}

/**
 * 编译一组声明：先归一化，再按 `channelOrder` 做稳定排序（同值保持声明序）。
 * 排序复用 `trigger.mjs` 的 `orderTriggers`——声明路径与内联函数路径共用同一套调度语义。
 */
export function compileDeclarations(specs, context = {}) {
  if (!Array.isArray(specs)) throw new TypeError('trigger-spec: triggers must be an array')
  return orderTriggers(specs.map((spec) => compileDeclaration(spec, context)))
}

/** 该声明在其通道上的注册选项（只有 `outermost` 才 prepend），转发 `trigger.mjs` 的实现。 */
export function declarationRegistrationOptions(compiled) {
  return registrationOptions(compiled)
}

/**
 * 把**编译好的**声明逐条注册——声明路径的挂载入口。
 *
 * 一条声明的每个动作各注册一次，带上：
 *   - `when`：该声明的判定（`undefined` = 无条件，注册侧据此跳过判定）；
 *   - `prepend`：`waterfallPosition === 'outermost'` 时落在外层。
 * 会话态谓词（相位 / 计数）的 `observe` 喂入走 `wireTriggerObservers`——与
 * `mountTriggers` 的内联路径**共用同一实现**，不各写一条 `session/event` 监听。
 *
 * @param ctx 挂载作用域
 * @param compiled {@link compileDeclarations} 的产物
 * @returns disposer：撤销全部注册（含 observe 接线与每个动作自己的释放）
 */
export function mountDeclarations(ctx, compiled, { plugin, warnOnce } = {}) {
  const disposers = []
  const observer = wireTriggerObservers(ctx, compiled, { plugin, warnOnce })
  if (observer !== undefined) disposers.push(observer)
  for (const trigger of compiled) {
    for (const action of trigger.actions) {
      disposers.push(registerAction(ctx, action, {
        plugin,
        warnOnce,
        promptConfigOptions: trigger.promptConfigOptions,
        when: actionGate(trigger.when, action),
        prepend: trigger.waterfallPosition === 'outermost',
      }))
    }
  }
  return () => {
    for (const dispose of disposers.splice(0)) {
      try {
        if (typeof dispose === 'function') dispose()
      } catch {
        // 释放失败不得反过来打断卸载流程（与 actions.mjs 同一纪律）。
      }
    }
  }
}
