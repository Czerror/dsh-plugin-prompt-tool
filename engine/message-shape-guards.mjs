import { actionMatches } from './conditions/evaluation.mjs'
import { bindHostDependency } from './conditions/host-dependencies.mjs'
import { toolStepFor } from './tool-scope.mjs'

const owners = new WeakMap()
const partialReason = 'message-shape-guards only normalizes ordinary prompt sections and runtime context; complete sections and malformed messages are unsupported'
export const isMessageShapeGuardsAction = action => action?.kind === 'host-control' && action.capability === 'message-shape-guards'
export function validateMessageShapeGuardsAction(action) {
  if (action.value !== true) throw new TypeError('message-shape-guards.value must be true')
  if (action.maxPerTurn !== undefined || action.waterfallPosition !== undefined && action.waterfallPosition !== 'default') throw new TypeError('message-shape-guards is prepared before assemble')
}
export function bindMessageShapeGuardsDependencies(rule, moduleId, onOutcome) {
  const controls = rule.actions.filter(isMessageShapeGuardsAction).map(action => ({ action, dependent: new Set(rule.actions.filter(candidate => action.branchPath.every((part, index) => candidate.branchPath[index] === part)).map(candidate => candidate.id)) }))
  if (controls.length === 0) return
  const available = (entry, frame) => {
    const applicable = controls.find(({ action, dependent }) => dependent.has(entry.ruleActionId ?? entry.id)
      && actionMatches({ rule, action, id: action.id, actionWhen: action.actionWhen, bypassRuleWhen: action.bypassRuleWhen }, checkingFrame(frame)))
    if (applicable === undefined) return true
    try { onOutcome?.({ moduleId, ruleId: rule.id, actionId: applicable.action.id, channel: 'host:message-shape-guards', outcome: 'unavailable', identityOutcome: 'condition-unavailable', reason: partialReason, definitionRevision: rule.definitionRevision, agentId: frame.subject?.agent?.id }) } catch {}
    return false
  }
  bindHostDependency(rule, 'before', { key: 'message-shape-guards', skip: frame => frame.ignoreMessageShapeGuardsDependency === true, available })
}
function checkingFrame(frame) {
  return { ...frame, ignoreMessageShapeGuardsDependency: true, onOutcome: undefined,
    decisions: new Map(), actionDecisions: new Set(), actionOutcomes: new Map(), reminders: new Map() }
}
export function prepareMessageShapeGuards(entries, frame, _preview, owner, context) {
  if (owner === undefined || entries.length === 0) return
  const checking = checkingFrame(frame)
  owner.setEnabled(entries.some(entry => actionMatches(entry, checking)), context)
  // Local normalization does not satisfy a branch that relies on the full guard.
  for (const entry of entries) actionMatches(entry, frame)
}
export function registerMessageShapeGuards(agent) {
  const owner = {}
  owners.set(agent, owner)
  return { setEnabled(enabled, context) {
    const step = toolStepFor(context, agent)
    if (context?.agent === agent && owners.get(agent) === owner && step?.status === 'pending') step.messageShapeGuards = enabled ? owner : undefined
  }, dispose() { if (owners.get(agent) === owner) owners.delete(agent) } }
}
export function normalizeMessageShapeAssembly(assembly, context, step = toolStepFor(context)) {
  if ((step?.status !== 'pending' && step?.status !== 'sealed') || step.messageShapeGuards === undefined
    || step.messageShapeGuards !== owners.get(context.agent) || context.signal?.aborted === true) return assembly
  const invalid = section => typeof section.text !== 'string'
  const badSection = section => section.complete !== true && invalid(section)
  const clear = section => ({ ...section, text: '' })
  const sections = assembly.sections.some(badSection) ? assembly.sections.map(section => badSection(section) ? clear(section) : section) : assembly.sections
  const contexts = assembly.contexts.some(invalid) ? assembly.contexts.map(section => invalid(section) ? clear(section) : section) : assembly.contexts
  return sections === assembly.sections && contexts === assembly.contexts ? assembly : { ...assembly, sections, contexts }
}
