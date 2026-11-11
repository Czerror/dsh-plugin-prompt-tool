import { applyToolDescriptions } from './actions/assembly.mjs'
import { AsyncLocalStorage } from 'node:async_hooks'
import { toolStepFor } from './tool-scope.mjs'

const validationLookups = new WeakSet()

/** run_code 是官方执行器生成的保留传输，只在模型 schema 出口投影说明。 */
export function applyTransportDescriptions(assembly, step) {
  if (step === undefined || step.transportDescriptionsApplied) return assembly
  step.transportDescriptionsApplied = true
  const plans = (step.toolDescriptions ?? []).map(plan => ({ ...plan,
    entries: plan.entries.filter(entry => entry.name === 'run_code'), source: plan,
  })).filter(plan => plan.entries.length > 0)
  if (plans.length === 0) return assembly
  const view = new Map((assembly.tools ?? []).filter(tool => tool.name === 'run_code').map(tool => [tool.name, tool]))
  const reasons = step.transportDescriptionReasons = new Map()
  const described = applyToolDescriptions(view, plans, (plan, reason) => {
    const current = reasons.get(plan.source) ?? []
    current.push(reason)
    reasons.set(plan.source, current)
  })
  if (described === view) return assembly
  return { ...assembly, tools: assembly.tools.map(tool => described.get(tool.name) ?? tool) }
}

export function toolDescriptionObservation(plan, step) {
  const reasons = step?.transportDescriptionReasons?.get(plan)
  if (reasons === undefined) return plan.observation
  return { ...plan.observation, outcome: 'unavailable', identityOutcome: 'target-mismatch',
    reason: [plan.observation.reason, ...reasons].filter(Boolean).join('; ') }
}

/** 技能目录仍归官方；这里只读验证本步骤已接受的说明目标。 */
export async function settleSkillDescriptions(ctx, context) {
  const step = toolStepFor(context)
  if (step === undefined || step.skillDescriptionsSettled || !step.skillDescriptions?.some(plan => plan.entries.length > 0)) return
  step.skillDescriptionsSettled = true
  const reasons = step.skillDescriptionReasons = new Map()
  const unavailable = reason => {
    for (const plan of step.skillDescriptions) if (plan.entries.length > 0) {
      reasons.set(plan, [reason])
      plan.warnOnce(`${plan.plugin}: ${reason}`)
    }
  }
  const skills = ctx.get('skills')
  if (skills === undefined) { unavailable('assembly.skillDescriptions requires skills service; skipped'); return }
  let snapshot
  try {
    const lookup = { scope: context.agent, cwd: context.agent?.session?.header?.cwd, signal: context.signal }
    validationLookups.add(lookup)
    snapshot = await skills.snapshot(lookup)
    context.signal?.throwIfAborted()
  } catch (error) {
    context.signal?.throwIfAborted()
    unavailable(`assembly.skillDescriptions skill discovery unavailable: ${String(error?.message ?? error)}; skipped`)
    return
  }
  applyToolDescriptions(new Map(snapshot.skills.map(skill => [skill.name, skill])), step.skillDescriptions, (plan, reason) => {
    const current = reasons.get(plan) ?? []
    current.push(reason)
    reasons.set(plan, current)
  }, 'skillDescriptions')
}

export function skillDescriptionObservation(plan, step) {
  const reasons = step?.skillDescriptionReasons?.get(plan)
  if (reasons === undefined) return plan.observation
  return { ...plan.observation, outcome: 'unavailable', identityOutcome: 'target-mismatch', reason: reasons.join('; ') }
}

/** 装配目录首次渲染只消费本步骤已验证的说明，不开放 pending 服务读取。 */
export async function readSkillCatalog(skills, lookup, context) {
  validationLookups.add(lookup)
  const result = await skills.list(lookup)
  if (!Array.isArray(result)) return []
  const step = toolStepFor(context)
  if (!step?.skillDescriptionsSettled || step.status === 'closed' || context.signal?.aborted) return result
  const plans = step.skillDescriptions.filter(plan => !step.skillDescriptionReasons?.has(plan))
  const view = new Map(result.map(skill => [skill.name, skill]))
  const described = applyToolDescriptions(view, plans, undefined, 'skillDescriptions')
  return described === view ? result : result.map(skill => described.get(skill.name))
}

/** 只在模型步骤或工具调用中读取精确 Agent 的已封存配置；管理界面不改写。 */
export function installSkillDescriptionProjection(ctx) {
  const calls = new AsyncLocalStorage()
  let active = true
  const releases = ['agent/pre-step', 'tools/execute'].map(channel => ctx.on(channel,
    (context, next) => calls.run(context, next), { global: true, prepend: true }))
  releases.push(ctx.on('internal/get', (_caller, name, _error, next) => {
    const service = next()
    if (name !== 'skills' || service === undefined) return service
    return new Proxy(service, { get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver)
      if (!['snapshot', 'get', 'list'].includes(property)) return value
      return async (...args) => {
        const context = calls.getStore()
        const lookup = property === 'get' ? args[1] : args[0]
        const step = active && context?.agent !== undefined && lookup?.scope === context.agent && !validationLookups.has(lookup) ? toolStepFor(context) : undefined
        const plans = step?.status === 'sealed' ? step.skillDescriptions?.filter(plan => !step.skillDescriptionReasons?.has(plan)) : undefined
        const result = await Reflect.apply(value, target, args)
        if (!plans?.length || result === undefined) return result
        const skills = property === 'snapshot' ? result.skills : property === 'list' ? result : [result]
        const view = new Map(skills.map(skill => [skill.name, skill]))
        const selected = property === 'get' ? plans.map(plan => ({ ...plan, entries: plan.entries.filter(entry => view.has(entry.name)) })) : plans
        const described = applyToolDescriptions(view, selected, undefined, 'skillDescriptions')
        if (view === described) return result
        const projected = skills.map(skill => described.get(skill.name))
        return property === 'snapshot' ? { ...result, skills: projected } : property === 'list' ? projected : projected[0]
      }
    } })
  }, { global: true }))
  return () => { active = false; releases.reverse().forEach(release => release()); calls.disable() }
}
