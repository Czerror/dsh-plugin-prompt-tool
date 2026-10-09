/**
 * Epoch-aware promotion tracker shared by the bootstrap and baseline-gate
 * plugins of the anchored presets.
 *
 * A successful compaction rewrites the model-visible surface: the pre-compaction
 * conversation collapses into one synthetic summary message, and the
 * workspace-instruction baseline is re-injected from scratch. The first
 * post-compaction request is therefore a "second first request" — the same
 * first-token conditions the anchored presets exist to control. Promotion is
 * epoch-aware: only a durable promotion signal (`tool/call` and/or
 * `assistant/message`, per the caller's `promoteEvents`) recorded AFTER the
 * last successful `compaction/end` boundary counts as promoted. Before any compaction
 * the boundary is -1, which preserves the original one-shot semantics.
 * 重置判据看事件不看代次；理由与失效条件见 `isSuccessfulCompactionEnd`。
 *
 * State is memoized per session id and maintained incrementally through
 * `observe()`; a cold session scans its durable log once (so resume and
 * reload reconstruct the same phase), then O(1).
 *
 * By default subagents (`delegationDepth > 0`) are treated as already
 * promoted so their first request can use tools. Set `includeSubagents: true`
 * to make subagents follow the same bootstrap/anchor phase as top-level
 * sessions.
 *
 * GATE MODE (strict two-phase stabilization extension, source: xiaobright/dsh-anchored-standard
 * MIT + phase-1 quarantine): `promoteGate: true` gates the promotion on the
 * first reasoning block matching the caller's positive and negative patterns,
 * with a `maxPromoteSteps` fallback supplied by the caller's config; `promoteAfterFirstResponse:
 * true` promotes a tool-less first response once it has responded, and also
 * releases an anchor-gated session when its first turn ends. Gate mode uses
 * the durable-event state machine below and ignores `promoteEvents` (fixed
 * either semantics: `tool/call` and `assistant/message` are both tracked).
 * Non-gate mode keeps the original event-set semantics byte-for-byte.
 */

import { sessionState } from './shared.mjs'
import { historyEvents } from './history.mjs'

/** 匹配内容与大小写均由调用方显式声明；空 pattern 不承担任何业务识别。 */
function reasoningClassifier(options = {}) {
  const flags = options.reasoningFlags ?? ''
  if (typeof flags !== 'string') throw new TypeError('reasoningFlags must be a string')
  const compile = (key) => {
    const pattern = options[key]
    if (pattern == null || pattern === '') return undefined
    if (typeof pattern !== 'string') throw new TypeError(`${key} must be a string`)
    return new RegExp(pattern, flags.includes('g') ? flags : `${flags}g`)
  }
  const positive = compile('reasoningPattern')
  const negative = compile('reasoningNegativePattern')
  return text => {
    const trimmed = String(text ?? '').trim()
    // 旧诊断返回字段保留；两项现在分别计数调用方的正、负模式。分数不参与晋升。
    const we = positive === undefined ? 0 : [...trimmed.matchAll(positive)].length
    const letMe = negative === undefined ? 0 : [...trimmed.matchAll(negative)].length
    const metrics = { we, letMe }
    if (we > 0 && letMe === 0) return { label: 'minimal-like', score: 4, metrics }
    if (letMe > 0) return { label: 'standard-like', score: -4, metrics }
    return { label: 'ambiguous', score: 0, metrics }
  }
}

export function classifyReasoning(text, options = {}) { return reasoningClassifier(options)(text) }

/** 首段 reasoning 块是否为 minimal-like（后续块不覆盖首个标准样块）。 */
function firstReasoningMatches(content, classify) {
  if (!Array.isArray(content)) return false
  const first = content.find((block) => block?.type === 'reasoning')
  return first !== undefined && classify(first.text).label === 'minimal-like'
}

export function hasAnchoredReasoning(content, options = {}) { return firstReasoningMatches(content, reasoningClassifier(options)) }

/**
 * True only when compaction completed and changed the model-visible surface.
 *
 * 判据刻意是**事件维**（成功 `compaction/end`），不是 surface 的 `replaceGeneration` 代次：
 * 宿主对「一次已提交的位置替换」只给单调计数（`packages/core/session/src/surface.ts:569-572`），
 * 不说是哪一种，也不给边界。于是代次判据有三处改语义：① 非压缩的 replace（区域编辑 / 手动裁剪 /
 * 含 `surfaceOp: { op: 'replace' }` 的插件重写）同样推进代次，门控会被误重置；② 轮询只能得到
 * 一个整数，定不出边界给 `applyEvent` 的 `seq <= boundary` 守卫，压缩替身落地**之前**的事件会被
 * 当成新 epoch 的事件重新晋升（5b）；③ 无 surface / 无代次（恢复、重放、其它宿主、既有桩）时
 * 代次恒 undefined，压缩重置永不触发。压缩的**权威判定**因此还得看事件：宿主只在压缩时写
 * 无 `error` 的 `compaction/end`，而成功压缩必然伴随一次 replace。
 * ponytail: 近似而非权威 —— 失效条件：既不写 `compaction/end`、又靠 replace 重写可见上下文，
 * 或写了成功 `compaction/end` 却没改变可见上下文时，该重置误触发/漏触发。宿主给出「这次 replace
 * 是否压缩 + 边界 seq」的显式信号时改用它。
 */
export function isSuccessfulCompactionEnd(event) {
  return event?.type === 'compaction/end' && event.data?.error === undefined
}

/** Build one epoch-aware promotion tracker. */
export function createEpochPromotion(promoteEvents, options = {}) {
  const includeSubagents = options.includeSubagents === true
  const promoteGate = options.promoteGate === true
  const promoteAfterFirstResponse = options.promoteAfterFirstResponse === true
  const classify = reasoningClassifier(options)
  // 门控回退步数由调用方配置提供（tool-bootstrap 在开启门控时做必填校验）：
  // 引擎不内置默认；未提供时步数兜底不生效，只按 anchored 判定。
  const maxPromoteSteps = options.maxPromoteSteps
  const promote = new Set(promoteEvents)
  const gated = promoteGate || promoteAfterFirstResponse
  const freshEntry = (boundary) => ({
    boundary,
    promoted: false,
    toolCalled: false,
    responded: false,
    anchored: false,
    turnEnded: false,
    steps: 0,
  })

  /**
   * 会话 epoch 条目容器（`sessionState`：统一访问接口，键 / 淘汰 / 复位三项与迁移前逐条相同）。
   *
   * - 键类型：`session.id`。
   * - 淘汰策略：超 `MAX_TRACKED_SESSIONS` 时 `clear()` 全清（`evict` 缺省档），
   *   清空只触发一次冷扫重建，相位由 durable 事件流重建。
   * - 复位：**不声明**——压缩边界不是「删条目」：`applyEvent` 遇成功 `compaction/end`
   *   直接把条目重置为 `freshEntry(seq)` 新边界（见 `scan` / `observe`），条目本身必须留在
   *   容器里。声明 `reset` 只会多注册一条监听并改变语义，故 `ctx` 完全用不到、不传入。
   *
   * 无 `session.id` 的会话不记账（`sessionState` 既有决定，见 `predicates.mjs`）：`peek` 恒
   * 未命中 → 每次按该会话自己的 durable 事件流重建。旧实现把这类会话的条目存在共享的
   * `undefined` 键上（跨会话串味、且能把 `observe` 喂进来但不在事件流里的状态钉住），
   * 现在以 durable 事实为准——方向与「状态是快路径、真相在事件流」的纪律一致。
   */
  const state = sessionState(undefined, () => freshEntry(-1))

  /** 门控晋升判定（严格门控扩展）。 */
  const decideGate = (entry) => {
    if (entry.promoted) return true
    if (entry.toolCalled && !promoteGate) return true
    if (entry.toolCalled && promoteGate && (entry.anchored || entry.steps >= maxPromoteSteps)) return true
    if (entry.toolCalled && promoteGate && promoteAfterFirstResponse && entry.turnEnded) return true
    if (!entry.toolCalled && entry.responded && promoteAfterFirstResponse) return true
    return false
  }

  /** 应用一个事件；成功 compaction/end 返回新 entry（旧状态清零、boundary 前推）。 */
  const applyEvent = (entry, event) => {
    const seq = event.seq ?? 0
    if (isSuccessfulCompactionEnd(event)) return freshEntry(seq)
    if (seq <= entry.boundary) return entry
    if (gated) {
      if (event.type === 'tool/call') entry.toolCalled = true
      else if (event.type === 'step/start') entry.steps += 1
      else if (event.type === 'turn/end') entry.turnEnded = true
      else if (event.type === 'assistant/message') {
        entry.responded = true
        if (!entry.anchored) entry.anchored = firstReasoningMatches(event.data?.message?.content, classify)
      }
      if (decideGate(entry)) entry.promoted = true
      return entry
    }
    if (promote.has(event.type)) entry.promoted = true
    return entry
  }

  /**
   * Scan a session's durable log from scratch (cold start / resume).
   *
   * 判据来源**刻意是完整历史**（`historyEvents`，不是 `currentEvents`）：语义是「本会话在最后
   * 一次成功压缩之后**曾经** tool/call 过」——状态性的历史事实。压缩前的信号在 surface 上已
   * 不可见，按当前上下文冷启动会把 `promoted` 错判为 false，门控重回 bootstrap/锚定阶段、
   * 工具目录被裁剪。
   */
  const scan = (session) => {
    let entry = freshEntry(-1)
    for (const event of historyEvents(session)) entry = applyEvent(entry, event)
    state.set(session, entry)
    return entry
  }

  return {
    /**
     * Current phase of the agent's session.
     * @param agent - the assembly/pre-step agent, or undefined outside an agent.
     * @returns { boundary, promoted } — `boundary` is the last successful compaction/end
     *   seq (-1 before any compaction); `promoted` is true when a durable
     *   promotion signal exists after that boundary.
     */
    status(agent) {
      if (agent === undefined) return { boundary: -1, promoted: true }
      const session = agent.session
      if (session === undefined) return { boundary: -1, promoted: true }
      // By default subagents keep the full catalog from their very first
      // request; includeSubagents makes them follow the normal bootstrap phase.
      if (!includeSubagents && (session.header?.delegationDepth ?? 0) > 0) return { boundary: -1, promoted: true }
      return state.peek(session) ?? scan(session)
    },
    /** Incremental feed: call on every `session/event`. */
    observe(session, event) {
      const entry = state.peek(session)
      if (entry === undefined) return
      const next = applyEvent(entry, event)
      if (next !== entry) state.set(session, next)
    },
  }
}
