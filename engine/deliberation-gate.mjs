/**
 * deliberation-gate — 轨迹深度门（上游 dsh-anchored-standard 移植, MIT）。
 *
 * 完整目录保持可见可调（会话观感正常），但首工具调用前深思不足就拒绝
 * 一次。以 durable `turn/start` 建立的当前轮预算 + `assistant/message` 的
 * reasoning/text 块长度作为"深思深度"代理——当前宿主不再发
 * `assistant/chunk`，观测层只有落盘的每步 assistant 消息与轮边界。
 *
 * 行为：
 *  - turn/start 建立本轮预算（深度 0、门计数 0）；assistant/message 把该轮
 *    可获得文本计入深度（只读 message.content，不读同一事件的 stream delta，
 *    避免双计）。tools/pre-execute 时当前轮深度 < minChars
 *    → { kind:'deny', reason: gateText }（规划式提示，措辞明示"非工具失败"），
 *    每轮最多 maxGatesPerTurn 次。
 *  - retry 把强制深思带进历史；无文本的轮 = 深度 0，恰好门一次
 *    （fail-safe 向更多深思）。
 *  - 冷启动从 durable log 扫描（重启保持深度），与实时 session/event 共用
 *    同一个事件处理函数；turn map 修剪（MAX_TRACKED_TURNS=8）；deny 前无
 *    await（并行调用无法竞态越过预算）。
 *  - 子代理默认不门控（brief 即计划）；includeSubagents: true 同门控。
 */

import { booleanOption, extractText, requiredInt, requiredText, sessionEvents, sessionMapGet, validateConfig } from './shared.mjs'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'deliberation-gate'

// 深思下限、每轮上限与门控指令无内置默认：取值与文案归组合源 / 预设
// （见 engine/compositions/source/local/deliberation-gate.yml）。

/** 每会话最多保留的轮次深度状态。 */
const MAX_TRACKED_TURNS = 8

/** Every config key this plugin accepts — anything else is a typo. */
const ALLOWED_KEYS = new Set(['enabled', 'minChars', 'maxGatesPerTurn', 'includeSubagents', 'gateText'])

/** 注册轨迹深度门。 */
export function apply(ctx, config) {
  const source = validateConfig(name, config, ALLOWED_KEYS)
  // 开关语义：未声明 = 关闭（需要默认开启时由组合源显式写 enabled: true）。
  if (source.enabled !== true) return
  const minChars = requiredInt(name, source.minChars, 'minChars', 0)
  const maxGatesPerTurn = requiredInt(name, source.maxGatesPerTurn, 'maxGatesPerTurn', 1)
  const includeSubagents = booleanOption(name, source.includeSubagents, 'includeSubagents', false)
  const gateText = requiredText(name, source.gateText, 'gateText')
  // 显式留空指令 = 不门控（没有拒绝说明就无法拒绝）。
  if (gateText === undefined) return

  /** sessionId -> { turns: Map<turn, { chars, gates }>, lastTurn } */
  const state = new Map()

  /** 取（或建）会话深度条目。 */
  const entryOf = (sessionId) => sessionMapGet(state, sessionId, () => ({ turns: new Map(), lastTurn: -1 }))

  /** 取（或建）轮条目；修剪旧轮，长会话不累积状态。 */
  const turnEntryOf = (entry, turn) => {
    let turnEntry = entry.turns.get(turn)
    if (turnEntry === undefined) {
      if (entry.turns.size >= MAX_TRACKED_TURNS) {
        const oldest = [...entry.turns.keys()].sort((a, b) => a - b).slice(0, entry.turns.size - MAX_TRACKED_TURNS + 1)
        for (const key of oldest) entry.turns.delete(key)
      }
      turnEntry = { chars: 0, gates: 0 }
      entry.turns.set(turn, turnEntry)
    }
    if (turn > entry.lastTurn) entry.lastTurn = turn
    return turnEntry
  }

  /** durable 事件里的轮号；缺失或非有限数即视为无轮号。 */
  const turnOf = (event) => {
    const turn = event?.data?.turn
    return typeof turn === 'number' && Number.isFinite(turn) ? turn : undefined
  }

  /**
   * 唯一事件处理函数：冷扫 durable log 与实时 session/event 共用，
   * 重启前后按同一份计数判定。
   */
  const observeEvent = (sessionId, event) => {
    if (event?.type === 'assistant/message') {
      const turn = turnOf(event)
      // 深度只计 message.content 的文本长度：不读同一事件的 stream delta（双计），
      // 也不留存原文。
      if (turn !== undefined) turnEntryOf(entryOf(sessionId), turn).chars += extractText(event.data).length
      return
    }
    if (event?.type !== 'turn/start') return
    const turn = turnOf(event)
    // 新轮预算：深度 0、门计数 0，该轮首次工具调用前重新要求深思。
    if (turn !== undefined) turnEntryOf(entryOf(sessionId), turn)
  }

  /** 会话深度状态；首见冷扫 durable log（重启保持已计深度）。 */
  const depthOf = (session) => {
    const known = state.get(session.id)
    if (known !== undefined) return known
    const entry = sessionMapGet(state, session.id, () => ({ turns: new Map(), lastTurn: -1 }))
    for (const event of sessionEvents(session)) observeEvent(session.id, event)
    if (entry.turns.size === 0) {
      // 无任何轮事件：深度视为 0 于哨兵轮，会话恰好门一次后放行。
      entry.turns.set(entry.lastTurn, { chars: 0, gates: 0 })
    }
    return entry
  }

  // 深度代理：durable turn/start + assistant/message，与冷扫同一个处理函数。
  ctx.on('session/event', (session, event) => {
    if (session?.id === undefined) return
    observeEvent(session.id, event)
  })

  // 门：同步决策，当前轮累计深度 < minChars 时最多 deny maxGatesPerTurn 次。
  ctx.on('tools/pre-execute', (exec, next) => {
    const session = exec?.agent?.session
    if (session === undefined || session.id === undefined) return next()
    if (!includeSubagents && (session.header?.delegationDepth ?? 0) > 0) return next()
    const entry = depthOf(session)
    const turnEntry = entry.turns.get(entry.lastTurn)
    if (turnEntry === undefined) return next()
    if (turnEntry.gates >= maxGatesPerTurn) return next()
    if (turnEntry.chars >= minChars) return next()
    turnEntry.gates += 1
    return { kind: 'deny', reason: gateText }
  })
}
