/**
 * deliberation-gate — 轨迹深度门（上游 dsh-anchored-standard 移植, MIT）。
 *
 * 完整目录保持可见可调（会话观感正常），但首工具调用前深思不足就拒绝
 * 一次。以 durable `assistant/chunk` 的 text/reasoning delta 累计长度作为
 * "深思深度"代理（adapter 无 logprobs，观测层只有流式 chunk）。
 *
 * 行为：
 *  - session/event 累计每轮流式长度；tools/pre-execute 时当前轮深度
 *    < minChars（默认 400）→ { kind:'deny', reason: gateText }（规划式
 *    提示，措辞明示"非工具失败"），每轮最多 maxGatesPerTurn 次（默认 1）。
 *  - retry 把强制深思带进历史；无流式文本的轮 = 深度 0，恰好门一次
 *    （fail-safe 向更多深思）。
 *  - 冷启动从 durable log 扫描（重启保持深度）；turn map 修剪
 *    （MAX_TRACKED_TURNS=8）；deny 前无 await（并行调用无法竞态越过预算）。
 *  - 子代理默认不门控（brief 即计划）；includeSubagents: true 同门控。
 */

import { MAX_TRACKED_SESSIONS, booleanOption, validateConfig } from './shared.mjs'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'deliberation-gate'

/** 默认深思下限（每轮首工具调用前，字符数）。 */
export const DEFAULT_MIN_CHARS = 400

/** 默认门控指令（拒绝回传的规划提示）。 */
export const GATE_TEXT = [
  'Deliberation gate: this turn has not shown its reasoning yet.',
  'Before retrying this tool call, write out your full reasoning in your reply — start with "We", restate the goal, weigh the approaches, and lay out the concrete steps and risks — then issue the tool call again.',
  'This message is a planning prompt, not a tool failure.',
].join(' ')

/** 每会话最多保留的轮次深度状态。 */
const MAX_TRACKED_TURNS = 8

/** Every config key this plugin accepts — anything else is a typo. */
const ALLOWED_KEYS = new Set(['enabled', 'minChars', 'maxGatesPerTurn', 'includeSubagents', 'gateText'])

function parseCounter(value, field, fallback, minimum) {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < minimum) {
    throw new TypeError(`${name}: ${field} must be an integer >= ${minimum}; got ${JSON.stringify(value)}`)
  }
  return value
}

/** 注册轨迹深度门。 */
export function apply(ctx, config) {
  const source = validateConfig(name, config, ALLOWED_KEYS)
  if (source.enabled === false) return
  const minChars = parseCounter(source.minChars, 'minChars', DEFAULT_MIN_CHARS, 0)
  const maxGatesPerTurn = parseCounter(source.maxGatesPerTurn, 'maxGatesPerTurn', 1, 1)
  const includeSubagents = booleanOption(name, source.includeSubagents, 'includeSubagents', false)
  const gateText = typeof source.gateText === 'string' && source.gateText.length > 0 ? source.gateText : GATE_TEXT

  /** sessionId -> { turns: Map<turn, { chars, gates }>, lastTurn } */
  const state = new Map()

  /** 实时路径：每条流式 chunk 扩展轮条目。 */
  const observeChunk = (sessionId, turn, textLength) => {
    let entry = state.get(sessionId)
    if (entry === undefined) {
      if (state.size >= MAX_TRACKED_SESSIONS) state.clear()
      entry = { turns: new Map(), lastTurn: turn }
      state.set(sessionId, entry)
    }
    let turnEntry = entry.turns.get(turn)
    if (turnEntry === undefined) {
      // 修剪旧轮，长会话不累积状态。
      if (entry.turns.size >= MAX_TRACKED_TURNS) {
        const oldest = [...entry.turns.keys()].sort((a, b) => a - b).slice(0, entry.turns.size - MAX_TRACKED_TURNS + 1)
        for (const key of oldest) entry.turns.delete(key)
      }
      turnEntry = { chars: 0, gates: 0 }
      entry.turns.set(turn, turnEntry)
    }
    turnEntry.chars += textLength
    if (turn > entry.lastTurn) entry.lastTurn = turn
  }

  /** 会话深度状态；首见冷扫 durable log（重启保持已流式深度）。 */
  const depthOf = (session) => {
    let entry = state.get(session.id)
    if (entry === undefined) {
      if (state.size >= MAX_TRACKED_SESSIONS) state.clear()
      entry = { turns: new Map(), lastTurn: -1 }
      if (Array.isArray(session.events)) {
        for (const event of session.events) {
          if (event.type !== 'assistant/chunk') continue
          const turn = event.data?.turn
          if (typeof turn !== 'number' || !Number.isFinite(turn)) continue
          const text = event.data?.chunk?.text
          observeChunk(session.id, turn, typeof text === 'string' ? text.length : 0)
        }
        entry = state.get(session.id) ?? entry
      }
      if (entry.turns.size === 0) {
        // 无任何流式文本：深度视为 0 于哨兵轮，会话恰好门一次后放行。
        entry.turns.set(entry.lastTurn, { chars: 0, gates: 0 })
      }
      state.set(session.id, entry)
    }
    return entry
  }

  // 深度代理：累计 durable assistant/chunk 的流式长度。
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'assistant/chunk') return
    const turn = event.data?.turn
    if (typeof turn !== 'number' || !Number.isFinite(turn)) return
    const text = event.data?.chunk?.text
    observeChunk(session.id, turn, typeof text === 'string' ? text.length : 0)
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
