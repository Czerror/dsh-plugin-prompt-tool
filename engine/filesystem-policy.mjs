import { toolStepFor } from './tool-scope.mjs'
import { actionMatches } from './conditions/evaluation.mjs'

export const filesystemCapabilities = Object.freeze(['sandbox-file-write', 'filesystem-fence', 'filesystem-observation'])
const key = Symbol.for('prompt-tool:filesystem-policy')
export const filesystemPolicyState = globalThis[key] ??= { status: new Map() }
const policies = new WeakMap()
const owners = new WeakMap()
const providers = new WeakMap()
const observations = new Set()
filesystemPolicyState.provider = (ctx, provider) => providers.set(provider, filesystemPolicyState.owner(ctx))
filesystemPolicyState.observer = ctx => {
  const owner = filesystemPolicyState.owner(ctx)
  observations.add(ctx)
  ctx.effect(() => () => observations.delete(ctx))
  return owner
}
filesystemPolicyState.owner = ctx => {
  let owner = owners.get(ctx)
  if (owner === undefined) {
    owner = { active: true }
    owners.set(ctx, owner)
    ctx.effect(() => () => { owner.active = false })
  }
  return owner
}

export function validateFilesystemPolicy(action) {
  if (!filesystemCapabilities.includes(action.capability)) throw new TypeError('unknown filesystem capability')
  if (action.value !== true) throw new TypeError(`${action.capability}.value must be true`)
  if (action.waterfallPosition !== undefined && action.waterfallPosition !== 'default') throw new TypeError('filesystem policy is prepared before assemble')
}

export function filesystemPolicyStatus(capability, agent) {
  if (capability === 'sandbox-file-write') return { available: false, reason: process.platform === 'darwin'
    ? 'Seatbelt exec identity adapter unavailable' : 'Seatbelt file-write policy is unavailable on this platform' }
  const owners = capability === 'filesystem-fence' ? ['fence', 'tool'] : ['observation']
  for (const owner of owners) {
    const status = filesystemPolicyState.status.get(owner)
    if (status?.available !== true) return { available: false, reason: status?.reason ?? `filesystem ${owner} early entry missing; restart DSH with early entry` }
  }
  try {
    const fs = agent?.ctx?.get('fs')
    if (fs === undefined) return { available: false, reason: 'current Agent filesystem owner unavailable' }
    if (capability === 'filesystem-fence' && providers.get(fs)?.active !== true) return { available: false, reason: 'current Agent verified filesystem fence owner unavailable' }
    if (capability === 'filesystem-observation' && ![...observations].some(ctx => ownersFor(ctx, fs))) return { available: false, reason: 'current Agent verified observation owner unavailable' }
  } catch { return { available: false, reason: 'current Agent filesystem dependencies unavailable' } }
  return { available: true, reason: '' }
}

function ownersFor(ctx, fs) {
  try { return fs !== undefined && owners.get(ctx)?.active === true && ctx.get('fs') === fs } catch { return false }
}

export const isFilesystemPolicyAction = action => action.kind === 'host-control' && filesystemCapabilities.includes(action.capability)

export function prepareFilesystemPolicy(entries, frame, preview = false) {
  const values = {}
  const observations = entries.map(entry => {
    const hit = actionMatches(entry, frame)
    const status = filesystemPolicyStatus(entry.action.capability, frame.subject?.agent)
    if (hit && status.available) values[entry.action.capability] = true
    const outcome = hit ? status.available ? 'hit' : 'unavailable' : frame.actionOutcomes.get(entry) ?? 'miss'
    return { moduleId: entry.sourceModuleId, ruleId: entry.rule.id, actionId: entry.id,
      channel: `host:${entry.action.capability}`, outcome,
      identityOutcome: outcome === 'hit' ? 'matched' : outcome === 'unavailable' ? 'condition-unavailable' : outcome === 'error' ? 'error' : 'condition-miss',
      definitionRevision: entry.rule.definitionRevision, agentId: frame.subject?.agent?.id,
      ...(outcome === 'unavailable' ? { reason: status.reason } : {}) }
  })
  return { values: Object.freeze(preview ? {} : values), observations }
}

export function bindFilesystemPolicyDependencies(rule, moduleId, onOutcome) {
  const controls = rule.actions.filter(isFilesystemPolicyAction).map(action => ({ action,
    dependent: new Set(rule.actions.filter(candidate => action.branchPath.every((part, i) => candidate.branchPath[i] === part)).map(candidate => candidate.id)) }))
  if (controls.length === 0) return
  rule.filesystemPolicyAvailable = (entry, frame) => {
    const applicable = controls.filter(({ dependent }) => dependent.has(entry.ruleActionId ?? entry.id))
    if (applicable.length === 0) return true
    const checking = { ...frame, ignoreFilesystemPolicyDependency: true, onOutcome: undefined,
      decisions: new Map(), actionDecisions: new Set(), actionOutcomes: new Map(), reminders: new Map() }
    if (!actionMatches(entry, checking)) return true
    return applicable.every(({ action }) => {
      const status = filesystemPolicyStatus(action.capability, frame.subject?.agent)
      if (status.available) return true
      try { onOutcome?.({ moduleId, ruleId: rule.id, actionId: action.id, channel: `host:${action.capability}`,
        outcome: 'unavailable', identityOutcome: 'condition-unavailable', reason: status.reason,
        definitionRevision: rule.definitionRevision, agentId: frame.subject?.agent?.id }) } catch { /* 诊断不改变资格 */ }
      return false
    })
  }
}

function accepted(exec, capability) {
  if (exec?.signal?.aborted) return false
  const step = toolStepFor(exec)
  return step?.status === 'sealed' && step.filesystemPolicy?.[capability] === true
    && filesystemPolicyStatus(capability, exec.agent).available
}

// 克隆每次返回的 policy，避免官方 resolver 重用对象时串用另一个 Agent 的身份。
filesystemPolicyState.policy = (policy, exec) => {
  if (policy == null || typeof policy !== 'object' || !accepted(exec, 'filesystem-fence')) return policy
  const copy = Object.create(Object.getPrototypeOf(policy), Object.getOwnPropertyDescriptors(policy))
  policies.set(copy, { exec, step: toolStepFor(exec) })
  return copy
}
filesystemPolicyState.fence = (policy, ctx) => {
  const entry = policy != null && typeof policy === 'object' ? policies.get(policy) : undefined
  return entry !== undefined && ownersFor(ctx, entry.exec.agent?.ctx?.get('fs')) && toolStepFor(entry.exec) === entry.step && accepted(entry.exec, 'filesystem-fence')
}
filesystemPolicyState.intent = (actor, ctx) => ownersFor(ctx, actor?.agent?.ctx?.get('fs')) && accepted(actor, 'filesystem-observation')

/** 在共享 tool-fs hook 已核对原始指纹后调用，不重新校验其它分组变换后的内容。 */
export function transformFilesystemTool(source) {
  const from = 'async resolvePolicy(toolName, args, exec) {'
  if (source.split(from).length !== 2) {
    filesystemPolicyState.status.set('tool', { available: false, reason: 'filesystem tool policy structure mismatch' })
    return source
  }
  filesystemPolicyState.status.set('tool', { available: true, reason: '' })
  return source.replace(from, `async resolvePolicy(toolName, args, exec) {
    const policy = await this.promptToolOriginalResolvePolicy(toolName, args, exec);
    exec.signal.throwIfAborted();
    return globalThis[Symbol.for("prompt-tool:filesystem-policy")]?.policy(policy, exec) ?? policy;
  }
  async promptToolOriginalResolvePolicy(toolName, args, exec) {`)
}
