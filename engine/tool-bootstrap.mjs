/**
 * Anchored tool bootstrap — keep the FIRST model request on the Minimal
 * preset's REAL tool schema (persistent `bash` + `str_replace_editor`), then
 * keep the assembled catalog once the session has produced its first durable
 * promotion signal; `usePtcMode` optionally switches the wire presentation to
 * Code Mode (PTC). Injected-context control lives in the companion
 * `context-gate` plugin, not here.
 *
 * GATE MODE (liangshen stabilize 扩展, source: xiaobright/dsh-anchored-standard
 * MIT + phase-1 quarantine): `promoteGate: true` gates the promotion on the
 * first reasoning block classifying minimal-like (`we` present, no `let me`),
 * `maxPromoteSteps` (default 4) is the gate fallback, and
 * `promoteAfterFirstResponse: true` promotes a tool-less first response and
 * releases an anchor-gated session at its first `turn/end`.
 * `personaSectionsOnly: true` narrows phase-1 prompt sections to the persona
 * (plan-mode policy and other sections return after promotion);
 * `workspaceLine: true` appends the session's working directory to the
 * promoted persona; `phase1FirstCallInstruction` is an opt-in extra line
 * appended to the phase-1 persona (test builds, issue #274) — unset keeps
 * the exact one-line Minimal anchor.
 *
 * The phase is derived from durable session events, so resume and reload
 * preserve it. By default (`promoteOn: 'either'`) a session promotes after the
 * first `tool/call` OR the first `assistant/message`, whichever comes first:
 * request #1 always sees the bootstrap catalog and later requests keep the
 * assembled catalog. The original `'tool-call'` mode is kept for compatibility,
 * but it can trap a session in bootstrap forever when the first model reply
 * makes no tool call — the `'either'` default removes that trap while keeping
 * the first-request anchor intact.
 *
 * First-request conditions established by the reproduction work (issues #6
 * and #11, 2026-08-15):
 *
 *  1. Tool schema. The API-visible first-request catalog decides whether the
 *     session anchors on the Minimal trajectory. At the adapter-default
 *     maxTokens (256000 on the official endpoint) the Minimal tool pair —
 *     persistent `bash` + `str_replace_editor` — anchored 5/5 runs with zero
 *     `let me` first-lines, while every standard-family schema (pwsh/read,
 *     pwsh only, sandboxed bash/read) fell into standard-like behavior
 *     (11/11). Bootstrap therefore exposes exactly the Minimal pair, not
 *     Standard's `pwsh`/`read`.
 *
 *  2. Output budget. On the official endpoint the first request's `max_tokens`
 *     also dominated the trajectory anchor at 1024 (`We need` style in 26/32
 *     runs against 0/5 at 256000, independent of tool descriptions). The
 *     Minimal tool schema, however, anchors at 256000 WITHOUT any cap, and the
 *     cap's delivery depends on the profile package's `prepareCall` behavior
 *     (it reaches the request on the 0.1.0-rc.5 source checkout; a prebuilt
 *     rc.6-reporting profile package observed in issue #11 overwrote it with
 *     `adapterDefaults.maxTokens`). `bootstrapMaxTokens` is therefore OPT-IN:
 *     leave it unset to run the Minimal schema at the adapter default, or set
 *     it to cap the first request. When set, the cap is stripped after
 *     promotion — the next request's seed proposal carries the previous
 *     header's maxTokens forward, so the release must be explicit.
 *
 *  3. Injected context is NOT this plugin's concern: the companion
 *     `context-gate` plugin (shared/context-gate.mjs, mounted as the FIRST
 *     row) owns the unified injection control — runtime-context suppression
 *     on the assembly path and a claimed-baseline deny on the pre-step
 *     waterfall, both keyed to the same epoch-aware promotion phase. Mount it
 *     separately for context control alone; this file narrows only the tool
 *     catalog (plus the optional output cap below).
 *
 * SUBAGENTS: `includeSubagents` (default false) controls whether subagents
 * (delegationDepth > 0) follow the same bootstrap phase as the main session —
 * false (default) keeps the assembled catalog from their very first request
 * (the historical prompt-tool default: delegated agents inherit the full
 * tool surface); true makes their first request see the bootstrap pair and
 * their own first reply or tool call promotes them. Keep in sync with the
 * context-gate row's flag when both rows are present.
 *
 * POST-PROMOTION CATALOG (prompt-tool patch): after promotion both modes
 * keep the assembled catalog. `usePtcMode` switches the wire presentation
 * to Code Mode (PTC, single run_code) instead of narrowing the resident set.
 * The controlled phase below still narrows the catalog before promotion and
 * after compaction.
 * COMPACTION (local addition): a compaction rewrites the whole surface, so the
 * first post-compaction request is a "second first request". Promotion is
 * epoch-aware (see compaction-epoch.mjs): after `compaction/end` the session
 * falls back to the controlled phase — the bootstrap pair plus
 * `compactionTools` (a core work set, default none) — until a NEW durable
 * promotion signal exists past that boundary. The model is mid-task and needs
 * to keep working, but still faces a small catalog instead of the full
 * Standard set.
 *
 * Robustness:
 *  - Promotion decisions are memoized per session id for this process; the
 *    durable event scan runs once per session per process, then O(1).
 *  - Subagents keep the assembled catalog unless `includeSubagents: true`.
 *  - A missing bootstrap tool degrades to the full catalog with a one-time
 *    warning instead of throwing, so a composition drift can never brick
 *    every request of a session.
 *  - Invalid config (bad tool lists, unknown `promoteOn`, malformed flags,
 *    non-positive `bootstrapMaxTokens`) fails at apply time, i.e. at preset
 *    mount, where it is visible and fixable.
 */

import { createEpochPromotion } from './compaction-epoch.mjs'
import { booleanOption, createWarnOnce, parsePromoteOn, validateConfig } from './shared.mjs'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'anchored-tool-bootstrap'

/**
 * Deliberately NO inject list: the listeners only touch services at event
 * time. Keep this row right AFTER the context-gate row in agent.cordis.yml:
 * waterfall after-next transforms apply in reverse registration order, so the
 * tool filter here must register before any plugin that touches the same
 * assembly. The optional budget listener registers with `prepend: true` so a
 * later listener can never override the first-round cap after we set it.
 */
export const inject = []

/** Every config key this plugin accepts — anything else is a typo. */
const ALLOWED_KEYS = new Set([
  'bootstrapTools', 'promoteOn', 'bootstrapMaxTokens', 'compactionTools',
  'includeSubagents', 'usePtcMode',
  'promoteGate', 'maxPromoteSteps', 'promoteAfterFirstResponse',
  'personaSectionsOnly', 'workspaceLine', 'phase1FirstCallInstruction',
])

/** 预设 persona section 名（官方注册名 + 旧名）。 */
const PERSONA_SECTION_NAMES = new Set(['deployment:persona', 'persona'])

/** 晋升后 persona 附加的工作目录行前缀。 */
const WORKSPACE_LINE_PREFIX = '\n\nYour working directory is '


/**
 * The default first-request catalog: the OFFICIAL Minimal preset's exact tool
 * pair — the persistent `bash` shell and `str_replace_editor`. Issue #11
 * measured this schema anchoring 5/5 at the adapter-default maxTokens while
 * every standard-family schema failed 11/11.
 */
const DEFAULT_BOOTSTRAP_TOOLS = ['bash', 'str_replace_editor']

/** Non-empty string list config validator. */
function stringList(value, field) {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new TypeError(`${name}: ${field} must be a non-empty array of non-empty strings`)
  }
  return [...new Set(value)]
}

function stringListOrEmpty(value, field) {
  if (value === undefined) return []
  return stringList(value, field)
}


/**
 * Validate the optional first-request output cap. `undefined` means NO cap:
 * the Minimal tool schema anchors at the adapter-default maxTokens, and the
 * cap's delivery is profile-package dependent (see the header note), so it is
 * opt-in rather than the default.
 */
function optionalPositiveInt(value, field) {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name}: ${field} must be a positive safe integer`)
  }
  return value
}

/** Register the per-session bootstrap filters. */
export function apply(ctx, config) {
  const source = validateConfig(name, config, ALLOWED_KEYS)
  // 门控模式（promoteGate / promoteAfterFirstResponse）固定 either 晋升语义，
  // promoteOn 显式非 either 时与门控互斥，fail loud 而非静默忽略。
  if ((source.promoteGate === true || source.promoteAfterFirstResponse === true)
    && source.promoteOn !== undefined && source.promoteOn !== 'either') {
    throw new TypeError(`${name}: promoteGate/promoteAfterFirstResponse 门控模式固定 either 晋升语义，promoteOn 必须省略或为 "either"`)
  }
  const bootstrapTools = stringList(source.bootstrapTools, 'bootstrapTools')
  const promoteEvents = parsePromoteOn(name, source.promoteOn)
  const bootstrapMaxTokens = optionalPositiveInt(source.bootstrapMaxTokens, 'bootstrapMaxTokens')
  const includeSubagents = booleanOption(name, source.includeSubagents, 'includeSubagents', false)
  const usePtcMode = booleanOption(name, source.usePtcMode, 'usePtcMode', true)
  const personaSectionsOnly = booleanOption(name, source.personaSectionsOnly, 'personaSectionsOnly', false)
  const workspaceLine = booleanOption(name, source.workspaceLine, 'workspaceLine', false)
  const phase1FirstCallInstruction = typeof source.phase1FirstCallInstruction === 'string'
    ? source.phase1FirstCallInstruction
    : ''
  // Core work set exposed after a compaction, before re-promotion. Empty
  // means "no compaction recovery catalog": the session stays on the
  // bootstrap pair until a new promotion signal.
  const compactionTools = stringListOrEmpty(source.compactionTools, 'compactionTools')

  const promotion = createEpochPromotion(promoteEvents, {
    includeSubagents,
    promoteGate: source.promoteGate === true,
    promoteAfterFirstResponse: source.promoteAfterFirstResponse === true,
    maxPromoteSteps: source.maxPromoteSteps,
  })

  // prompt-tool patch: optional Code Mode (PTC) wire presentation after promotion.
  const presentationBySession = new WeakMap()
  const agentBySession = new WeakMap()
  const presentationState = (session) => {
    let state = presentationBySession.get(session)
    if (state === undefined) {
      state = { applied: false, disposer: undefined }
      presentationBySession.set(session, state)
    }
    return state
  }
  const applyCodePresentation = (agent) => {
    const session = agent?.session
    if (session === undefined) return
    const state = presentationState(session)
    if (state.applied) return
    const tools = agent.ctx?.tools
    if (tools === undefined || typeof tools.presentAs !== 'function') return
    state.disposer = tools.presentAs('code')
    state.applied = true
  }
  const releaseCodePresentation = (session) => {
    const state = presentationBySession.get(session)
    if (state === undefined) return
    if (typeof state.disposer === 'function') {
      try { state.disposer() } catch { /* never brick the session */ }
    }
    state.disposer = undefined
    state.applied = false
  }
  ctx.on('session/event', (session, event) => promotion.observe(session, event))

  ctx.on('session/event', (session, event) => {
    if (!usePtcMode) return
    if (event.type === 'compaction/end') {
      releaseCodePresentation(session)
      return
    }
    if (event.type !== 'step/end' && event.type !== 'turn/end') return
    const agent = agentBySession.get(session)
    if (agent !== undefined && promotion.status(agent).promoted) applyCodePresentation(agent)
  })

  const warnOnce = createWarnOnce(ctx, name)

  /** 晋升后给 persona 追加工作目录行（无 persona/无 cwd/已含则原样返回）。 */
  const withWorkspaceLine = (assembly, agent) => {
    const cwd = agent?.session?.header?.cwd
    if (typeof cwd !== 'string' || cwd.length === 0) return assembly
    if (!Array.isArray(assembly.sections)) return assembly
    const line = `${WORKSPACE_LINE_PREFIX}${cwd}.`
    const persona = assembly.sections.find((section) =>
      PERSONA_SECTION_NAMES.has(section?.name)
      && typeof section?.text === 'string'
      && !section.text.includes(line))
    if (persona === undefined) return assembly
    return {
      ...assembly,
      sections: assembly.sections.map((section) => section === persona
        ? { ...section, text: `${persona.text}${line}` }
        : section),
    }
  }

  /** Narrow the assembled catalog to a keep-set; validate required names. */
  const keepTools = (assembled, keep, missingAllowsFullCatalog) => {
    const available = new Set(assembled.tools.map((tool) => tool.name))
    const missing = [...keep].filter((toolName) => !available.has(toolName))
    if (missing.length > 0) {
      warnOnce(
        `${name}: expected every phase tool; missing=${JSON.stringify(missing)} — `
        + (missingAllowsFullCatalog ? 'bootstrap disabled, full catalog exposed' : 'continuing with what is available'),
      )
      if (missingAllowsFullCatalog) return assembled
    }
    return {
      ...assembled,
      tools: assembled.tools.filter((tool) => keep.has(tool.name)),
    }
  }

  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    // Downstream errors propagate untouched; only this filter's own logic is guarded.
    const assembled = await next()
    try {
      const agent = context.agent
      if (agent === undefined) return assembled
      agentBySession.set(agent.session, agent)
      if ((agent.session?.header?.delegationDepth ?? 0) > 0 && !includeSubagents) {
        // 默认：子代理继承完整目录（历史 prompt-tool 默认）；
        // includeSubagents=true 时落到下方正常相位逻辑（首轮裁剪 + 晋升）。
        if (usePtcMode) applyCodePresentation(agent)
        return assembled
      }
      const status = promotion.status(agent)
      if (status.promoted) {
        // prompt-tool patch: both modes keep the assembled catalog after promotion.
        // usePtcMode switches the wire presentation instead of narrowing resident tools.
        if (usePtcMode) applyCodePresentation(agent)
        return workspaceLine ? withWorkspaceLine(assembled, agent) : assembled
      }
      // Controlled phase: the bootstrap pair; after a compaction, plus the
      // compaction work set so mid-task work can continue. Context control is
      // NOT here: the companion `context-gate` plugin owns it (see the header
      // note), so this filter touches only the tool catalog.
      const { boundary } = status
      const keep = new Set(bootstrapTools)
      if (boundary >= 0) for (const toolName of compactionTools) keep.add(toolName)
      let next = keepTools(assembled, keep, true)
      if (personaSectionsOnly) {
        // Phase-1 提示词段只留 persona（plan-mode 策略等晋升后才恢复）。
        const sections = Array.isArray(next.sections)
          ? next.sections.filter((section) => PERSONA_SECTION_NAMES.has(section?.name))
          : undefined
        if (sections !== undefined) {
          const phase1Sections = phase1FirstCallInstruction === ''
            ? sections
            : sections.map((section) => {
                if (typeof section?.text !== 'string' || section.text.includes(phase1FirstCallInstruction)) return section
                return { ...section, text: `${section.text}${phase1FirstCallInstruction}` }
              })
          next = { ...next, sections: phase1Sections }
        }
      }
      return next
    } catch (error) {
      // A filter bug must never brick a session: degrade to the full catalog.
      warnOnce(`${name}: bootstrap filter failed, exposing the full catalog: ${String((error && error.message) || error)}`)
      return assembled
    }
  })

  // Optionally cap the first model request's output budget while bootstrapping.
  // Unset (`bootstrapMaxTokens` omitted) means the adapter default flows — the
  // Minimal tool schema anchors at 256000 without a cap (issue #11).
  if (bootstrapMaxTokens !== undefined) {
    // Same registration discipline as the pre-step strip below: `prepend`
    // keeps this listener the OUTERMOST transform of the agent/request
    // waterfall for the same registration-order reasons (loader row
    // application is concurrent; row order alone does not decide listener
    // order — see issue #6 and upstream PR #13), so a later listener can
    // never override the first-round budget after we set it.
    ctx.on('agent/request', async (payload, next) => {
      const resolved = await next()
      const agent = payload.agent
      if (promotion.status(agent).promoted) {
        // The next request's seed proposal carries the previous header's
        // maxTokens forward, so the injected cap must be stripped explicitly —
        // otherwise it would persist for the whole session.
        if (resolved.maxTokens === bootstrapMaxTokens) {
          const { maxTokens: _bootstrap, ...rest } = resolved
          return rest
        }
        return resolved
      }
      return {
        ...resolved,
        maxTokens: bootstrapMaxTokens,
      }
    }, { prepend: true })
  }
}
