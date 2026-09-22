/**
 * trigger — 触发器引擎（B3）：把「声明」变成「注册」。
 *
 * 本文件负责调度层，**不含**判断原语与动作实现：
 *   - `when` 由 `engine/predicates.mjs` 提供（七类判断的组合）；
 *   - `do`   由 `engine/actions.mjs` 提供（七类动作）；
 *   - 本文件只做：声明校验（复用 B2 的 fields.mjs）、同通道内的稳定排序、
 *     宿主 waterfall 位置映射、注册与 disposer、降级与统一告警、会话态生命周期。
 *
 * ## 为什么排序必须由运行时自己做（R13 的权威依据）
 *
 * 官方 Cordis（`node_modules/@deepseek-ai/cordis/src/events.ts`）**没有数字排序**：
 *   - `:254-260` `register()` 只做 `options.prepend ? 'unshift' : 'push'`；
 *   - `:234-243` `waterfall()` 用 `cbs.shift()` 从链首取，所以 unshift 的监听器最先执行
 *     （最外层），而**多个 prepend 之间后注册的更靠前**；
 *   - `:228-229` 注释：不调用 `next()` 的监听器会否决其后整条链（含内置行为）。
 *
 * 因此调度必须拆成两个互不混淆的字段，**不得**用一个字段同时承担两件事：
 *   - `channelOrder: number`      —— **同一官方通道内**的声明顺序，本文件做有界稳定排序
 *                                    （升序，同值保持声明序），并标明动作在 `next()` 前还是后；
 *   - `waterfallPosition`         —— 适配器在宿主 waterfall 中的位置，只有 `'outermost'`
 *                                    才映射为 `prepend: true`，**不承担**声明间排序。
 *
 * **跨九层的全局调度禁止**：官方九层插入点彼此独立，`prepend` 也不得替代执行层 guard
 * 的单调边界（那是 `ctx.tools.guard()` 的职责，见 B3 T2 的动作 (5)）。
 *
 * ## 声明载体约定（与 T4 的能力提供者边界守卫对齐）
 *
 * 本文件导出的是**引擎本身**（`mountTriggers` / `orderTriggers` / `validateTrigger` /
 * `registrationOptions` / `createDecisionLog` 等函数与常量），**不是**某个模块的触发器声明。
 * 声明由**消费方模块**导出，约定名为 `engineTriggers`（数组，元素交给 `validateTrigger`）；
 * 它与能力提供者的 `engineProvider` 登记**互斥**——同一模块不得同时导出两者，
 * 该互斥由 `test/engine/provider-boundary.test.mjs` 直接断言。
 * 因此「某个模块是触发器还是提供者」看的是它导出了哪一个，而不是它 import 了什么。
 *
 * ## 与 predicates 的接线要点（T1 交付时确认的事实）
 *
 *   - `when` 直接接 `createXxxPredicate(...)` 的返回值——它们是**函数**，`await when(...)` 原生兼容；
 *   - **相位 / 计数**两类谓词带 `observe(session, event)` 入口：本文件在同组声明上**共用一条**
 *     `session/event` 监听喂它们（不按触发器各接一条），且没有这类谓词时**不接**（零开销）；
 *   - **当前预设**类需在**挂载期一次** `await loadStandingMountFor()`，把结果传进
 *     `createPresetPredicate({ ctx, presetId, standingMountFor })`，这样判定期零 IO；
 *   - 谓词**运行期不抛**（配置错误在挂载期 fail loud），所以 `when` 的 try/catch 是兜底而非主路径。
 *
 * ## `state`：会话态声明的最小接口（B4 迁移的契约基准）
 *
 * `state` 是**声明**（该触发器需要什么会话态），不是运行时对象：运行时的会话态一律经
 * `engine/shared.mjs` 的既有读法取得，**不新造接口、不新造存储通道**。B4 迁移既有模块时
 * 只允许依赖下面这一组，超出即是新发明的接口，须先回到本文件扩契约：
 *
 *   | 读取               | 既有实现                          | 最小形状                       |
 *   |--------------------|-----------------------------------|--------------------------------|
 *   | 会话标识（记账键） | `session.id`                      | `string \| undefined`          |
 *   | durable 事件快照   | `shared.sessionEvents(session)`   | `{ type, data? }[]`，缺接口=空 |
 *   | 轮号               | 各模块内联 `event.data.turn`      | 有限 `number`，缺失=无轮号     |
 *   | 子代理判定         | `shared.isDelegated(session)`     | `header.delegationDepth > 0`   |
 *   | 会话态 Map 上限    | `shared.MAX_TRACKED_SESSIONS`     | 超出整体清空（触发冷扫重建）   |
 *
 * 三条纪律：**(1)** 没有 `session.id` 的会话一律不记账（`predicates.mjs:343` 的既有决定：
 * 共用一个 Map 键会让两个会话串味），每次冷扫而非缓存；**(2)** 子代理判定复用
 * `isDelegated`，不写字面量比较（原 `progress-reminder` 的 `== 0` 判定与它是同一语义的
 * 两种写法，B4 迁移时统一到前者，行为不变）；**(3)** `snapshotEvents()` 是正式 API
 * （DSH 0.1.2-alpha.4+），缺失时按空日志处理——**不得**回退读旧的 `events` 数组。
 *
 * **给 B4 的边界（B4 PLAN 的措辞与本文件不一致处，以此为准）**：B4 计划里的
 * `session(create, { resetOn })` **不能放进 `shared.mjs`**——`resetOn` 是复位时机，要落地
 * 就得在挂载期注册 `session/event` 监听，而 `shared.mjs` 是**没有 `ctx` 的纯函数模块**
 * （现有导出全是无状态工具）。B4 的统一访问接口须满足：**(a)** 接收挂载期 `ctx`（或由
 * `mountTriggers` 一侧构造），**(b)** 建在本节这组既有读法之上、**不新造事件类型或持久通道**，
 * **(c)** 逐模块保留原有键类型与淘汰策略（`Map<session.id>` / `WeakMap<session 对象>` /
 * 无上限），**(d)** `resetOn` 按**状态字段**声明，不是按模块（`tool-bootstrap` 的
 * `stage` 与 `promotion` 两个字段策略相反，是这条的现成反例）。
 */

import { subjectOf } from './predicates.mjs'

/**
 * 本文件此前**零 import**（`when` / `do` / `warnOnce` 全由调用方注入，会话态读法经 `ctx`
 * 取得）。唯一新增的依赖是谓词的**输入契约** `subjectOf`：调度层调用 `when` 时必须先把
 * 事件参数表归一为**单个载荷对象**（契约见 `predicates.mjs` 头部），否则除 `names` 外，
 * 各原语在真实通道上都取不到它们要的域——`phase` 曾因此恒为「已晋升」、`count` 恒为 0。
 * 声明路径同源：`actions.mjs` 的 `withWhen` 用同一函数归一。
 */

/** 声明里的合法位置取值（与 events.ts 的布尔注册策略一一对应）。 */
export const WATERFALL_POSITIONS = new Set(['default', 'outermost'])

/** 动作在 `next()` 之前还是之后执行 —— 影响同通道内的可观测顺序。 */
export const ACTION_PHASES = new Set(['before-next', 'after-next'])

/**
 * 同通道内的稳定排序：`channelOrder` 升序，同值保持**声明序**。
 * 稳定是硬要求：同值声明的相对顺序若随排序实现变化，声明就不可预测。
 */
export function orderTriggers(declarations) {
  const list = Array.isArray(declarations) ? declarations : []
  return list
    .map((declaration, index) => ({ declaration, index }))
    .sort((left, right) => {
      const delta = left.declaration.channelOrder - right.declaration.channelOrder
      return delta !== 0 ? delta : left.index - right.index
    })
    .map((entry) => entry.declaration)
}

/**
 * 把声明的位置字段映射为 Cordis 的注册选项。
 * 只有 `'outermost'` 才 prepend —— 这是**位置**，不是排序；同通道顺序归 `orderTriggers`。
 */
export function registrationOptions(declaration) {
  return declaration.waterfallPosition === 'outermost' ? { prepend: true } : {}
}

/**
 * 校验一条触发器声明：
 *  - 必填：`id`（非空串）、`channel`（官方事件名）、`when`（判定函数）、`do`（动作函数）；
 *  - `channelOrder` 缺省 0（非负安全整数）、`waterfallPosition` 缺省 `'default'`、
 *    `phase` 缺省 `'after-next'`、`degrade` 缺省告警并跳过本触发器。
 * 未知字段一律 fail loud：声明写错键名是最容易被静默忽略的一类错。
 */
export function validateTrigger(declaration, plugin) {
  if (declaration === null || typeof declaration !== 'object' || Array.isArray(declaration)) {
    throw new TypeError(`${plugin}: trigger declaration must be an object`)
  }
  const known = new Set(['id', 'channel', 'channelOrder', 'waterfallPosition', 'phase', 'when', 'do', 'degrade', 'state'])
  const unknown = Object.keys(declaration).filter((key) => !known.has(key))
  if (unknown.length > 0) {
    throw new TypeError(`${plugin}: unknown trigger field(s) ${unknown.join(', ')} — allowed: ${[...known].sort().join(', ')}`)
  }
  if (typeof declaration.id !== 'string' || declaration.id.length === 0) {
    throw new TypeError(`${plugin}: trigger.id must be a non-empty string`)
  }
  if (typeof declaration.channel !== 'string' || declaration.channel.length === 0) {
    throw new TypeError(`${plugin}: trigger ${declaration.id}: channel must be a non-empty event name`)
  }
  if (typeof declaration.when !== 'function') {
    throw new TypeError(`${plugin}: trigger ${declaration.id}: when must be a predicate function`)
  }
  if (typeof declaration.do !== 'function') {
    throw new TypeError(`${plugin}: trigger ${declaration.id}: do must be an action function`)
  }
  const channelOrder = declaration.channelOrder ?? 0
  if (!Number.isSafeInteger(channelOrder) || channelOrder < 0) {
    throw new TypeError(`${plugin}: trigger ${declaration.id}: channelOrder must be a non-negative safe integer`)
  }
  const waterfallPosition = declaration.waterfallPosition ?? 'default'
  if (!WATERFALL_POSITIONS.has(waterfallPosition)) {
    throw new TypeError(`${plugin}: trigger ${declaration.id}: waterfallPosition must be one of ${[...WATERFALL_POSITIONS].join(', ')}`)
  }
  const phase = declaration.phase ?? 'after-next'
  if (!ACTION_PHASES.has(phase)) {
    throw new TypeError(`${plugin}: trigger ${declaration.id}: phase must be one of ${[...ACTION_PHASES].join(', ')}`)
  }
  return {
    id: declaration.id,
    channel: declaration.channel,
    channelOrder,
    waterfallPosition,
    phase,
    when: declaration.when,
    do: declaration.do,
    degrade: declaration.degrade ?? 'skip',
    state: declaration.state,
  }
}

/**
 * 决策链诊断（T5）：把「这次为什么没生效」变成一次可读的输出。
 *
 * 借鉴 dsh-agent-studio 的 `reportFirstDecision`（`apply.ts:238-250`）：一次装配看起来
 * 没生效时，原因可能有多种而**结果长得一样** —— 取不到 agent/session、触发器未启用、
 * 谓词未命中、动作被外层门控剥离、判定走了降级。逐项试太慢，所以按顺序记一条链。
 *
 * 约束（PLAN T5 的 security）：
 *   - **每会话只输出一次**（按 sessionId 去重）；
 *   - 只记录触发器 id、通道、判定结果、动作是否执行、是否走降级 ——
 *     **绝不打印消息正文、变量值或用户内容**；
 *   - 默认关闭时零额外日志；日志自身抛错不得影响装配。
 *
 * **flush 由调用方驱动**：引擎无法知道「一轮装配」何时结束（同一通道可能有多个触发器、
 * 跨通道还会继续判定），所以 `mountTriggers` 只 `step`（累积到内存），
 * 由最外层监听器在整轮处理结束时调一次 `flush`。在步与步之间提前 flush 会输出**不完整的链**
 * —— 那正是本文件最初实现踩过的坑（被 T5 自己的断言抓出来）。
 */
export function createDecisionLog({ enabled = false, logger, sessionOf } = {}) {
  const reported = new Set()
  const pending = new Map()
  // args 有两种形状：step 收到的是 handler 的完整参数数组，调用方 flush 时可能只给 payload。
  // 两种都要归一到同一个 key —— 否则 step 存 's-1'、flush 查 '<no-session>'，链永远输出不出来
  //（这正是 T5 断言抓到的现象：logged.length 恒为 0）。
  const keyOf = (args) => {
    try {
      const values = Array.isArray(args) ? args : [args]
      return String(sessionOf?.(...values) ?? '<no-session>')
    } catch {
      return '<no-session>'
    }
  }
  return {
    /** 记一步（只入内存，不输出）。 */
    step(args, line) {
      if (!enabled) return
      const key = keyOf(args)
      const lines = pending.get(key) ?? []
      lines.push(line)
      pending.set(key, lines)
    },
    /** 该会话的链只输出一次；失败静默 —— 日志不得影响装配。 */
    flush(args) {
      if (!enabled) return
      const key = keyOf(args)
      if (reported.has(key)) return
      const lines = pending.get(key)
      if (lines === undefined || lines.length === 0) return
      reported.add(key)
      try {
        logger?.info?.(`[trigger-decision] session=${key} :: ${lines.join(' | ')}`)
      } catch {
        // 日志失败不得影响装配。
      }
    },
  }
}

/**
 * 注册一组触发器。
 *
 * 每个触发器在**自己的合法通道**上注册一次；`when` 抛错按 `degrade` 处理
 * （默认 `'skip'`：告警一次并跳过本次，**不吞掉下游异常** —— 只有本触发器自身的
 * 判定失败才降级，`next()` 之后的错误照常向上抛）。
 *
 * @returns disposer：注销本组全部监听器。
 */
/**
 * 把 `session/event` 喂给带 `observe(session, event)` 入口的谓词（相位 / 计数两类）。
 *
 * 同一组声明**共用一条**监听（不按触发器各接一条，避免 N 倍监听）；没有这类谓词时
 * **不接**（返回 `undefined`，零开销）。观察者自身抛错只告警、不影响其它触发器
 * ——与判定失败的降级纪律一致。
 *
 * 两条调用路径共用它：`mountTriggers`（`do` 是函数的内联路径）与
 * `trigger-spec.mjs` 的 `mountDeclarations`（`do` 是动作声明的路径）。
 *
 * @returns disposer，或 `undefined`（本组无观察者）
 */
export function wireTriggerObservers(ctx, triggers, { plugin, warnOnce } = {}) {
  const warn = typeof warnOnce === 'function' ? warnOnce : () => {}
  const observers = triggers.filter((trigger) => typeof trigger.when?.observe === 'function')
  if (observers.length === 0) return undefined
  return ctx.on('session/event', (session, event) => {
    for (const trigger of observers) {
      try {
        trigger.when.observe(session, event)
      } catch (error) {
        warn(`${plugin}: trigger ${trigger.id} observe failed: ${String(error?.message ?? error)}`)
      }
    }
  })
}

export function mountTriggers(ctx, declarations, { plugin, warnOnce, diagnose } = {}) {
  const warn = typeof warnOnce === 'function' ? warnOnce : () => {}
  const disposers = []
  const ordered = orderTriggers(declarations).map((raw) => validateTrigger(raw, plugin))

  // 会话态生命周期：共用 `wireTriggerObservers`（与声明路径同一实现）。
  const observer = wireTriggerObservers(ctx, ordered, { plugin, warnOnce: warn })
  if (observer !== undefined) disposers.push(observer)

  for (const trigger of ordered) {
    const handler = async (...args) => {
      const next = args[args.length - 1]
      const payload = args.slice(0, -1)
      let decided
      try {
        decided = await trigger.when(subjectOf(trigger.channel, payload, warn))
      } catch (error) {
        // 判定失败只影响本触发器：告警一次并放行下游（expose-all 语义）。
        warn(`${plugin}: trigger ${trigger.id} predicate failed: ${String(error?.message ?? error)}`)
        diagnose?.step(args, `${trigger.id}@${trigger.channel} predicate=error action=skipped`)
        return next()
      }
      if (decided !== true) {
        diagnose?.step(args, `${trigger.id}@${trigger.channel} predicate=miss action=skipped`)
        return next()
      }
      diagnose?.step(args, `${trigger.id}@${trigger.channel} predicate=hit phase=${trigger.phase} action=ran`)
      if (trigger.phase === 'before-next') {
        // 返回值参与瀑布：裁决类动作在 `next()` **之前**给出终局（deny/ask），
        // 不返回值即「无话可说」，交给下游（与「只 guard 自身逻辑」一致）。
        const early = await trigger.do(...payload)
        return early === undefined ? next() : early
      }
      const result = await next()
      // 返回值同样参与瀑布：这正是裁决类动作（deny / ask / replace / block）的出口
      // ——丢弃它会让「命中却拦不住」，是本文件被 trigger-rebuild 对拍抓到的缺陷。
      const overridden = await trigger.do(...payload, result)
      return overridden === undefined ? result : overridden
    }
    disposers.push(ctx.on(trigger.channel, handler, registrationOptions(trigger)))
  }
  return () => { for (const dispose of disposers) dispose() }
}
