import { toolStepFor } from './tool-scope.mjs'
import { actionMatches } from './conditions/evaluation.mjs'

const ownerKey = Symbol.for('prompt-tool:file-read-limits-owner')
const key = Symbol.for('prompt-tool:file-read-limits')
const fields = ['maxLineLength', 'maxBytes', 'limit']
export const readLimitsState = globalThis[key] ??= {
  available: false, reason: 'file-read-limits early entry missing or official module already cached; restart DSH with early entry',
}

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

readLimitsState.mark = (ctx, definition) => {
  const owner = { ctx, active: true, limitDescription: definition.parameters?.properties?.limit?.description }
  ctx.effect(() => () => { owner.active = false })
  Object.defineProperty(definition, ownerKey, { value: owner, enumerable: true })
  return definition
}

export function readLimitsStatus(agent, context) {
  if (!readLimitsState.available) return { available: false, reason: readLimitsState.reason }
  try {
    const tools = agent?.ctx?.get('tools')
    const owner = tools?.executable?.('read', agent, context?.toolSet)?.[ownerKey]
    const available = owner?.active === true && owner.ctx.get('fs') !== undefined && owner.ctx.get('workingDirectory') !== undefined
    return { available, reason: available ? '' : 'verified official read owner or runtime dependencies unavailable' }
  } catch { return { available: false, reason: 'official read owner dependencies unavailable' } }
}

// 只读已接受步骤；不另存 Agent 参数表，关闭后下一步骤自然恢复原 owner 配置。
readLimitsState.read = (ctx, exec, original) => {
  exec.signal.throwIfAborted()
  const step = toolStepFor(exec)
  if (step?.status !== 'sealed' || step.readLimits === undefined || !readLimitsStatus(exec.agent, exec).available) return original
  const owner = exec.agent.ctx.get('tools').executable('read', exec.agent, exec.toolSet)?.[ownerKey]
  return owner?.ctx === ctx ? Object.freeze({ ...original, ...step.readLimits }) : original
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
  rule.readLimitsAvailable = (entry, frame) => {
    if (!controls.some(({ dependent }) => dependent.has(entry.ruleActionId ?? entry.id))) return true
    const checking = { ...frame, ignoreReadLimitsDependency: true, onOutcome: undefined,
      decisions: new Map(), actionDecisions: new Set(), actionOutcomes: new Map(), reminders: new Map() }
    if (!actionMatches(entry, checking)) return true
    return controls.every(({ action, dependent }) => {
      if (!dependent.has(entry.ruleActionId ?? entry.id)) return true
      const context = frame.args[frame.channel === 'system-prompt/assemble' ? 1 : 0]
      const agent = frame.subject?.agent
      const status = readLimitsStatus(agent, context)
      const plan = planReadLimits(entries(), frame)
      const conflict = fields.some(field => plan.conflicts.has(field) && action.value[field] !== undefined)
      if (status.available && !conflict) return true
      try { onOutcome?.({ moduleId, ruleId: rule.id, channel: 'host:file-read-limits', outcome: 'unavailable',
        identityOutcome: 'condition-unavailable', definitionRevision: rule.definitionRevision, actionId: action.id, agentId: agent?.id,
        reason: conflict ? `file-read-limits ${[...plan.conflicts].join(', ')} conflict` : status.reason }) } catch { /* 诊断不改变资格 */ }
      return false
    })
  }
}

export function prepareReadLimits(entries, frame, preview = false) {
  const plan = planReadLimits(entries, frame, preview)
  if (preview) return plan
  if (plan.conflicts.size > 0) throw new TypeError(`file-read-limits ${[...plan.conflicts].join(', ')} conflict`)
  const context = frame.args[1]
  const status = readLimitsStatus(frame.subject?.agent, context)
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
  const limit = step?.readLimits?.limit
  if (definition?.[ownerKey]?.active !== true || limit === undefined) return definition
  const parameters = definition.parameters
  const original = definition[ownerKey].limitDescription
  const description = parameters.properties.limit.description
  if (typeof original !== 'string' || original.length === 0 || typeof description !== 'string' || description.split(original).length !== 2) return definition
  return { ...definition, parameters: { ...parameters, properties: { ...parameters.properties,
    limit: { ...parameters.properties.limit, description: description.replace(original, `Maximum number of lines to return. Defaults to ${limit}.`) },
  } } }
}
