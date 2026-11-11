import { AsyncLocalStorage } from 'node:async_hooks'
import { actionMatches } from './conditions/evaluation.mjs'
import { toolAssemblyContext, toolStepFor } from './tool-scope.mjs'

const owners = new WeakMap(), calls = new AsyncLocalStorage(), derivedSteps = new WeakMap()
export const isMessageShapeGuardsAction = action => action?.kind === 'host-control' && action.capability === 'message-shape-guards'
export function validateMessageShapeGuardsAction(action) {
  if (action.value !== true) throw new TypeError('message-shape-guards.value must be true')
  if (action.maxPerTurn !== undefined || action.waterfallPosition !== undefined && action.waterfallPosition !== 'default') throw new TypeError('message-shape-guards is prepared before assemble')
}
export function messageShapeGuardsStatus(agent) {
  return owners.has(agent) && agent?.model?.[Symbol.for('prompt-tool:message-shape-agent-owner')] === true
    && agent?.session?.surface?.[Symbol.for('prompt-tool:message-shape-session')] === agent.session
    && agent?.[Symbol.for('prompt-tool:message-shape-guards-owner')] === true
    ? { available: true } : { available: false, reason: 'message-shape agent/session/loop owner unavailable' }
}
export function bindMessageShapeGuardsDependencies(rule, moduleId, onOutcome) {
  const controls = rule.actions.filter(isMessageShapeGuardsAction).map(action => ({ action, dependent: new Set(rule.actions.filter(candidate => action.branchPath.every((part, index) => candidate.branchPath[index] === part)).map(candidate => candidate.id)) }))
  rule.messageShapeGuardsAvailable = (entry, frame) => {
    const applicable = controls.filter(({ dependent }) => dependent.has(entry.ruleActionId ?? entry.id))
    if (!applicable.some(({ action }) => actionMatches({ rule, action, id: action.id, actionWhen: action.actionWhen, bypassRuleWhen: action.bypassRuleWhen }, { ...frame, ignoreMessageShapeGuardsDependency: true }))) return true
    const status = messageShapeGuardsStatus(frame.subject?.agent)
    if (status.available) return true
    try { onOutcome?.({ moduleId, ruleId: rule.id, actionId: applicable[0].action.id, channel: 'host:message-shape-guards', outcome: 'unavailable', identityOutcome: 'condition-unavailable', reason: status.reason, definitionRevision: rule.definitionRevision, agentId: frame.subject?.agent?.id }) } catch {}
    return false
  }
}
export function registerMessageShapeGuards(agent) {
  const owner = {}
  owners.set(agent, owner)
  return { setEnabled(enabled, context) {
    const step = toolStepFor(context, agent)
    if (owners.get(agent) === owner && step?.status === 'pending') step.messageShapeGuards = Object.freeze({ owner, enabled: enabled === true && messageShapeGuardsStatus(agent).available })
  }, dispose() { if (owners.get(agent) === owner) owners.delete(agent) } }
}
function accepted(agent, step) {
  return step?.status === 'sealed' && step.messageShapeGuards?.enabled === true && step.messageShapeGuards.owner === owners.get(agent) && messageShapeGuardsStatus(agent).available
}
export function normalizeMessageShapeAssembly(assembly, context, step = toolStepFor(context)) {
  if ((step?.status !== 'pending' && !accepted(context.agent, step)) || step?.messageShapeGuards?.enabled !== true || step.messageShapeGuards.owner !== owners.get(context.agent) || !messageShapeGuardsStatus(context.agent).available) return assembly
  const normalize = section => typeof section.text === 'string' ? section : { ...section, text: '' }
  return { ...assembly, sections: assembly.sections.map(normalize), contexts: assembly.contexts.map(normalize) }
}
function decision(agent, selection, value) {
  if (!accepted(agent, toolStepFor({ agent, modelSelection: selection })) || value?.kind !== 'enter' || Array.isArray(value.messages)) return value
  return { ...value, messages: [] }
}
function run(agent, assembly, signal, invoke) {
  const context = toolAssemblyContext(assembly, { agent }), step = context === undefined ? undefined : toolStepFor(context)
  return calls.run({ agent, step, signal }, invoke)
}
function active(session) {
  const current = calls.getStore()
  return current?.agent.session === session && current.signal?.aborted !== true && accepted(current.agent, current.step)
}
globalThis[Symbol.for('prompt-tool:message-shape-guards')] = {
  decision, run,
  cache(session, invalidate) {
    const step = active(session) ? calls.getStore().step : undefined
    if (!derivedSteps.has(session) || derivedSteps.get(session) !== step) { derivedSteps.set(session, step); invalidate() }
  },
  content(message, session) { return active(session) && !Array.isArray(message?.content) ? [] : message.content },
  derive(event, projected, session, original) {
    if (!active(session)) return original()
    const projection = projected?.get(event.seq)
    if (projection !== undefined) return projection
    if (['system/message', 'developer/message', 'assistant/message'].includes(event.type) && (!Array.isArray(event.data.message?.content) || event.data.message.content.length === 0)) return null
    return original()
  },
}
