/**
 * cot-drip — 执行期深思维持节拍（上游 dsh-anchored-standard 移植, MIT）。
 *
 * 锚定模式在每轮开场有深思考，但长工具循环中深思会衰减（后期步骤退化
 * 回 "Let me…"）。本模块每 N 次工具结果向对话滴入一条短 user 提醒——
 * 永不阻塞、永不报错、不碰工具目录：
 *
 *   `tools/post-execute` → { kind: 'accept', additionalContexts: [notice] }
 *
 * harness 把 additionalContexts 作为 durable user 消息追加在整批工具结果
 * 之后，落在下一请求的规划节拍位（与 Code Mode 嵌套上下文同形状）。
 * 模型读到后以一句 "We …" 重申剩余目标并继续。
 *
 * 节奏刻意温和：默认 every: 4 次结果、每轮最多 maxPerTurn: 1 条；
 * every: 0 禁用。计数在 await 前同步自增（并行调用无法竞态越过节奏）；
 * 轮边界由 durable turn/start + assistant/chunk 双路跟踪（无轮号时降级
 * session 全局）；子代理默认不滴（brief 即计划）。
 */

import { booleanOption, validateConfig } from './shared.mjs'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'cot-drip'

/** 默认提醒文本——一条规划节拍，措辞维持 "We" 语态。 */
export const DRIP_TEXT = [
  'Progress check: before the next action, restate in one "We …" sentence what remains of the goal and why the next step is the right one.',
].join(' ')

/** Every config key this plugin accepts — anything else is a typo. */
const ALLOWED_KEYS = new Set(['enabled', 'every', 'maxPerTurn', 'includeSubagents', 'text'])

function parseCounter(value, field, fallback, minimum) {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < minimum) {
    throw new TypeError(`${name}: ${field} must be an integer >= ${minimum}; got ${JSON.stringify(value)}`)
  }
  return value
}

/** 注册执行后深思滴入。 */
export function apply(ctx, config) {
  const source = validateConfig(name, config, ALLOWED_KEYS)
  if (source.enabled === false) return
  const every = parseCounter(source.every, 'every', 4, 0)
  const maxPerTurn = parseCounter(source.maxPerTurn, 'maxPerTurn', 1, 1)
  const includeSubagents = booleanOption(name, source.includeSubagents, 'includeSubagents', false)
  const text = typeof source.text === 'string' && source.text.length > 0 ? source.text : DRIP_TEXT

  /** sessionId -> { results, drips, lastTurn } — 每轮计数。 */
  const state = new Map()

  const countersOf = (sessionId) => {
    let entry = state.get(sessionId)
    if (entry === undefined) {
      entry = { results: 0, drips: 0, lastTurn: undefined }
      state.set(sessionId, entry)
    }
    return entry
  }

  let warned = false
  const warnOnce = (message) => {
    if (warned) return
    warned = true
    try {
      ctx.logger.warn(message)
    } catch {
      // Logger unavailable — the guard exists only to avoid spamming.
    }
  }

  // 轮跟踪：turn/start 重置计数；无可用轮号时用 assistant/chunk 的新轮。
  ctx.on('session/event', (session, event) => {
    if (session === undefined || session.id === undefined) return
    if (event.type === 'turn/start') {
      const turn = event.data?.turn
      const entry = countersOf(session.id)
      if (entry.lastTurn !== turn) {
        entry.lastTurn = typeof turn === 'number' ? turn : entry.lastTurn
        entry.results = 0
        entry.drips = 0
      }
      return
    }
    if (event.type === 'assistant/chunk') {
      const turn = event.data?.turn
      if (typeof turn !== 'number') return
      const entry = countersOf(session.id)
      if (entry.lastTurn === undefined || turn > entry.lastTurn) {
        entry.lastTurn = turn
        entry.results = 0
        entry.drips = 0
      }
    }
  })

  ctx.on('tools/post-execute', async (exec, result, next) => {
    // await 前同步计数，并行调用不能竞态越过节奏。
    const session = exec?.agent?.session
    const eligible = session !== undefined
      && session.id !== undefined
      && (includeSubagents || (session.header?.delegationDepth ?? 0) === 0)
    const entry = eligible ? countersOf(session.id) : undefined
    if (entry !== undefined) entry.results += 1
    const due = entry !== undefined
      && every > 0
      && entry.results % every === 0
      && entry.drips < maxPerTurn

    const decision = await next()
    try {
      if (!due || decision?.kind !== 'accept') return decision
      entry.drips += 1
      const notice = {
        id: typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `cot-drip-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        role: 'user',
        content: [{ type: 'text', text }],
        source: {
          kind: 'plugin',
          plugin: name,
          form: 'notice',
          summary: 'deliberation maintenance beat',
        },
      }
      return {
        ...decision,
        additionalContexts: [...(decision.additionalContexts ?? []), notice],
      }
    } catch (error) {
      warnOnce(`${name}: drip injection failed, keeping the plain result: ${String((error && error.message) || error)}`)
      return decision
    }
  })
}
