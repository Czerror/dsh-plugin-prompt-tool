import { AsyncLocalStorage } from 'node:async_hooks'
import { toolStepFor } from './tool-scope.mjs'
import { actionMatches } from './conditions/evaluation.mjs'
import { symbols } from '@deepseek-ai/cordis'

const calls = new AsyncLocalStorage()
const original = value => value?.[symbols.original] ?? value
const owners = new WeakMap()
const integrations = { autoReviewPassthrough: new Set(), toolAskAllow: new Set() }
const fields = ['autoGrant', 'autoReviewPassthrough', 'toolAskAllow']
export const isApprovalDecisionsAction = action => action.kind === 'host-control' && action.capability === 'approval-decisions'
export function validateApprovalDecisions(action) {
  if (action.value === null || typeof action.value !== 'object' || Array.isArray(action.value)
    || Object.keys(action.value).length === 0 || Object.entries(action.value).some(([key, value]) => !fields.includes(key) || typeof value !== 'boolean')) throw new TypeError('approval-decisions requires independent boolean fields')
  if (action.waterfallPosition !== undefined && action.waterfallPosition !== 'default') throw new TypeError('approval-decisions is prepared before assemble')
}
function status(action, agent) {
  const missing = Object.entries(action.value).filter(([, value]) => value).map(([field]) => approvalDecisionsState[field]).filter(owner => !owner.available)
  if (missing.length > 0) return { available: false, reason: missing.map(owner => owner.reason).join('; ') }
  try {
    for (const [field, enabled] of Object.entries(action.value)) {
      if (!enabled) continue
      if (field === 'autoGrant' ? owners.get(original(agent?.ctx?.get('approval')))?.active !== true
        || !approvalDecisionsState.toolAskAllow.available || ![...integrations.toolAskAllow].some(ctx => sameTools(ctx, agent))
        : ![...integrations[field]].some(ctx => sameTools(ctx, agent))) return { available: false, reason: `current Agent ${field} owner unavailable` }
    }
  } catch { return { available: false, reason: 'current Agent approval dependencies unavailable' } }
  return { available: true, reason: '' }
}
export function prepareApprovalDecisions(entries, frame) {
  const values = {}
  const checking = { ...frame, ignoreApprovalDecisionsDependency: true, onOutcome: undefined,
    decisions: new Map(), actionDecisions: new Set(), actionOutcomes: new Map(), reminders: new Map() }
  const selected = entries.filter(entry => actionMatches(entry, checking))
  for (const field of fields) {
    const candidates = selected.filter(entry => Object.hasOwn(entry.action.value, field))
    const choices = new Set(candidates.map(entry => entry.action.value[field]))
    if (choices.size > 1) throw new TypeError(`approval-decisions ${field} conflict`)
    if (choices.size === 1 && candidates.some(entry => status(entry.action, frame.subject?.agent).available)) values[field] = [...choices][0]
  }
  return Object.freeze(values)
}
export function bindApprovalDecisionsDependencies(rule, moduleId, onOutcome) {
  const controls = rule.actions.filter(isApprovalDecisionsAction).map(action => ({ action,
    dependent: new Set(rule.actions.filter(candidate => action.branchPath.every((part, i) => candidate.branchPath[i] === part)).map(candidate => candidate.id)) }))
  rule.approvalDecisionsAvailable = (entry, frame) => {
    const applicable = controls.filter(({ dependent }) => dependent.has(entry.ruleActionId ?? entry.id))
    if (applicable.length === 0) return true
    const checking = { ...frame, ignoreApprovalDecisionsDependency: true, onOutcome: undefined,
      decisions: new Map(), actionDecisions: new Set(), actionOutcomes: new Map(), reminders: new Map() }
    if (!actionMatches(entry, checking)) return true
    return applicable.every(({ action }) => {
      const current = status(action, frame.subject?.agent)
      if (current.available) return true
      try { onOutcome?.({ moduleId, ruleId: rule.id, actionId: action.id, channel: 'host:approval-decisions',
        outcome: 'unavailable', identityOutcome: 'condition-unavailable', reason: current.reason,
        definitionRevision: rule.definitionRevision, agentId: frame.subject?.agent?.id }) } catch { /* 诊断不改变资格 */ }
      return false
    })
  }
}
export const approvalDecisionsState = globalThis[Symbol.for('prompt-tool:approval-decisions')] ??= {
  autoGrant: { available: false, reason: 'official approval early owner unavailable' },
  autoReviewPassthrough: { available: false, reason: 'official auto-review early owner unavailable' },
  toolAskAllow: { available: false, reason: 'official tool pipeline early owner unavailable' },
}

function selected(exec, field) {
  if (exec?.agent == null || exec.signal?.aborted || !approvalDecisionsState[field].available) return false
  const step = toolStepFor(exec)
  return step?.status === 'sealed' && step.approvalDecisions?.[field] === true
}

function sameTools(ctx, agent) {
  try { const tools = original(ctx.get('tools')); return tools !== undefined && tools === original(agent?.ctx?.get('tools')) } catch { return false }
}
approvalDecisionsState.integration = (field, ctx) => {
  integrations[field].add(ctx)
  ctx.effect(() => () => integrations[field].delete(ctx))
}
approvalDecisionsState.review = (exec, ctx) => integrations.autoReviewPassthrough.has(ctx) && sameTools(ctx, exec.agent) && selected(exec, 'autoReviewPassthrough')
approvalDecisionsState.ask = (exec, ctx) => integrations.toolAskAllow.has(ctx) && sameTools(ctx, exec.agent) && selected(exec, 'toolAskAllow')
approvalDecisionsState.owner = (ctx, service) => {
  const owner = { active: true }
  owners.set(original(service), owner)
  ctx.effect(() => () => { owner.active = false })
}
approvalDecisionsState.grant = (req, service) => {
  const call = calls.getStore()
  const current = original(service)
  return owners.get(current)?.active === true && original(req.agent?.ctx?.get('approval')) === current
    && call?.active === true && req === call.req && req.agent === call.exec.agent && !req.signal?.aborted && selected(call.exec, 'autoGrant')
}
// 只在这次审批 await 期间借用精确 exec，后台继承的异步上下文在返回后失效。
approvalDecisionsState.request = async (approval, exec, req) => {
  const call = { exec, req, active: true }
  try { return await calls.run(call, () => approval.request(req)) }
  finally { call.active = false }
}

/** 由process-defaults早期owner核对原始发行包指纹后串行调用。 */
export function transformApprovalService(source) {
  const lookup = 'globalThis[Symbol.for("prompt-tool:approval-decisions")]'
  const edits = [
    ['this.config = config;', `this.config = config;\n\t\t${lookup}.owner(ctx, this);`],
    ['if (this.effectivePolicy(session) === "never") return "rejected";', `if (${lookup}.grant(req, this)) return "allowed-once";\n\t\tif (this.effectivePolicy(session) === "never") return "rejected";`],
  ]
  if (edits.some(([from]) => source.split(from).length !== 2)) {
    approvalDecisionsState.autoGrant.available = false
    approvalDecisionsState.autoGrant.reason = 'official approval owner structure mismatch'
    return source
  }
  let transformed = source
  for (const [from, to] of edits) transformed = transformed.replace(from, to)
  approvalDecisionsState.autoGrant.available = true
  approvalDecisionsState.autoGrant.reason = ''
  return transformed
}
