/**
 * Epoch-aware promotion tracker shared by the bootstrap and baseline-gate
 * plugins of the anchored presets.
 *
 * A compaction rewrites the model-visible surface: the pre-compaction
 * conversation collapses into one synthetic summary message, and the
 * workspace-instruction baseline is re-injected from scratch. The first
 * post-compaction request is therefore a "second first request" — the same
 * first-token conditions the anchored presets exist to control. Promotion is
 * epoch-aware: only a durable promotion signal (`tool/call` and/or
 * `assistant/message`, per the caller's `promoteEvents`) recorded AFTER the
 * last `compaction/end` boundary counts as promoted. Before any compaction
 * the boundary is -1, which preserves the original one-shot semantics.
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
 * GATE MODE (liangshen 稳定化扩展, source: xiaobright/dsh-anchored-standard
 * MIT + phase-1 quarantine): `promoteGate: true` gates the promotion on the
 * first reasoning block classifying minimal-like (`we` present, no `let me`),
 * with a `maxPromoteSteps` (default 4) fallback; `promoteAfterFirstResponse:
 * true` promotes a tool-less first response once it has responded, and also
 * releases an anchor-gated session when its first turn ends. Gate mode uses
 * the durable-event state machine below and ignores `promoteEvents` (fixed
 * either semantics: `tool/call` and `assistant/message` are both tracked).
 * Non-gate mode keeps the original event-set semantics byte-for-byte.
 */

import { MAX_TRACKED_SESSIONS } from './shared.mjs'

/** 首段 reasoning 块分类（liangshen 移植）：we 且无 let me = minimal-like。 */
export function classifyReasoning(text) {
  const trimmed = String(text ?? '').trim()
  const we = [...trimmed.matchAll(/\bwe\b/gi)].length
  const letMe = [...trimmed.matchAll(/\blet me\b/gi)].length
  const metrics = { we, letMe }
  if (we > 0 && letMe === 0) return { label: 'minimal-like', score: 4, metrics }
  if (letMe > 0) return { label: 'standard-like', score: -4, metrics }
  return { label: 'ambiguous', score: 0, metrics }
}

/** 首段 reasoning 块是否为 minimal-like（后续块不覆盖首个标准样块）。 */
export function hasAnchoredReasoning(content) {
  if (!Array.isArray(content)) return false
  const first = content.find((block) => block?.type === 'reasoning')
  return first !== undefined && classifyReasoning(first.text).label === 'minimal-like'
}

/** Build one epoch-aware promotion tracker. */
export function createEpochPromotion(promoteEvents, options = {}) {
  const includeSubagents = options.includeSubagents === true
  const promoteGate = options.promoteGate === true
  const promoteAfterFirstResponse = options.promoteAfterFirstResponse === true
  const maxPromoteSteps = Number.isSafeInteger(options.maxPromoteSteps) && options.maxPromoteSteps > 0
    ? options.maxPromoteSteps
    : 4
  const promote = new Set(promoteEvents)
  const gated = promoteGate || promoteAfterFirstResponse
  /** sessionId -> entry（boundary/promoted + 门控字段） */
  const state = new Map()

  const freshEntry = (boundary) => ({
    boundary,
    promoted: false,
    toolCalled: false,
    responded: false,
    anchored: false,
    turnEnded: false,
    steps: 0,
  })

  /** 门控晋升判定（liangshen decidePromotion 移植）。 */
  const decideGate = (entry) => {
    if (entry.promoted) return true
    if (entry.toolCalled && !promoteGate) return true
    if (entry.toolCalled && promoteGate && (entry.anchored || entry.steps >= maxPromoteSteps)) return true
    if (entry.toolCalled && promoteGate && promoteAfterFirstResponse && entry.turnEnded) return true
    if (!entry.toolCalled && entry.responded && promoteAfterFirstResponse) return true
    return false
  }

  /** 应用一个事件；compaction/end 返回新 entry（旧状态清零、boundary 前推）。 */
  const applyEvent = (entry, event) => {
    const seq = event.seq ?? 0
    if (event.type === 'compaction/end') return freshEntry(seq)
    if (seq <= entry.boundary) return entry
    if (gated) {
      if (event.type === 'tool/call') entry.toolCalled = true
      else if (event.type === 'step/start') entry.steps += 1
      else if (event.type === 'turn/end') entry.turnEnded = true
      else if (event.type === 'assistant/message') {
        entry.responded = true
        if (!entry.anchored) entry.anchored = hasAnchoredReasoning(event.data?.message?.content)
      }
      if (decideGate(entry)) entry.promoted = true
      return entry
    }
    if (promote.has(event.type)) entry.promoted = true
    return entry
  }

  /** Scan a session's durable log from scratch (cold start / resume). */
  const scan = (session) => {
    let entry = freshEntry(-1)
    for (const event of session.events) entry = applyEvent(entry, event)
    if (state.size >= MAX_TRACKED_SESSIONS) state.clear()
    state.set(session.id, entry)
    return entry
  }

  return {
    /**
     * Current phase of the agent's session.
     * @param agent - the assembly/pre-step agent, or undefined outside an agent.
     * @returns { boundary, promoted } — `boundary` is the last compaction/end
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
      return state.get(session.id) ?? scan(session)
    },
    /** Incremental feed: call on every `session/event`. */
    observe(session, event) {
      const entry = state.get(session.id)
      if (entry === undefined) return
      const next = applyEvent(entry, event)
      if (next !== entry) {
        if (state.size >= MAX_TRACKED_SESSIONS) state.clear()
        state.set(session.id, next)
      }
    },
  }
}
