/**
 * Narrow adapters around the two official owners used by ticket 28.
 * The owners keep their algorithms; this file only supplies rule gating.
 */

import { Context, symbols } from '@deepseek-ai/cordis'
import { scopeOf, scopeTarget } from '@deepseek-ai/dsh-scope'
import { actionMatches } from './conditions/evaluation.mjs'

const prunerStates = new WeakMap()

const isRecord = value => value !== null && typeof value === 'object'

export function isRepeatCompactionAction(action) {
  return action?.kind === 'host-control' && ['repeat-tool-reminder', 'compaction-tool-result-pruner'].includes(action.capability)
}

export function validateRepeatCompactionAction(action) {
  if (!isRepeatCompactionAction(action)) throw new TypeError('host-control.capability must be repeat-tool-reminder or compaction-tool-result-pruner')
  if (action.value !== true) throw new TypeError(`${action.capability}.value must be true`)
  if (action.waterfallPosition !== undefined && action.waterfallPosition !== 'default') throw new TypeError(`${action.capability} is prepared before assemble`)
}

export function repeatReminderStatus(agent) {
  if (!agent?.ctx?.registry) return { available: false, reason: 'repeat-tool-reminder owner unavailable' }
  const target = scopeTarget(agent, scopeOf(agent.ctx))
  const filter = target?.[Context.filter]
  const entries = [...agent.ctx.registry.entries()].map(([, runtime]) => runtime)
  const reachable = typeof filter === 'function' && entries.some(runtime => runtime?.name === 'repeat-tool-reminder'
    && [...runtime.fibers ?? []].some(fiber => target[Context.filter](fiber.ctx)))
  return reachable ? { available: true, reason: '' } : { available: false, reason: 'repeat-tool-reminder owner unavailable' }
}

export function bindRepeatCompactionDependencies(rule, moduleId, statusFor, onOutcome) {
  const controls = rule.actions.filter(isRepeatCompactionAction).map(action => ({ action,
    dependent: new Set(rule.actions.filter(candidate => action.branchPath.every((part, i) => candidate.branchPath[i] === part)).map(candidate => candidate.id)) }))
  rule.repeatCompactionAvailable = (entry, frame) => {
    const applicable = controls.filter(({ dependent }) => dependent.has(entry.ruleActionId ?? entry.id))
    if (applicable.length === 0) return true
    if (!frame || !entry) return true
    const controlHit = applicable.some(({ action }) => actionMatches({ rule, action, ruleActionId: action.id, actionWhen: action.actionWhen, bypassRuleWhen: action.bypassRuleWhen }, { ...frame, ignoreRepeatCompactionDependency: true }))
    if (!controlHit) return true
    return applicable.every(({ action }) => {
      const current = statusFor(action, frame.subject?.agent)
      if (current?.available) return true
      try { onOutcome?.({ moduleId, ruleId: rule.id, actionId: action.id, channel: `host:${action.capability}`,
        outcome: 'unavailable', identityOutcome: 'condition-unavailable', reason: current?.reason ?? 'official owner unavailable', definitionRevision: rule.definitionRevision, agentId: frame.subject?.agent?.id }) } catch {}
      return false
    })
  }
}

/** Remove only reminders produced by the official repeat guard. */
export function filterRepeatReminderDecision(decision, enabled) {
  if (!enabled || !isRecord(decision) || !Array.isArray(decision.additionalContexts)) return decision
  const additionalContexts = decision.additionalContexts.filter(message => message?.source?.kind !== 'repeat-tool-reminder')
  return additionalContexts.length === decision.additionalContexts.length
    ? decision
    : { ...decision, additionalContexts }
}

/**
 * Gate the current official pruner instance without replacing its owner.
 * `ownsSession` returns undefined for sessions outside this policy, otherwise
 * a boolean deciding whether the official method may run.
 */
export function installPrunerGate(ctx, ownsSession) {
  if (!ctx || typeof ownsSession !== 'function') throw new TypeError('pruner gate requires a context and session predicate')
  const status = { mounted: false, owner: undefined }
  const fiber = ctx.inject(['toolResultPruner'], dependent => {
    const owner = dependent.get('toolResultPruner')?.[symbols.original] ?? dependent.get('toolResultPruner')
    if (!owner || typeof owner.pruneSession !== 'function') return () => {}
    status.mounted = true; status.owner = owner
    let state = prunerStates.get(owner)
    if (!state) {
      const original = owner.pruneSession
      state = { original, entries: new Set(), wrapper: null }
      state.wrapper = function (...args) {
        const session = args[0]
        for (const predicate of state.entries) {
          const decision = predicate(session)
          if (decision !== undefined) return decision ? Reflect.apply(state.original, this, args) : { pruned: [], charsRemoved: 0 }
        }
        return Reflect.apply(state.original, this, args)
      }
      status.wrapper = state.wrapper
      owner.pruneSession = state.wrapper
      prunerStates.set(owner, state)
    }
    status.wrapper = state.wrapper
    state.entries.add(ownsSession)
    return () => {
      state.entries.delete(ownsSession)
      if (state.entries.size === 0 && owner.pruneSession === state.wrapper) {
        owner.pruneSession = state.original
        prunerStates.delete(owner)
      }
      status.mounted = false; status.owner = undefined; status.wrapper = undefined
    }
  })
  const dispose = () => fiber?.dispose?.()
  dispose.status = status
  return dispose
}
