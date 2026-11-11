import { actionMatches } from './conditions/evaluation.mjs'
import { Context } from '@deepseek-ai/cordis'
import { scopeOf, scopeTarget } from '@deepseek-ai/dsh-scope'

export const providerHookDecisionsState = globalThis[Symbol.for('prompt-tool:provider-hook-decisions')] ??= {
  'claude-code': { available: false, reason: 'official Claude hook early owner unavailable; restart DSH with early entry' },
  codex: { available: false, reason: 'official Codex hook early owner unavailable; restart DSH with early entry' },
}
export const isProviderHookDecisionsAction = action => action?.kind === 'host-control' && action.capability === 'provider-hook-decisions'
export function validateProviderHookDecisions(action) {
  if (action.waterfallPosition !== undefined && action.waterfallPosition !== 'default') throw new TypeError('provider-hook-decisions uses the official owner event order')
  const value = action?.value
  if (!isProviderHookDecisionsAction(action) || value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['claude-code', 'codex'].includes(key)) || Object.keys(value).length === 0
    || Object.values(value).some(item => item !== true)) throw new TypeError('provider-hook-decisions.value requires claude-code or codex true')
}
export function prepareProviderHookDecisions(entries, frame) {
  const values = {}
  for (const entry of entries) if (actionMatches(entry, frame)) Object.assign(values, entry.action.value)
  return Object.freeze(values)
}
const integrations = new Set()
const owners = new Set()
const reachable = (owner, agent) => agent?.ctx?.root === owner.ctx.root
  && scopeTarget(agent, scopeOf(agent.ctx))[Context.filter](owner.ctx)
function status(action, agent) {
  for (const kind of Object.keys(action.value)) {
    if (!providerHookDecisionsState[kind].available) return providerHookDecisionsState[kind]
    const matching = [...owners].filter(owner => owner.kind === kind && owner.active && reachable(owner, agent))
    if (matching.length === 0) return { available: false, reason: `current Agent official ${kind} hook owner not mounted` }
    const known = new Set(matching.flatMap(owner => [owner.fiber, owner.ctx]))
    for (const owner of matching) {
      const entries = [...(owner.ctx.root?.registry?.entries?.() ?? owner.ctx.registry?.entries?.() ?? [])]
      for (const [, runtime] of entries) {
        if (runtime.name !== `hooks-${kind}`) continue
        for (const fiber of runtime.fibers ?? []) {
          if (reachable({ ctx: fiber.ctx }, agent) && !known.has(fiber) && !known.has(fiber.ctx)) return { available: false, reason: `current Agent official ${kind} hook owner artifact mismatch` }
        }
      }
    }
  }
  return { available: true }
}
export function bindProviderHookDependencies(rule, moduleId, onOutcome) {
  const controls = rule.actions.filter(isProviderHookDecisionsAction).map(action => ({ action,
    dependent: new Set(rule.actions.filter(candidate => action.branchPath.every((part, i) => candidate.branchPath[i] === part)).map(candidate => candidate.id)) }))
  rule.providerHookAvailable = (entry, frame) => controls.every(({ action, dependent }) => {
    if (!dependent.has(entry.ruleActionId ?? entry.id)) return true
    const checking = { ...frame, ignoreProviderHookDependency: true, onOutcome: undefined,
      decisions: new Map(), actionDecisions: new Set(), actionOutcomes: new Map(), reminders: new Map() }
    if (!actionMatches(entry, checking)) return true
    const current = status(action, frame.subject?.agent)
    if (current.available) return true
    try { onOutcome?.({ moduleId, ruleId: rule.id, actionId: action.id, channel: 'host:provider-hook-decisions',
      outcome: 'unavailable', identityOutcome: 'condition-unavailable', reason: current.reason,
      definitionRevision: rule.definitionRevision, agentId: frame.subject?.agent?.id }) } catch { /* 只读诊断 */ }
    return false
  })
}
providerHookDecisionsState.register = (ctx, resolve) => {
  const entry = { ctx, resolve }
  integrations.add(entry)
  if (typeof ctx.effect === 'function') ctx.effect(() => () => integrations.delete(entry))
  return () => integrations.delete(entry)
}
providerHookDecisionsState.accept = (input, channel, result) => {
  for (const entry of integrations) {
    if (entry.ctx !== input?.agent?.ctx) continue
    const plan = entry.resolve(input, channel, result)
    if (plan !== undefined) return plan
  }
  return undefined
}

providerHookDecisionsState.owner = (kind, ctx) => {
  const owner = { kind, ctx, fiber: ctx.fiber, active: true }
  owners.add(owner)
  ctx.effect(() => () => { owner.active = false; owners.delete(owner) })
  return owner
}

providerHookDecisionsState.capture = (owner, input, channel, result) => {
  if (owner.active !== true || input?.agent == null || input.signal?.aborted || !reachable(owner, input.agent)) return false
  const step = providerHookDecisionsState.accept(input, channel, result)
  return step?.status === 'sealed' && step.providerHookDecisions?.[owner.kind] === true
}
