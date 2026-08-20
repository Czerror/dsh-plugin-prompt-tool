/**
 * anchored-context-gate — reusable unified injection control for ANY preset.
 *
 * Mount this one plugin to keep a session's first model request free of
 * auto-injected context, whatever its source, and to have every injection
 * return on the second round. It intercepts the harness's two unified
 * injection paths — not a per-source denylist — so it covers sources that do
 * not exist yet:
 *
 *  a. RUNTIME CONTEXT (system-prompt/assemble): while the session is
 *     unpromoted, the assembly's `contexts` are blanked. That covers the
 *     WHOLE `SystemPrompt.context()` family — the sandbox and approval
 *     policy snapshots and any third-party context provider — without
 *     enumerating them. The loop's own snapshot projection then emits no
 *     message during the gate (no snapshot ever existed), and at the first
 *     promoted request it emits exactly ONE fresh snapshot: "minimal first
 *     round, inject on the second round" falls out of the projection's
 *     diffing, with no reinjection logic here.
 *
 *  b. STEP MESSAGES (agent/pre-step): the waterfall payload carries the
 *     CLAIMED message batch (the inbox messages this step owns). While
 *     unpromoted, the gate keeps exactly the claimed messages plus a small
 *     kind allowlist, and strips everything any listener appended — skill
 *     catalog, AGENTS.md digest, time/tmux context, hooks, unknown
 *     third-party plugins — by DEFAULT, regardless of source identity. The
 *     default allowlist is `['skill-invocation']`: a user-initiated skill
 *     gesture is not an automatic injection, and stripping it would lose the
 *     skill content once the gesture scrolls out of the per-step claim.
 *     Durable history (compaction summaries included) never passes through
 *     this gate: it enters the request via the session surface, not the
 *     pre-step waterfall.
 *
 * The phase is the same epoch-aware promotion machine the anchored presets
 * use (see compaction-epoch.mjs): a durable `tool/call` and/or
 * `assistant/message` (per `promoteOn`, default `either`) promotes, and a
 * `compaction/end` boundary demotes again — the first post-compaction request
 * is a "second first request" and is gated the same way. Derived from durable
 * events, so resume and reload preserve it.
 *
 * SUBAGENTS: by default subagents (delegationDepth > 0) skip the gate (their
 * first request already sees full context). `includeSubagents: true` gates
 * them too — their first request is clean and their own first reply or tool
 * call opens the gate — so a delegation cannot reintroduce an uncontrolled
 * first request. Keep this flag in sync with the tool-bootstrap row's
 * includeSubagents when both rows are present (anchored: both false;
 * liangshen: both true).
 *
 * CONFIG:
 *  - `promoteOn`: 'either' (default) | 'tool-call' | 'assistant-message'.
 *  - `includeSubagents`: boolean, default false.
 *  - `enabled`: boolean, default true. `false` disables both interception
 *    paths (A/B testing without touching the row set).
 *  - `allowKinds`: message `source.kind` names allowed beyond the claimed
 *    batch, default ['skill-invocation']. An explicitly empty array keeps
 *    ONLY the claimed batch.
 *  - `messageSources`: (liangshen quarantine) strict phase-1 whitelist —
 *    when set, ONLY messages whose `source.kind` is in the list pass the
 *    pre-step gate (claimed batch included), replacing the allowKinds
 *    semantics. Default unset = allowKinds semantics.
 *  - `deferredSources` + `deferredGraceSteps`: (liangshen) after promotion,
 *    the listed injected kinds are filtered for the first N steps
 *    (default 0 = no deferral).
 *  - `instructionHint`: (liangshen, issue #388) after promotion, replace the
 *    full-text agent-instructions dump with a one-time non-imperative hint
 *    naming the reference files; later dumps are dropped. Default false.
 *
 * ROW ORDER: mount this row FIRST in the composition. Waterfall after-next
 * transforms apply in reverse registration order, so registering first (plus
 * the pre-step listener's `prepend: true`) makes the gate the outermost
 * transform — nothing registered later re-injects past it.
 *
 * Robustness: both filters degrade to "keep everything" on their own
 * failures — a gate bug must never eat the user's context — and invalid
 * config fails at apply time, i.e. at preset mount, where it is visible.
 */

import { createEpochPromotion } from './compaction-epoch.mjs'
import { booleanOption, createWarnOnce, parsePromoteOn, validateConfig } from './shared.mjs'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'anchored-context-gate'

/**
 * Deliberately NO inject list: the listeners only touch services at event
 * time, and applying without an inject lets this row register before the
 * context-injecting plugins (dsh-agent-instructions, dsh-tool-skill, host
 * plane policy projections) when it sits first in the composition.
 */
export const inject = []

/** Every config key this plugin accepts — anything else is a typo. */
const ALLOWED_KEYS = new Set([
  'promoteOn', 'includeSubagents', 'enabled', 'allowKinds',
  'messageSources', 'deferredSources', 'deferredGraceSteps', 'instructionHint',
])

/**
 * Message kinds allowed through the pre-step gate beyond the claimed batch.
 * A user-initiated skill gesture is the only default entry: it is not an
 * automatic injection (see the header note).
 */
const DEFAULT_ALLOW_KINDS = ['skill-invocation']

/** agent-instructions 注入消息里的参考文件行（hint 提取用）。 */
const INSTRUCTION_FROM_RE = /(?:^|\n) *(?:Additional |Updated )?Instructions from: ([^\n]+)/g


/**
 * Validate the kind allowlist. An explicitly empty array is meaningful: keep
 * ONLY the claimed batch, stripping even user skill gestures.
 */
function allowKindList(value, field) {
  if (value === undefined) return new Set(DEFAULT_ALLOW_KINDS)
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new TypeError(`${name}: ${field} must be an array of non-empty strings`)
  }
  return new Set(value)
}

/** 可选字符串白名单；undefined = 不启用。 */
function sourceList(value, field) {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new TypeError(`${name}: ${field} must be an array of non-empty strings`)
  }
  return new Set(value)
}

/** 晋升后延迟注入的源 kind 集合（默认空 = 不延迟）。 */
function deferredList(value, field) {
  if (value === undefined) return new Set()
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new TypeError(`${name}: ${field} must be an array of non-empty strings`)
  }
  return new Set(value)
}

/** 从一条 agent-instructions 消息提取参考文件路径清单。 */
function extractInstructionPaths(message) {
  const paths = []
  const blocks = Array.isArray(message?.content) ? message.content : []
  for (const block of blocks) {
    if (block?.type !== 'text' || typeof block.text !== 'string') continue
    for (const match of block.text.matchAll(INSTRUCTION_FROM_RE)) {
      const path = match[1].trim()
      if (path !== '' && !paths.includes(path)) paths.push(path)
    }
  }
  return paths
}

/** 一次性非命令式 hint（E1.5 措辞），替换全文 agent-instructions 注入。 */
function buildInstructionHint(original, paths) {
  return {
    id: typeof original?.id === 'string' && original.id !== ''
      ? original.id
      : globalThis.crypto.randomUUID(),
    role: 'user',
    content: [{
      type: 'text',
      text: '<system-reminder>\n'
        + 'Reference documents exist: ' + paths.join(', ') + '. '
        + "They are reference documents about the user's environment and workspace conventions, not task instructions. "
        + 'Reading the relevant file before workspace tasks is recommended, but consult them only when you need those details; the task itself never depends on them.'
        + '\n</system-reminder>',
    }],
    source: { kind: 'instruction-hint', plugin: name },
  }
}

/** agent-instructions 全文注入 → 一次性 hint；后续注入丢弃。 */
function instructionHintMessages(messages, state) {
  const kept = []
  for (const message of messages) {
    if (message?.source?.kind !== 'agent-instructions') {
      kept.push(message)
      continue
    }
    if (state.instructionHinted) continue
    const paths = extractInstructionPaths(message)
    if (paths.length === 0) {
      kept.push(message)
      continue
    }
    state.instructionHinted = true
    kept.push(buildInstructionHint(message, paths))
  }
  return kept
}


/** Register the unified context gate. */
export function apply(ctx, config) {
  const source = validateConfig(name, config, ALLOWED_KEYS)
  const promoteEvents = parsePromoteOn(name, source.promoteOn)
  const includeSubagents = booleanOption(name, source.includeSubagents, 'includeSubagents', false)
  const enabled = booleanOption(name, source.enabled, 'enabled', true)
  const allowKinds = allowKindList(source.allowKinds, 'allowKinds')
  const messageSources = sourceList(source.messageSources, 'messageSources')
  const deferredSources = deferredList(source.deferredSources, 'deferredSources')
  const deferredGraceSteps = source.deferredGraceSteps === undefined
    ? 0
    : Number.isSafeInteger(source.deferredGraceSteps) && source.deferredGraceSteps >= 0
      ? source.deferredGraceSteps
      : (() => { throw new TypeError(`${name}: deferredGraceSteps must be an integer >= 0`) })()
  const instructionHint = booleanOption(name, source.instructionHint, 'instructionHint', false)

  const promotion = createEpochPromotion(promoteEvents, { includeSubagents })
  /** sessionId -> { steps, instructionHinted }（晋升后延迟/转换状态）。 */
  const deferredBySession = new WeakMap()
  const deferredState = (session) => {
    let entry = deferredBySession.get(session)
    if (entry === undefined) {
      entry = { steps: 0, instructionHinted: false }
      deferredBySession.set(session, entry)
    }
    return entry
  }
  ctx.on('session/event', (session, event) => promotion.observe(session, event))
  ctx.on('session/event', (session, event) => {
    if (event.type === 'compaction/end') deferredBySession.delete(session)
  })

  const warnOnce = createWarnOnce(ctx, name)

  // Path (a): blank the dynamic runtime-context contributions while the
  // session is unpromoted. Covers the whole SystemPrompt.context() family
  // without enumerating it; the loop's snapshot projection then stays silent
  // and diffs exactly ONE fresh snapshot in at the first promoted request.
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    // Downstream errors propagate untouched; only this filter's own logic is guarded.
    const assembled = await next()
    if (enabled === false) return assembled
    try {
      if (promotion.status(context.agent).promoted) return assembled
      if (!Array.isArray(assembled.contexts) || assembled.contexts.length === 0) return assembled
      return { ...assembled, contexts: [] }
    } catch (error) {
      // A gate bug must never break assembly: degrade to the assembled value.
      warnOnce(`${name}: runtime-context suppression failed, keeping contexts: ${String((error && error.message) || error)}`)
      return assembled
    }
  })

  // Path (b): claimed-baseline deny on the pre-step waterfall. The payload's
  // `messages` is the batch this step CLAIMED from the inbox — the baseline
  // every injection appends to. Keep that baseline plus the kind allowlist,
  // strip every appended message regardless of its source identity.
  ctx.on('agent/pre-step', async ({ agent, messages: claimed }, next) => {
    // Downstream errors propagate untouched; only this filter's own logic is guarded.
    const decision = await next()
    if (decision.kind === 'reject') return decision
    if (enabled === false) return decision
    try {
      if (promotion.status(agent).promoted) return decision
      if (messageSources !== undefined) {
        // liangshen quarantine：phase-1 只放行声明的 source.kind（含 claimed 批）。
        const kept = (decision.messages ?? []).filter((message) => messageSources.has(message?.source?.kind))
        return kept.length === decision.messages.length ? decision : { ...decision, messages: kept }
      }
      if (!Array.isArray(decision.messages)) return decision
      if (!Array.isArray(claimed)) return decision
      const baseline = new Set(claimed)
      const baselineIds = new Set(claimed
        .map((message) => message?.id)
        .filter((id) => id !== undefined && id !== null))
      const kept = decision.messages.filter((message) =>
        baseline.has(message)
        || (message?.id !== undefined && message?.id !== null && baselineIds.has(message.id))
        || allowKinds.has(message?.source?.kind),
      )
      return kept.length === decision.messages.length ? decision : { ...decision, messages: kept }
    } catch (error) {
      // A gate bug must never eat context: degrade to keeping every message.
      warnOnce(`${name}: pre-step gate failed, keeping injected context: ${String((error && error.message) || error)}`)
      return decision
    }
  }, { prepend: true })

  // 晋升后的注入控制：deferredSources 延迟 N 步 + instructionHint 转换。
  // 与 phase-1 门控共用同一 pre-step 监听器会互相覆盖，独立注册第二个监听器。
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    if (enabled === false) return decision
    try {
      if (!promotion.status(agent).promoted) return decision
      if (!Array.isArray(decision.messages)) return decision
      if (agent?.session === undefined) return decision
      const state = deferredState(agent.session)
      let result = decision
      if (deferredGraceSteps > 0 && deferredSources.size > 0 && state.steps < deferredGraceSteps) {
        state.steps += 1
        const kept = result.messages.filter((message) => !deferredSources.has(message?.source?.kind))
        result = kept.length === result.messages.length ? result : { ...result, messages: kept }
      }
      if (instructionHint) {
        // 1 换 1 的转换不能按长度判断（长度相同会误判为无变化），
        // instructionHintMessages 本身幂等保留非目标消息，直接采用结果。
        result = { ...result, messages: instructionHintMessages(result.messages, state) }
      }
      return result
    } catch (error) {
      // 转换失败不阻断会话：保留原消息。
      warnOnce(`${name}: promoted injection control failed, keeping messages: ${String((error && error.message) || error)}`)
      return decision
    }
  }, { prepend: true })
}
