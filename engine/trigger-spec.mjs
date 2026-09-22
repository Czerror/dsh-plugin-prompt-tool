/**
 * trigger-spec — 声明编译器（B7 T1）：把**纯数据**的触发器声明编译成可注册的形状。
 *
 * 分工：`predicates.mjs` 提供判断原语、`actions.mjs` 提供动作、`trigger.mjs` 提供调度机制，
 * 本文件只做「数据 → 函数」这一步，**不含任何判断或执行的实现**。
 *
 * ## 词汇原样透传（这是本文件最重要的约束）
 *
 * `when` 的键要么是组合运算符（`any` / `all` / `not` / `notAny`），要么是七类原语之一
 * （`text` / `phase` / `source` / `count` / `names` / `session` / `preset`），**值原样传给对应的
 * `createXxxPredicate`**。声明层**不翻译、不改名、不补默认**——一旦这里长出第二套词汇，
 * 「文档里写的选项」与「谓词真正接受的选项」就会开始漂移，而这正是本项目要收敛的问题。
 *
 * ## 为什么 `when` 省略 = 无条件
 *
 * `when` 是**收窄**条件：不写表示「这个动作在该通道上总是执行」。这与「写一个恒真谓词」
 * 在行为上等价，但省略更好读；编译器对省略返回 `undefined`，注册侧据此跳过判定（零开销）。
 *
 * ## 与 `mountTriggers` 的关系
 *
 * `trigger.mjs` 的 `mountTriggers` 要求 `do` 是**函数**，而声明的 `do` 是**动作声明**；
 * B3 收口时两者从未对接。本文件不去接那条线（查证过：`inject-text` 与 `guard` 不经
 * `on(...)` 注册，"执行体"抽不出来），而是编译出 `{when, actions}` 交给
 * `registerAction(ctx, action, { when })` ——判定前置由动作侧统一提供。
 * 调度层面仍复用 `trigger.mjs` 的 `orderTriggers` / `registrationOptions`。
 */
import {
  composite,
  createCountPredicate,
  createNameListPredicate,
  createPhasePredicate,
  createPresetPredicate,
  createSessionStatePredicate,
  createSourcePredicate,
  createTextPredicate,
} from './predicates.mjs'
import { ACTION_KINDS, registerAction } from './actions.mjs'
import { WATERFALL_POSITIONS, orderTriggers, registrationOptions, wireTriggerObservers } from './trigger.mjs'

/** 七类判断原语：声明里的键 → 工厂。键名与 `predicates.mjs` 的工厂一一对应。 */
const PREDICATE_FACTORIES = Object.freeze({
  text: createTextPredicate,
  phase: createPhasePredicate,
  source: createSourcePredicate,
  count: createCountPredicate,
  names: createNameListPredicate,
  session: createSessionStatePredicate,
  preset: createPresetPredicate,
})

/** 组合运算符（与 `composite` 的词汇同源，不另立别名）。 */
const COMPOSITE_OPERATORS = Object.freeze(['any', 'all', 'not', 'notAny'])

/** 声明允许的字段（未知字段 fail loud：写错键名是最容易被静默忽略的一类错）。 */
const DECLARATION_FIELDS = Object.freeze(['id', 'channel', 'channelOrder', 'waterfallPosition', 'phase', 'when', 'do'])

/** 判定/动作在 `next()` 之前还是之后执行。 */
const ACTION_PHASES = Object.freeze(['before-next', 'after-next'])

const objectOrUndefined = (value, label) => {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`trigger-spec: ${label} must be an object`)
  }
  return value
}

/**
 * 编译 `when`：声明对象 → 谓词函数；`undefined` / `null` → `undefined`（无条件）。
 *
 * 节点形状（两种，互斥）：
 *   - 组合节点：`{ any: [节点…] }` / `{ all: [节点…] }` / `{ notAny: [节点…] }` / `{ not: 节点 }`
 *   - 原语节点：`{ <类别>: <选项对象> }`
 * **一个节点只能声明一个键**——混合声明（如同时给 `all` 与 `not`）在编译期抛错，
 * 于是优先级永远是显式的树形嵌套，而不是靠"先算 not 再算 and"的隐式约定。
 *
 * @param {unknown} node 声明里的 `when`
 * @param {object} [context] `{ ctx, standingMountFor }`：`preset` 原语需要它们（挂载期注入）
 * @returns {Function|undefined} 谓词函数
 */
export function compileWhen(node, context = {}) {
  if (node === undefined || node === null) return undefined
  if (typeof node !== 'object' || Array.isArray(node)) {
    throw new TypeError('trigger-spec: when must be an object (a composite node or a predicate node)')
  }
  const keys = Object.keys(node)
  if (keys.length === 0) {
    throw new TypeError('trigger-spec: when must not be an empty object — 空节点是「恒真」还是「写漏了」无法区分')
  }
  if (keys.length > 1) {
    throw new TypeError(
      `trigger-spec: when must declare exactly one key — got ${keys.sort().join(', ')}`
      + `（allowed: ${[...COMPOSITE_OPERATORS, ...Object.keys(PREDICATE_FACTORIES)].sort().join(', ')}）`,
    )
  }
  const [key] = keys
  const value = node[key]

  if (COMPOSITE_OPERATORS.includes(key)) {
    if (key === 'not') {
      return composite({ not: compileWhen(value, context) })
    }
    if (!Array.isArray(value) || value.length === 0) {
      throw new TypeError(`trigger-spec: when.${key} must be a non-empty array of nodes`)
    }
    return composite({ [key]: value.map((child) => compileWhen(child, context)) })
  }

  const factory = PREDICATE_FACTORIES[key]
  if (factory === undefined) {
    throw new TypeError(
      `trigger-spec: unknown predicate ${JSON.stringify(key)}`
      + ` — known predicates: ${Object.keys(PREDICATE_FACTORIES).join(', ')}; composite: ${COMPOSITE_OPERATORS.join(', ')}`,
    )
  }
  const options = objectOrUndefined(value, `when.${key}`) ?? {}
  // `preset` 原语的取法需要挂载期注入（见 predicates.mjs 的三条硬约束），其余原语只用选项。
  if (key === 'preset') {
    return createPresetPredicate({ ...options, ctx: context.ctx, standingMountFor: context.standingMountFor })
  }
  return factory(options)
}

/** `do` 归一化为动作声明数组；每个元素的 `kind` 必须是已知动作。 */
function compileActions(value) {
  const list = Array.isArray(value) ? value : [value]
  if (list.length === 0) throw new TypeError('trigger-spec: do must be an action declaration or a non-empty array of them')
  return list.map((action, index) => {
    if (action === null || typeof action !== 'object' || Array.isArray(action)) {
      throw new TypeError(`trigger-spec: do[${index}] must be an action declaration object`)
    }
    if (typeof action.kind !== 'string' || !(action.kind in ACTION_KINDS)) {
      throw new TypeError(
        `trigger-spec: do[${index}].kind must be one of ${Object.keys(ACTION_KINDS).join(', ')} — got ${JSON.stringify(action.kind)}`,
      )
    }
    return action
  })
}

/**
 * 编译一条声明：校验字段 + 编译 `when` + 归一化 `do`。
 *
 * @param {object} spec 声明（`{ id, channel, when?, do, channelOrder?, waterfallPosition?, phase? }`）
 * @param {object} [context] 同 {@link compileWhen}
 * @returns {{id: string, channel: string, channelOrder: number, waterfallPosition: string, phase: string, when: Function|undefined, actions: object[]}}
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
  if (spec.do === undefined) {
    throw new TypeError(`trigger-spec: trigger ${spec.id}: do is required`)
  }
  const channelOrder = spec.channelOrder ?? 0
  if (!Number.isSafeInteger(channelOrder) || channelOrder < 0) {
    throw new TypeError(`trigger-spec: trigger ${spec.id}: channelOrder must be a non-negative safe integer`)
  }
  const waterfallPosition = spec.waterfallPosition ?? 'default'
  if (!WATERFALL_POSITIONS.has(waterfallPosition)) {
    throw new TypeError(`trigger-spec: trigger ${spec.id}: waterfallPosition must be one of ${[...WATERFALL_POSITIONS].join(', ')}`)
  }
  const phase = spec.phase ?? 'after-next'
  if (!ACTION_PHASES.includes(phase)) {
    throw new TypeError(`trigger-spec: trigger ${spec.id}: phase must be one of ${ACTION_PHASES.join(', ')}`)
  }
  return {
    id: spec.id,
    channel: spec.channel,
    channelOrder,
    waterfallPosition,
    phase,
    when: compileWhen(spec.when, context),
    actions: compileActions(spec.do),
  }
}

/**
 * 编译一组声明：按 `channelOrder` 做**稳定排序**（同值保持声明序），再逐条编译。
 * 排序复用 `trigger.mjs` 的 `orderTriggers`——声明路径与内联函数路径共用同一套调度语义。
 */
export function compileDeclarations(specs, context = {}) {
  if (!Array.isArray(specs)) throw new TypeError('trigger-spec: triggers must be an array')
  return orderTriggers(specs).map((spec) => compileDeclaration(spec, context))
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
        when: trigger.when,
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
