import { MAX_TRACKED_SESSIONS, extractText, isDelegated, sessionEvents } from '../shared.mjs'
import { sessionOf } from './subject.mjs'
import { boundOf, optionalBoolean } from './values.mjs'

const COUNT_SIGNALS = {
  'tool-call': { type: 'tool/call', measure: 'count' },
  'tool-result': { type: 'tool/result', measure: 'count' },
  'assistant-message': { type: 'assistant/message', measure: 'count' },
  'assistant-chars': { type: 'assistant/message', measure: 'chars' },
  'user-message': { type: 'user/message', measure: 'count' },
  turn: { type: 'turn/start', measure: 'count' },
}

/** 每会话最多保留的轮次计数（与 deliberation-gate 的 MAX_TRACKED_TURNS 同策略）。 */
const MAX_TRACKED_TURNS = 8

/** 轮边界事件：`per: 'turn'` 的当前轮由它与计数信号自身的轮号共同推进。 */
const TURN_EVENT = 'turn/start'

/**
 * 计数判断：次数 / 字符数 / 轮次，带上下限与**冷启动重建**。
 *
 *  - `per: 'session'` 计整个 durable log；`per: 'turn'` 只计**最新轮**，当前轮由
 *    `turn/start` 与计数信号自身带轮号的事件共同推进（与 deliberation-gate 的
 *    `turnOf` 同规则），轮号取自 `event.data.turn`；无轮号的事件不参与轮内计数
 *    （宁可少计，也不把跨轮数据算进当前轮）。
 *  - 冷启动：首次判定冷扫 `sessionEvents(session)` 重建（重启/恢复/重挂后同一结果），
 *    之后 O(1)；`observe` 是增量喂入，**只喂已判定过的会话**，避免「冷扫 + 增量」重复计数。
 *  - 上下限：`count >= min`（声明时）且 `count <= max`（声明时）。至少要声明一侧，
 *    否则该判定恒真——那是把配置错误伪装成命中。
 *  - 取不到会话 = 无事件 = 计数 0（与空会话同一语义，不发明数据）；无 `id` 的会话
 *    不记账（共享一个 Map 键会让两个会话串味），每次冷扫。
 *
 * @param {object} options
 * @param {'tool-call'|'tool-result'|'assistant-message'|'assistant-chars'|'user-message'|'turn'} options.of
 * @param {'session'|'turn'} [options.per] 缺省 session
 * @param {number} [options.min]
 * @param {number} [options.max]
 * @returns {((payload: unknown) => boolean) & { kind: string, observe: Function }}
 */
export function createCountPredicate(options = {}) {
  const signal = COUNT_SIGNALS[options.of]
  if (signal === undefined) {
    throw new TypeError(`predicates: count of must be one of ${Object.keys(COUNT_SIGNALS).join(', ')}`)
  }
  const per = options.per ?? 'session'
  if (per !== 'session' && per !== 'turn') {
    throw new TypeError('predicates: count per must be "session" or "turn"')
  }
  const min = boundOf(options.min, 'min')
  const max = boundOf(options.max, 'max')
  // 节奏判据（2026-09-22 用户拍板⑤「改用可重建计数」的核心语义）：`every: N` = 每 N 次命中一次。
  // 原 `progress-reminder` 的 `results % every === 0` 配的是**自增后**的计数
  // （声明侧见 `test/engine/declarations/progress-reminder.yml` 的 `count.every`），
  // 所以这里必须要求 `count > 0`——否则 `0 % N === 0` 会让第 0 次就命中。
  const every = options.every === undefined
    ? undefined
    : Number.isSafeInteger(options.every) && options.every > 0
      ? options.every
      : (() => { throw new TypeError('predicates: count every must be a positive integer') })()
  if (min === undefined && max === undefined && every === undefined) {
    throw new TypeError('predicates: a count predicate needs min, max or every')
  }
  // 计数时点对齐（2026-09-22 用户拍板「扩原语」）：某些通道的 `when` 在**处理器入口**求值，
  // 早于本次信号事件落盘——`tools/post-execute` 就是 `dsh-tools` 的
  // `finalizeScheduledExecution` 内部一环，而该包内不写 durable `tool/result`，落盘发生在
  // `execute()` 返回后的 agent loop。`includeCurrent: true` 把「本次触发即将成为的那个事件」
  // 计入，从而与模块自己的自增计数时点对齐。
  // **适用边界由声明者负责**：谓词看不到通道名，只有在「当前事件即将成为该信号」的通道上
  // 这个 +1 才成立（post-execute 上的 tool-result 成立；pre-execute 上的 tool-result 不成立）。
  const includeCurrent = optionalBoolean(options.includeCurrent, 'includeCurrent', false)
  // 受众判据（与 `session` 谓词的 `delegated` 同语义、同实现 `shared.isDelegated`）。
  // 需求的来源是原 `deliberation-gate` 与原 `progress-reminder`：这两个能力的
  // **主判据就是 count**，受众不能只挂在 `session` 谓词上——那会迫使声明额外耦合一个
  // durable 事件类型（还要回答「哪种 type 恒真」，而哨兵轮表明甚至可能没有轮事件）。
  const delegated = optionalBoolean(options.delegated, 'delegated', undefined)
  /** sessionId -> { total, turns, lastTurn }（进程内快路径，真相在 durable 事件流）。 */
  const state = new Map()
  const fresh = () => ({ total: 0, turns: new Map(), lastTurn: undefined })
  const measure = (event) => (signal.measure === 'chars' ? extractText(event.data).length : 1)
  /** 轮号推进：与 deliberation-gate 的 turnOf/turnEntryOf 同规则——`turn/start` 与
   *  计数信号自身带轮号的事件都推进当前轮，且取最大值；新轮先落 0，再累加。 */
  const trackTurn = (entry, turn) => {
    if (!entry.turns.has(turn)) {
      if (entry.turns.size >= MAX_TRACKED_TURNS) {
        const oldest = [...entry.turns.keys()]
          .sort((left, right) => left - right)
          .slice(0, entry.turns.size - MAX_TRACKED_TURNS + 1)
        for (const key of oldest) entry.turns.delete(key)
      }
      entry.turns.set(turn, 0)
    }
    if (entry.lastTurn === undefined || turn > entry.lastTurn) entry.lastTurn = turn
  }
  const applyEvent = (entry, event) => {
    const type = event?.type
    const turn = event?.data?.turn
    const tagged = typeof turn === 'number' && Number.isFinite(turn)
    if (per === 'turn' && tagged && (type === TURN_EVENT || type === signal.type)) trackTurn(entry, turn)
    if (type !== signal.type) return entry
    const amount = measure(event)
    if (per === 'session') {
      entry.total += amount
      return entry
    }
    // 轮内计数只认带轮号的事件（与 deliberation-gate 一致：宁可少计，也不把跨轮数据算进当前轮）。
    if (!tagged) return entry
    entry.turns.set(turn, (entry.turns.get(turn) ?? 0) + amount)
    return entry
  }
  const countOf = (entry) => (per === 'session'
    ? entry.total
    : (entry.lastTurn === undefined ? 0 : entry.turns.get(entry.lastTurn) ?? 0))
  const rebuild = (session) => {
    const entry = fresh()
    for (const event of sessionEvents(session)) applyEvent(entry, event)
    return entry
  }
  const entryOf = (session) => {
    if (session?.id === undefined) return rebuild(session)
    const known = state.get(session.id)
    if (known !== undefined) return known
    const entry = rebuild(session)
    if (state.size >= MAX_TRACKED_SESSIONS) state.clear()
    state.set(session.id, entry)
    return entry
  }
  const predicate = (payload) => {
    if (delegated !== undefined && isDelegated(sessionOf(payload)) !== delegated) return false
    const count = countOf(entryOf(sessionOf(payload))) + (includeCurrent ? 1 : 0)
    if (every !== undefined && (count === 0 || count % every !== 0)) return false
    return (min === undefined || count >= min) && (max === undefined || count <= max)
  }
  predicate.kind = 'count'
  predicate.observe = (session, event) => {
    const entry = session?.id === undefined ? undefined : state.get(session.id)
    if (entry !== undefined) applyEvent(entry, event)
  }
  return predicate
}
