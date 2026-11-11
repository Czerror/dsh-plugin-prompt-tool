import { toolStepFor } from './tool-scope.mjs'
import { actionMatches } from './conditions/evaluation.mjs'
import { scopeChainOf, scopeOf } from '@deepseek-ai/dsh-scope'
import { symbols } from '@deepseek-ai/cordis'

export const escalationCapabilities = Object.freeze(['escalation-criteria', 'escalation-grant', 'escalation-outcome'])
export const escalationDecisionsState = globalThis[Symbol.for('prompt-tool:escalation-decisions')] ??= { status: new Map() }
const integrations = new Set()
escalationDecisionsState.integration = (ctx, owner, executor) => {
  const entry = { ctx, owner, executor }
  integrations.add(entry)
  ctx.effect(() => () => integrations.delete(entry))
  return executor
}
const original = service => service?.[symbols.original] ?? service
const activeFor = agent => [...integrations.values()].filter(({ ctx }) => original(ctx.get('tools')) === original(agent?.ctx?.get('tools'))
  && (scopeOf(ctx) === undefined || scopeChainOf(agent).includes(scopeOf(ctx))))

export function validateEscalationDecision(action) {
  if (!escalationCapabilities.includes(action.capability) || action.value !== true
    || (action.waterfallPosition !== undefined && action.waterfallPosition !== 'default')) throw new TypeError('invalid escalation decision')
}

export const isEscalationDecisionAction = action => action.kind === 'host-control' && escalationCapabilities.includes(action.capability)
export function escalationDecisionStatus(agent, context) {
  const selected = context?.toolSet?.view?.(agent)
  const names = selected === undefined
    ? new Set(agent?.ctx?.get('tools')?.schemas(agent)?.map(schema => schema.name) ?? []) : new Set(selected.keys())
  const active = activeFor(agent)
  let executor
  try { executor = agent?.ctx?.get('tools')?.selectExecutor(agent) } catch { return { available: false, reason: 'current Agent tool executor unavailable' } }
  const callers = Object.entries({ fs: ['read', 'write', 'edit', 'delete'], pwsh: ['pwsh'], bash: ['bash'] })
    .filter(([, tools]) => tools.some(name => names.has(name))).map(([owner]) => owner)
  // PTC transport is executor-owned and never appears in ResolvedToolSet.view().
  if (executor !== undefined && active.some(entry => entry.owner === 'ptc' && entry.executor === executor)) callers.push('ptc')
  if (callers.length === 0) return { available: false, reason: 'current Agent escalation tool owner unavailable' }
  if (callers.some(owner => !active.some(entry => entry.owner === owner))) return { available: false, reason: 'current Agent verified escalation caller unavailable' }
  for (const owner of ['sandbox', ...callers]) {
    const status = escalationDecisionsState.status.get(owner)
    if (status?.available !== true) return { available: false, reason: status?.reason ?? `escalation ${owner} early entry missing; restart DSH` }
  }
  return { available: true, reason: '' }
}

// The approval object carries the exact tool execution identities, never a latest-Agent cache.
escalationDecisionsState.capture = approval => {
  const step = toolStepFor(approval)
  if (approval?.signal?.aborted || step?.status !== 'sealed'
    || escalationDecisionsState.status.get('sandbox')?.available !== true
    || escalationDecisionsState.status.get(approval.promptToolEscalationOwner)?.available !== true
    || !activeFor(approval.agent).some(entry => entry.owner === approval.promptToolEscalationOwner)) return Object.freeze({})
  return Object.freeze(Object.fromEntries(escalationCapabilities.map(capability => [capability, step.escalationDecisions?.[capability] === true])))
}

/** Called only after the shared caller hook has verified the original artifact fingerprint. */
export function transformEscalationCaller(source, owner) {
  const apply = owner === 'bash' || owner === 'pwsh' ? 'function apply(ctx, config = {}) {' : 'function apply(ctx, config) {'
  const ptcSelection = 'ctx.tools.setExecutor(new PtcExecutor(ctx, config));'
  const pattern = /(\t+)agent: exec\.agent,\n(\t+)callId: exec\.callId,/g
  const matches = [...source.matchAll(pattern)]
  // Match the approval ingredients inside the one escalation call, not other Agent payloads.
  const start = source.indexOf('approveEscalation({')
  const end = source.indexOf('});', start)
  const selected = matches.filter(match => match.index > start && match.index < end)
  if (start < 0 || source.indexOf('approveEscalation({', start + 1) !== -1 || selected.length !== 1 || source.split(apply).length !== 2
    || (owner === 'ptc' && source.split(ptcSelection).length !== 2)) {
    escalationDecisionsState.status.set(owner, { available: false, reason: `escalation ${owner} caller structure mismatch` })
    return source
  }
  const match = selected[0]
  escalationDecisionsState.status.set(owner, { available: true, reason: '' })
  return (source.slice(0, match.index) + match[0].replace('agent: exec.agent,', 'agent: exec.agent,\n' + match[1] + `promptToolEscalationOwner: ${JSON.stringify(owner)},\n` + match[1] + 'toolSet: exec.toolSet,\n' + match[1] + 'modelSelection: exec.modelSelection,') + source.slice(match.index + match[0].length))
    .replace(owner === 'ptc' ? ptcSelection : apply, owner === 'ptc'
      ? 'ctx.tools.setExecutor(globalThis[Symbol.for("prompt-tool:escalation-decisions")].integration(ctx, "ptc", new PtcExecutor(ctx, config)));'
      : apply + `\n globalThis[Symbol.for("prompt-tool:escalation-decisions")].integration(ctx, ${JSON.stringify(owner)});`)
}

export function prepareEscalationDecisions(entries, frame, context) {
  const values = {}
  const resolvedContext = context ?? (frame.channel === 'system-prompt/assemble' ? frame.args?.[1] : undefined)
  for (const entry of entries) if (actionMatches(entry, frame) && escalationDecisionStatus(frame.subject?.agent, resolvedContext).available) values[entry.action.capability] = true
  return Object.freeze(values)
}
export function bindEscalationDecisionDependencies(rule, moduleId, onOutcome) {
  const controls = rule.actions.filter(isEscalationDecisionAction).map(action => ({ action,
    dependent: new Set(rule.actions.filter(candidate => action.branchPath.every((part, i) => candidate.branchPath[i] === part)).map(candidate => candidate.id)) }))
  if (controls.length === 0) return
  rule.escalationDecisionsAvailable = (entry, frame) => {
    if (!controls.some(({ dependent }) => dependent.has(entry.ruleActionId ?? entry.id))) return true
    const checking = { ...frame, ignoreEscalationDecisionsDependency: true, onOutcome: undefined,
      decisions: new Map(), actionDecisions: new Set(), actionOutcomes: new Map(), reminders: new Map() }
    if (!actionMatches(entry, checking)) return true
    const context = frame.channel === 'system-prompt/assemble' ? frame.args?.[1] : undefined
    const status = escalationDecisionStatus(frame.subject?.agent, context)
    if (status.available) return true
    try { onOutcome?.({ moduleId, ruleId: rule.id, actionId: entry.id, channel: `host:${entry.action?.capability ?? 'escalation'}`,
      outcome: 'unavailable', identityOutcome: 'condition-unavailable', reason: status.reason,
      definitionRevision: rule.definitionRevision, agentId: frame.subject?.agent?.id }) } catch { /* 诊断不改变资格 */ }
    return false
  }
}

/** Changes only the three specified branches; the original owner keeps all errors and approval calls. */
export function transformEscalationOwner(source) {
  const edits = [
    ['async function approveEscalation(request, approval) {', 'async function approveEscalation(request, approval) {\n const promptToolDecision = globalThis[Symbol.for("prompt-tool:escalation-decisions")]?.capture(approval) ?? {};\n if (promptToolDecision["escalation-grant"]) { approval.signal?.throwIfAborted(); return request.requestedMode; }'],
    ['if (!(WIDER_MODES[effectiveMode] ?? []).includes(mode))', 'if (!promptToolDecision["escalation-criteria"] && !(WIDER_MODES[effectiveMode] ?? []).includes(mode))'],
    ['if (approval.approver === void 0)', 'if (!promptToolDecision["escalation-criteria"] && approval.approver === void 0)'],
    ['if (approval.agent === void 0)', 'if (!promptToolDecision["escalation-criteria"] && approval.agent === void 0)'],
    ['\tswitch (outcome) {', '\tif (promptToolDecision["escalation-outcome"] && ["rejected", "cancelled", "unavailable"].includes(outcome)) { approval.signal?.throwIfAborted(); return mode; }\n\tswitch (outcome) {'],
  ]
  if (!edits.every(([from]) => source.split(from).length === 2)) {
    escalationDecisionsState.status.set('sandbox', { available: false, reason: 'escalation owner structure mismatch' })
    return source
  }
  for (const [from, to] of edits) source = source.replace(from, to)
  escalationDecisionsState.status.set('sandbox', { available: true, reason: '' })
  return source
}
