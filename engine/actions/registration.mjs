import { MAX_TRACKED_SESSIONS } from '../shared.mjs'
import { subjectOf } from '../conditions/subject.mjs'
import { ACTION_KINDS } from './catalog.mjs'

export function channelBinder(ctx, kind, plugin, prepend) {
  const legal = new Set(ACTION_KINDS[kind].events)
  return (event, handler, options) => {
    if (!legal.has(event)) {
      throw new TypeError(`${plugin}: action ${kind} must not register on ${JSON.stringify(event)} — legal channel(s): ${[...legal].join(', ')}`)
    }
    // `prepend` 只表达「落在宿主 waterfall 的最外层」（否决型动作如预算剥离需要它），
    // **不承担声明之间的排序**——同通道顺序由注册先后决定（见 trigger.mjs 的 R13 依据）。
    return ctx.on(event, handler, prepend === true ? { ...options, prepend: true } : options)
  }
}

const ON_REGISTERED_KINDS = new Set(['assembly', 'decision', 'append-context', 'sdk-strip', 'request-params', 'inbox-prepend', 'pre-step-filter'])

/** 编辑目录与注册校验共用支持面；不另给客户端维护一份名单。 */
export const actionSupportsWhen = (kind) => ON_REGISTERED_KINDS.has(kind)

/**
 * **没有 `next` 的通道**（官方 `@mode emit` / `@mode serial`）：注册在这些通道上的动作
 * 不能靠「`args` 的最后一个参数是 `next`」工作——判定路径与载荷切分都要走无 `next` 分支。
 *
 * 依据（`@deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts` 的逐事件 `@mode` 注释）：
 * **只有 `waterfall` 才有 `next`**；`agent/pre-step`／`agent/request` 是 waterfall，
 * 而 `agent/inbox/inserted`（B7 新增动作的通道）是 **emit**、
 * `agent/turn-stopping`（既有 append-context「续跑」的通道）是 **serial**——
 * 两者都没有 `next`。第三项此前是个隐患：`append-context(continue)` 一旦带 `when`，
 * 旧实现会把 `turn` 当成 `next` 调掉。
 */
export const NEXT_FREE_CHANNELS = new Set([
  'session/event',
  'agent/inbox/inserted',
  'agent/turn-stopping',
])

/** 动作的固定执行点；声明编译与 when 接线共用，不能用声明字段改变注册器。 */
export function actionExecutionPoint(action) {
  if (action.kind === 'decision') {
    return { channel: action.phase === 'post' ? 'tools/post-execute' : 'tools/pre-execute', phase: 'before-next' }
  }
  if (action.kind === 'append-context') {
    return action.mode === 'continue'
      ? { channel: 'agent/turn-stopping', phase: 'before-next' }
      : { channel: 'tools/post-execute', phase: 'after-next' }
  }
  if (action.kind === 'inject-text') {
    const layer = action.config?.layer
    const channel = {
      'pre-step': 'agent/pre-step',
      'system-section': 'system-prompt/assemble',
      'runtime-context': 'system-prompt/assemble',
      'agent-request': 'agent/request',
      'llm-stream': 'llm/stream',
      'turn-stop': 'agent/turn-stopping',
      'subagent-start': 'subagent/start',
      'subagent-end': 'subagent/end',
    }[layer]
    if (channel === undefined) {
      throw new TypeError(`inject-text layer ${JSON.stringify(layer)} has no single trigger channel; tool-pipeline uses separate decision actions`)
    }
    return { channel, phase: ['pre-step', 'agent-request'].includes(layer) ? 'after-next' : 'before-next' }
  }
  const channel = ACTION_KINDS[action.kind].events[0]
  return { channel, phase: NEXT_FREE_CHANNELS.has(channel) ? 'before-next' : 'after-next' }
}

/**
 * 每轮生效预算（动作声明的 `maxPerTurn`）。
 *
 * **为什么必须是动作侧、不能用 `count` 原语**：原 `deliberation-gate` 的 `gates` 与原
 * `progress-reminder` 的 `drips` 数的是**本动作自己生效了几次**，不是 durable 事件数。
 * 它们是纯增量状态（重启后从 0 开始、每轮重置），而 `count` 的模型是冷扫 durable 事件流重建
 * ——两者在重启/压缩后给出的答案不同，所以这是独立的一类计数。
 *
 * **轮号**取自 durable 事件的 `data.turn`（与 `predicates.mjs` 的 `trackTurn` 同规则：任何带
 * 有限轮号的事件都推进当前轮并取最大值），所以重启后计数虽从 0 开始，轮边界立刻是对的。
 *
 * **同步消耗**：动作通过目标与有效结果检查后，紧邻实际效果同步 `take()`；
 * claim 与效果之间没有 await，并行调用不得越过预算。
 *
 * @returns {{take: (subject: unknown) => boolean, observe: Function}|undefined} 无 `maxPerTurn` 时为 undefined
 */
export function createTurnBudget(max) {
  if (max === undefined) return undefined
  /** sessionId -> { turn, used }（纯增量，与原模块同语义：重启从 0 开始）。 */
  const budgets = new Map()
  const entryOf = (session) => {
    if (session?.id === undefined) return undefined
    let entry = budgets.get(session.id)
    if (entry === undefined) {
      if (budgets.size >= MAX_TRACKED_SESSIONS) budgets.clear()
      entry = { turn: undefined, used: 0 }
      budgets.set(session.id, entry)
    }
    return entry
  }
  return {
    /** 同步查/增；`false` = 本轮预算已尽，调用方按「不命中」放行下游。 */
    take(subject) {
      const session = subject?.session ?? subject?.agent?.session
      // 无会话不设限：与原模块「取不到会话条目即放行」的降级一致。
      const entry = entryOf(session)
      if (entry === undefined) return true
      if (entry.used >= max) return false
      entry.used += 1
      return true
    },
    /** 轮边界重置（取最大值，容忍乱序/重复事件）。 */
    observe(session, event) {
      const turn = event?.data?.turn
      if (typeof turn !== 'number' || !Number.isFinite(turn)) return
      const entry = entryOf(session)
      if (entry === undefined) return
      if (entry.turn === undefined || turn > entry.turn) {
        entry.turn = turn
        entry.used = 0
      }
    },
  }
}

/**
 * 按动作实际阶段求值 when。after-next 先结算下游，再读取当前 epoch，
 * 并向动作提供已结算结果，保证宿主 next 只调用一次；未命中或异常保持下游结果。
 * 每轮预算由各动作在目标匹配且即将生效时同步 claim，不在谓词入口扣减。
 *
 * **同步谓词走同步路径**：`tools/pre-execute` 这类通道的裁决靠「deny 前无 await」保证
 * 并行调用不越过预算（见 `deliberation-gate.mjs` 的注释），无条件 `await` 会破坏它。
 * 返回 Promise 的谓词退回异步路径——声明编译出的谓词恒同步，这条兜底是给手写调用方的。
 */
export function withWhen(on, when, warnOnce, phase) {
  if (typeof when !== 'function') return on
  // 注意参数个数：`on` 的签名是 `(event, handler, options)`——包装后的处理器必须占据
  // **第二个**位置，多传一个参数会把 options 挤到错位（首版就踩了这个，被测试抓出）。
  return (event, handler, options) => on(event, (...args) => {
    const nextFree = NEXT_FREE_CHANNELS.has(event)
    const payload = nextFree ? args : args.slice(0, -1)
    const pass = () => (nextFree ? undefined : args[args.length - 1]())
    // 谓词契约是**单个载荷对象**（见 predicates.mjs 头部的统一接口），而处理器收到的是
    // 事件参数表：按通道归一后再交给谓词——否则除 `names` 外，各原语在真实载荷上都
    // 取不到它们要的域（`phase` 曾因此恒为「已晋升」、`count` 恒 0）。
    const evaluate = (invoke, fallback) => {
      const decide = (decided) => decided === true ? invoke() : fallback()
      const failed = (error) => {
        warnOnce(`when predicate failed: ${String(error?.message ?? error)}`)
        return fallback()
      }
      let decided
      try {
        decided = when(subjectOf(event, payload, warnOnce))
      } catch (error) {
        return failed(error)
      }
      return decided !== null && typeof decided === 'object' && typeof decided.then === 'function'
        ? decided.then(decide, failed)
        : decide(decided)
    }
    if (!nextFree && phase === 'after-next') {
      return Promise.resolve(pass()).then((result) => evaluate(
        () => handler(...payload, () => result), () => result,
      ))
    }
    return evaluate(() => handler(...args), pass)
  }, options)
}
