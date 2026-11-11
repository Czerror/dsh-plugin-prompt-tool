import { AsyncLocalStorage } from 'node:async_hooks'
import { actionMatches } from './conditions/evaluation.mjs'
import { toolStepFor } from './tool-scope.mjs'

const owners = new WeakMap(), preparing = new AsyncLocalStorage(), identityKey = Symbol('provider system roles request'), loaded = new Set()
const adapterKey = Symbol.for('prompt-tool:provider-system-roles-adapter')
const routeKey = Symbol.for('prompt-tool:provider-system-roles-route')
const loopKey = Symbol.for('prompt-tool:provider-system-roles-loop-owner')
export const isProviderSystemRolesAction = action => action?.kind === 'host-control' && ['oauth-identity-prefix', 'provider-system-role'].includes(action.capability)
export function validateProviderSystemRolesAction(action) {
  if (action.value !== true) throw new TypeError(`${action.capability}.value must be true`)
  if (action.maxPerTurn !== undefined || action.waterfallPosition !== undefined && action.waterfallPosition !== 'default') throw new TypeError(`${action.capability} is prepared before assemble`)
}
function routeFor(agent, selection) {
  try { return agent?.loopCtx?.llm?.[routeKey]?.(selection?.provider) } catch { return undefined }
}
export function providerSystemRolesStatus(agent, capability, selection) {
  const adapter = routeFor(agent, selection)?.adapter, group = adapter?.[adapterKey]
  if (!owners.has(agent) || agent?.[loopKey] !== true || group === undefined) return { available: false, reason: 'provider system roles loop/adapter owner unavailable' }
  const keys = capability === 'oauth-identity-prefix' ? ['anthropic'] : ['completions', 'responses']
  return keys.every(key => loaded.has(group[key])) ? { available: true } : { available: false, reason: `${capability} provider artifact fingerprint or structure mismatch` }
}
export function bindProviderSystemRolesDependencies(rule, moduleId, onOutcome) {
  const controls = rule.actions.filter(isProviderSystemRolesAction).map(action => ({ action, dependent: new Set(rule.actions.filter(candidate => action.branchPath.every((part, index) => candidate.branchPath[index] === part)).map(candidate => candidate.id)) }))
  rule.providerSystemRolesAvailable = (entry, frame) => controls.every(({ action, dependent }) => {
    if (!dependent.has(entry.ruleActionId ?? entry.id)) return true
    // Independent control actions must not borrow each other's readiness.
    if (isProviderSystemRolesAction(entry.action) && entry.action !== action) return true
    const checking = { ...frame, ignoreProviderSystemRolesDependency: true }
    if (!actionMatches({ rule, action, id: action.id, actionWhen: action.actionWhen, bypassRuleWhen: action.bypassRuleWhen }, checking)) return true
    const current = providerSystemRolesStatus(frame.subject?.agent, action.capability, frame.args?.[1]?.modelSelection ?? frame.modelSelection)
    if (current.available) return true
    try { onOutcome?.({ moduleId, ruleId: rule.id, actionId: action.id, channel: `host:${action.capability}`, outcome: 'unavailable', identityOutcome: 'condition-unavailable', reason: current.reason, definitionRevision: rule.definitionRevision, agentId: frame.subject?.agent?.id }) } catch {}
    return false
  })
}
export function registerProviderSystemRoles(agent) {
  const owner = {}
  owners.set(agent, owner)
  return { prepare(entries, frame, context) {
    const step = toolStepFor(context, agent)
    if (owners.get(agent) !== owner || step?.status !== 'pending') return
    const enabled = {}
    for (const entry of entries) if (actionMatches(entry, frame) && providerSystemRolesStatus(agent, entry.action.capability, context.modelSelection).available) enabled[entry.action.capability] = true
    step.providerSystemRoles = Object.freeze({ owner, route: routeFor(agent, context.modelSelection), enabled: Object.freeze(enabled) })
  }, dispose() { if (owners.get(agent) === owner) owners.delete(agent) } }
}
function active(identity, capability) {
  return identity !== undefined && identity.signal?.aborted !== true && identity.step.status === 'sealed'
    && identity.step.providerSystemRoles?.owner === owners.get(identity.agent) && identity.step.providerSystemRoles.enabled[capability] === true
    && routeFor(identity.agent, identity.step.modelSelection) === identity.route
    && providerSystemRolesStatus(identity.agent, capability, identity.step.modelSelection).available
}
export const providerSystemRolesBridge = {
  prepare(agent, selection, invoke) {
    const step = toolStepFor({ agent, modelSelection: selection })
    return preparing.run(step?.status === 'sealed' ? { agent, step } : undefined, invoke)
  },
  capture(adapter) {
    const current = preparing.getStore()
    const route = current === undefined ? undefined : routeFor(current.agent, current.step.modelSelection)
    if (route?.adapter !== adapter || current.step.providerSystemRoles?.route !== route) return undefined
    return { ...current, route }
  },
  loaded(token) { loaded.add(token) },
  model(model, identity, signal) {
    if (identity === undefined) return model
    const copy = { ...model }
    copy[identityKey] = { ...identity, signal }
    return copy
  },
  strip(model) { return active(model?.[identityKey], 'oauth-identity-prefix') },
  role(model, original) {
    if (original !== 'developer' || !active(model?.[identityKey], 'provider-system-role')) return original
    try {
      const host = new URL(model.baseUrl).hostname
      if (host === 'api.openai.com' || host.endsWith('.azure.com')) return original
    } catch {}
    return 'system'
  },
}
globalThis[Symbol.for('prompt-tool:provider-system-roles')] = providerSystemRolesBridge
