import { AsyncLocalStorage } from 'node:async_hooks'
import { toolStepFor } from './tool-scope.mjs'
import { actionMatches } from './conditions/evaluation.mjs'

const ownerKey = Symbol.for('prompt-tool:delegation-limits-owner')
export const delegationLimitsState = globalThis[Symbol.for('prompt-tool:delegation-limits')] ??= {
  maxDepth: { available: false, reason: 'official subagent early owner unavailable; restart DSH with early entry' },
  askTimeout: { available: false, reason: 'official timed question early owner unavailable; restart DSH with early entry' },
}
const calls = new AsyncLocalStorage()
const fields = ['maxDepth', 'askTimeout']

export function validateDelegationLimits(action) {
  if (action.capability !== 'delegation-limits') throw new TypeError('host-control.capability must be delegation-limits')
  const value = action.value
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length === 0
    || Object.keys(value).some(field => !fields.includes(field))) throw new TypeError('delegation-limits.value requires maxDepth or askTimeout')
  if (Object.hasOwn(value, 'maxDepth') && (!Number.isSafeInteger(value.maxDepth) || value.maxDepth < 0)) throw new TypeError('delegation-limits.maxDepth must be a non-negative safe integer')
  if (Object.hasOwn(value, 'askTimeout') && (!Number.isInteger(value.askTimeout) || value.askTimeout < 1 || value.askTimeout > 2147483)) throw new TypeError('delegation-limits.askTimeout must be an integer from 1 to 2147483 seconds')
  if (action.waterfallPosition !== undefined && action.waterfallPosition !== 'default') throw new TypeError('delegation-limits is prepared before assemble')
}

delegationLimitsState.mark = (kind, ctx, definition) => {
  const owner = { kind, ctx, active: true }
  ctx.effect(() => () => { owner.active = false })
  const execute = definition.execute
  const wrapped = { ...definition, async execute(args, exec) {
    exec.signal.throwIfAborted()
    const step = toolStepFor(exec)
    let value
    if (owner.active && step?.status === 'sealed' && exec.agent?.ctx?.get('tools')?.executable(definition.name, exec.agent, exec.toolSet)?.[ownerKey] === owner) {
      value = step.delegationLimits?.[kind]
    }
    if (kind === 'askTimeout' && value !== undefined && args.timeout === -1) args = { ...args, timeout: value }
    return calls.run({ ctx, value: kind === 'maxDepth' ? value : undefined }, () => execute.call(this, args, exec))
  } }
  Object.defineProperty(wrapped, ownerKey, { value: owner, enumerable: true })
  return wrapped
}

// 配置实参未指定时才提供默认值；官方 resolver 仍拥有提供者及数值校验。
delegationLimitsState.depth = (ctx, configured) => {
  const call = calls.getStore()
  return configured === undefined && call !== undefined && call.ctx === ctx && call.value !== undefined ? call.value : configured
}

export function delegationLimitsStatus(agent, context, field) {
  const state = delegationLimitsState[field]
  if (!state?.available) return { available: false, reason: state?.reason ?? 'unsupported delegation limit' }
  try {
    const tools = agent?.ctx?.get('tools')
    const name = field === 'maxDepth' ? 'subagent' : 'ask_user_question'
    const owner = tools?.executable?.(name, agent, context?.toolSet)?.[ownerKey]
    const available = owner?.active === true && owner.kind === field
      && (field !== 'maxDepth' || owner.ctx.get('subagents')?.getProvider('spawn')?.capabilities?.depthLimit === true)
      && (field !== 'askTimeout' || typeof owner.ctx.get('userQuestions')?.askTimed === 'function')
    return { available, reason: available ? '' : `verified official ${name} owner or runtime dependencies unavailable` }
  } catch { return { available: false, reason: 'official delegation owner dependencies unavailable' } }
}

export const isDelegationLimitsAction = action => action.kind === 'host-control' && action.capability === 'delegation-limits'

export function delegationLimitsDefinition(definition, step) {
  const owner = definition?.[ownerKey]
  const value = step?.delegationLimits?.[owner?.kind]
  if (owner?.active !== true || value === undefined || typeof definition.description !== 'string') return definition
  const note = owner.kind === 'maxDepth'
    ? `Current rule default depth: ${value}, only when the official spawn configuration omits maxDepth; explicit values and provider-managed remain unchanged.`
    : `Current rule wait cap: ${value} seconds for timeout=-1 only; omitted timeout and finite timeout keep their original behavior.`
  return { ...definition, description: `${definition.description}\n\n${note}` }
}

export function planDelegationLimits(entries, frame, preview = false) {
  if (!preview && frame.delegationLimitsPlan !== undefined) return frame.delegationLimitsPlan
  const checking = { ...frame, ignoreDelegationLimitsDependency: true, onOutcome: undefined,
    decisions: new Map(), actionDecisions: new Set(), actionOutcomes: new Map(), reminders: new Map() }
  const selected = entries.filter(entry => actionMatches(entry, checking))
  const conflicts = new Set(fields.filter(field => new Set(selected.filter(entry => entry.action.value[field] !== undefined)
    .map(entry => entry.action.value[field])).size > 1))
  if (preview && conflicts.size > 0) throw new TypeError(`delegation-limits ${[...conflicts].join(', ')} conflict`)
  const values = Object.assign({}, ...selected.map(entry => entry.action.value))
  for (const field of conflicts) delete values[field]
  const plan = { values: Object.freeze(values), conflicts }
  if (!preview) frame.delegationLimitsPlan = plan
  return plan
}

export function prepareDelegationLimits(entries, frame, preview = false) {
  const plan = planDelegationLimits(entries, frame, preview)
  if (preview) return plan
  const context = frame.args[1]
  const agent = frame.subject?.agent
  const statuses = Object.fromEntries(fields.map(field => [field, delegationLimitsStatus(agent, context, field)]))
  const values = Object.fromEntries(Object.entries(plan.values).filter(([field]) => statuses[field].available))
  const observations = entries.map(entry => {
    const hit = actionMatches(entry, frame)
    const blocked = fields.filter(field => entry.action.value[field] !== undefined && (plan.conflicts.has(field) || !statuses[field].available))
    const outcome = hit && blocked.length > 0 ? 'unavailable' : hit ? 'hit' : frame.actionOutcomes.get(entry) ?? 'miss'
    return { moduleId: entry.sourceModuleId, ruleId: entry.rule.id, channel: 'host:delegation-limits', outcome,
      identityOutcome: outcome === 'hit' ? 'matched' : outcome === 'unavailable' ? 'condition-unavailable' : outcome === 'error' ? 'error' : 'condition-miss',
      definitionRevision: entry.rule.definitionRevision, actionId: entry.id, agentId: agent?.id,
      ...(outcome === 'unavailable' ? { reason: blocked.map(field => plan.conflicts.has(field) ? `delegation-limits ${field} conflict` : statuses[field].reason).join('; ') } : {}) }
  })
  return { values: Object.freeze(values), observations }
}

export function bindDelegationLimitsDependencies(rule, moduleId, entries, onOutcome) {
  const controls = rule.actions.filter(isDelegationLimitsAction).map(action => ({ action,
    dependent: new Set(rule.actions.filter(candidate => action.branchPath.every((part, index) => candidate.branchPath[index] === part)).map(candidate => candidate.id)) }))
  if (controls.length === 0) return
  rule.delegationLimitsAvailable = (entry, frame) => {
    if (!controls.some(({ dependent }) => dependent.has(entry.ruleActionId ?? entry.id))) return true
    const checking = { ...frame, ignoreDelegationLimitsDependency: true, onOutcome: undefined,
      decisions: new Map(), actionDecisions: new Set(), actionOutcomes: new Map(), reminders: new Map() }
    if (!actionMatches(entry, checking)) return true
    return controls.every(({ action, dependent }) => {
      if (!dependent.has(entry.ruleActionId ?? entry.id)) return true
      const context = frame.args[frame.channel === 'system-prompt/assemble' ? 1 : 0]
      const agent = frame.subject?.agent
      const plan = planDelegationLimits(entries(), frame)
      const reasons = fields.filter(field => action.value[field] !== undefined).flatMap(field => {
        if (plan.conflicts.has(field)) return [`delegation-limits ${field} conflict`]
        const status = delegationLimitsStatus(agent, context, field)
        return status.available ? [] : [status.reason]
      })
      if (reasons.length === 0) return true
      try { onOutcome?.({ moduleId, ruleId: rule.id, channel: 'host:delegation-limits', outcome: 'unavailable',
        identityOutcome: 'condition-unavailable', definitionRevision: rule.definitionRevision, actionId: action.id,
        agentId: agent?.id, reason: reasons.join('; ') }) } catch { /* 诊断不改变资格 */ }
      return false
    })
  }
}
