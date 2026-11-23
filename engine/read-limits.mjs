import { toolStepFor } from './tool-scope.mjs'
import { actionMatches } from './conditions/evaluation.mjs'
import { bindHostDependency } from './conditions/host-dependencies.mjs'
import { officialToolLimitOwner, rememberToolLimitProjection } from './official-tool-limit-owners.mjs'

const fields = ['maxLineLength', 'maxBytes', 'limit']
const projections = new WeakMap()
const configFields = { maxLineLength: 'readMaxLineLength', maxBytes: 'readMaxBytes', limit: 'readLimit' }
const readConfigFields = [...Object.values(configFields), 'readStreamMinSize']

export function validateReadLimits(action) {
  if (action.capability !== 'file-read-limits') throw new TypeError('host-control.capability must be file-read-limits')
  const value = action.value
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length === 0
    || Object.keys(value).some(field => !fields.includes(field))) throw new TypeError('file-read-limits.value requires maxLineLength, maxBytes or limit')
  for (const field of fields) if (Object.hasOwn(value, field) && (!Number.isSafeInteger(value[field]) || value[field] < 1)) {
    throw new TypeError(`file-read-limits.${field} must be a positive safe integer`)
  }
  if (action.waterfallPosition !== undefined && action.waterfallPosition !== 'default') throw new TypeError('file-read-limits is prepared before assemble')
}

function readOwner(agent, context) {
  const tools = agent?.ctx?.get('tools')
  const toolSet = toolStepFor(context, agent)?.originalToolSet ?? context?.toolSet
  const owner = officialToolLimitOwner(tools?.executable?.('read', agent, toolSet))
  if (owner?.kind !== 'read' || owner.config.read !== true || typeof owner.apply !== 'function') return undefined
  if (!readConfigFields.every(field => Number.isSafeInteger(owner.config[field]) && owner.config[field] > 0)) return undefined
  return owner.ctx.get('fs') !== undefined && owner.ctx.get('workingDirectory') !== undefined ? owner : undefined
}

export function readLimitsStatus(agent, context, limits) {
  try {
    const owner = readOwner(agent, context)
    if (owner === undefined) return { available: false, reason: 'official read registration was not observed or its runtime dependencies are unavailable' }
    if (limits !== undefined && Object.keys(limits).length > 0) {
      const step = toolStepFor(context, agent)
      if (step == null || step.status === 'closed') return { available: false, reason: 'official read tool step is unavailable' }
      readProjection(owner, step, limits)
    }
    return { available: true, reason: '' }
  } catch { return { available: false, reason: 'official read owner dependencies unavailable' } }
}

/** 同字段同值共存，不同字段可组合；异值候选不挑赢家。 */
export function planReadLimits(entries, frame, preview = false) {
  if (!preview && frame.readLimitsPlan !== undefined) return frame.readLimitsPlan
  const checking = { ...frame, ignoreReadLimitsDependency: true, onOutcome: undefined,
    decisions: new Map(), actionDecisions: new Set(), actionOutcomes: new Map(), reminders: new Map() }
  const selected = entries.filter(entry => actionMatches(entry, checking))
  const conflicts = new Set(fields.filter(field => new Set(selected.filter(entry => entry.action.value[field] !== undefined)
    .map(entry => entry.action.value[field])).size > 1))
  if (preview && conflicts.size > 0) throw new TypeError(`file-read-limits ${[...conflicts].join(', ')} conflict`)
  const values = conflicts.size === 0 ? Object.assign({}, ...selected.map(entry => entry.action.value)) : {}
  const plan = { values: Object.freeze(values), conflicts }
  if (!preview) frame.readLimitsPlan = plan
  return plan
}

export const isReadLimitsAction = action => action.kind === 'host-control' && action.capability === 'file-read-limits'

/** 显式依赖沿结构分支关联，不扫描正文，也不影响同规则的独立兄弟分支。 */
export function bindReadLimitsDependencies(rule, moduleId, entries, onOutcome) {
  const controls = rule.actions.filter(isReadLimitsAction).map(action => ({ action,
    dependent: new Set(rule.actions.filter(candidate => action.branchPath.every((part, index) => candidate.branchPath[index] === part)).map(candidate => candidate.id)) }))
  if (controls.length === 0) return
  const available = (entry, frame) => {
    if (!controls.some(({ dependent }) => dependent.has(entry.ruleActionId ?? entry.id))) return true
    const checking = { ...frame, ignoreReadLimitsDependency: true, onOutcome: undefined,
      decisions: new Map(), actionDecisions: new Set(), actionOutcomes: new Map(), reminders: new Map() }
    if (!actionMatches(entry, checking)) return true
    return controls.every(({ action, dependent }) => {
      if (!dependent.has(entry.ruleActionId ?? entry.id)) return true
      const context = frame.args[frame.channel === 'system-prompt/assemble' ? 1 : 0]
      const agent = frame.subject?.agent
      const plan = planReadLimits(entries(), frame)
      const status = readLimitsStatus(agent, context, plan.values)
      const conflict = fields.some(field => plan.conflicts.has(field) && action.value[field] !== undefined)
      if (status.available && !conflict) return true
      try { onOutcome?.({ moduleId, ruleId: rule.id, channel: 'host:file-read-limits', outcome: 'unavailable',
        identityOutcome: 'condition-unavailable', definitionRevision: rule.definitionRevision, actionId: action.id, agentId: agent?.id,
        reason: conflict ? `file-read-limits ${[...plan.conflicts].join(', ')} conflict` : status.reason }) } catch { /* 诊断不改变资格 */ }
      return false
    })
  }
  bindHostDependency(rule, 'before', { key: 'file-read-limits', skip: frame => frame.ignoreReadLimitsDependency,
    available, reportUnavailable: true })
}

export function prepareReadLimits(entries, frame, preview = false) {
  const plan = planReadLimits(entries, frame, preview)
  if (preview) return plan
  if (plan.conflicts.size > 0) throw new TypeError(`file-read-limits ${[...plan.conflicts].join(', ')} conflict`)
  const context = frame.args[1]
  const status = readLimitsStatus(frame.subject?.agent, context, plan.values)
  const observations = entries.map(entry => {
    const hit = actionMatches(entry, frame)
    const outcome = hit ? 'hit' : frame.actionOutcomes.get(entry) ?? 'miss'
    return { moduleId: entry.sourceModuleId, ruleId: entry.rule.id, channel: 'host:file-read-limits', outcome,
      identityOutcome: hit ? 'matched' : outcome === 'unavailable' ? 'condition-unavailable' : outcome === 'error' ? 'error' : 'condition-miss',
      definitionRevision: entry.rule.definitionRevision, actionId: entry.id, agentId: frame.subject?.agent?.id,
      ...(outcome === 'unavailable' ? { reason: plan.conflicts.size > 0 ? `file-read-limits ${[...plan.conflicts].join(', ')} conflict` : status.reason } : {}) }
  })
  return { values: status.available ? plan.values : Object.freeze({}), observations }
}

/** 模型工具说明和执行读取同一个已接受值；保留其它来源的描述与参数。 */
export function readLimitsDefinition(definition, step) {
  const owner = officialToolLimitOwner(definition)
  const limits = step?.readLimits
  if (owner?.kind !== 'read' || limits === undefined || Object.keys(limits).length === 0) return definition
  return readProjection(owner, step, limits)
}

function readProjection(owner, step, limits) {
  const current = projections.get(step)
  if (current?.owner === owner && fields.every(field => current.limits[field] === limits[field])) return current.projection
  const config = { ...owner.config, readImage: false, write: false, edit: false, applyPatch: false }
  for (const [field, limit] of Object.entries(limits)) config[configFields[field]] = limit
  let captured
  const ctx = {
    tools: { register(candidate) {
      if (captured !== undefined || candidate.name !== 'read') throw new TypeError('official read factory registered an unexpected tool')
      captured = candidate
    } },
    systemPrompt: { getSectionOrder: name => owner.ctx.systemPrompt.getSectionOrder(name), section() {} },
    get fs() { return owner.ctx.fs },
    get workingDirectory() { return owner.ctx.workingDirectory },
    emit: (...args) => owner.ctx.emit(...args),
  }
  owner.apply(ctx, config)
  if (captured === undefined) throw new Error('official read factory did not register a definition')
  const projection = { ...captured, execute(args, exec) {
    if (step.status !== 'sealed' || toolStepFor(exec) !== step || readOwner(exec.agent, exec) !== owner) {
      throw new Error('official read step is unavailable')
    }
    return captured.execute(args, exec)
  } }
  rememberToolLimitProjection(projection, owner)
  projections.set(step, { owner, limits, projection })
  return projection
}
