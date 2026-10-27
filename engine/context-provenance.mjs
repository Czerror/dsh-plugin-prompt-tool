import { Context } from '@deepseek-ai/cordis'
import { bool, defineConfig, enumOf, int, passthrough } from './fields.mjs'
import { capabilityAudience } from './agent-capability.mjs'
import { importHostCapability } from './host-package.mjs'
import { routeContextRuntime } from './context-routing.mjs'
import { createProvenancePruner } from './context-pruner.mjs'
import { createProvenanceCompaction } from './context-summary.mjs'
import { compactIdleRegion } from './context-idle-compaction.mjs'
import { historyEvents } from './history.mjs'

export const name = 'context-provenance'
export const inject = ['llm', 'sessions', 'tokenMeter']
const configObject = passthrough((value, plugin, field) => {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${plugin}: ${field} must be an object`)
  return value
})
export const configContract = defineConfig({
  enabled: bool({ default: false }), audience: enumOf(['all', 'main', 'subagent'], { default: 'all' }),
  auto: bool({ default: true }), modelSwitch: bool({ default: true }), prune: bool({ default: true }),
  basic: configObject, pruner: configObject,
  recoveryRetainTokens: int({ min: 0, default: 1024 }),
})
const runtimes = new WeakMap()
export const contextRuntimeOf = agent => runtimes.get(agent)

/** 用真实surface位置与配对边界选区；保留尾部，不把seq当连续整数。 */
export function compactableRange(session, measurement, retainTokens, pairing) {
  const nodes = measurement.nodes
  const events = new Map(historyEvents(session).map(event => [event.seq, event]))
  if (nodes.some(node => !events.has(node.seq))) throw new Error('context-provenance: surface event missing')
  let first = nodes.findIndex(node => events.get(node.seq).type !== 'system/message')
  if (first < 0) return null
  while (first < nodes.length && !pairing.toolPairingBalancedBefore(session, nodes[first].seq)) first++
  let retained = 0, last = nodes.length - 1
  while (last >= first && retained < retainTokens) retained += nodes[last--].tokens
  while (last >= first && !pairing.toolPairingBalancedAfter(session, nodes[last].seq)) last--
  return last < first ? null : { start: nodes[first].seq, end: nodes[last].seq }
}

/** 宿主依赖是实际适配器接缝，隔离验证可提供同版本官方构造器。 */
export async function mountContextRuntime(ctx, raw, { agent, sourceModuleId }, packages) {
  const config = configContract.parse(raw, name)
  if (!config.enabled || !agent || config.audience !== 'all' && config.audience !== capabilityAudience(agent)) return
  if (runtimes.has(agent)) throw new Error('context-provenance: Agent already has a runtime owner')
  ctx.fiber.assertActive()
  const { Basic, Pruner, pairing } = packages
  const privateCtx = new Context()
  const lifetime = new AbortController()
  let active = true
  const status = { state: 'ready', last: null }
  const off = []
  let offRoute = () => {}, runtime
  // 先登记所有权再等待构造器，父scope在await期间释放也能取消私有实例。
  const dispose = ctx.effect(() => () => {
    active = false; lifetime.abort(); status.state = 'disabled'
    if (runtime && runtimes.get(agent) === runtime) runtimes.delete(agent)
    offRoute(); for (const remove of off) remove()
    return privateCtx.fiber.dispose()
  })
  const meter = ctx.get('tokenMeter'), llm = ctx.get('llm'), sessions = ctx.get('sessions')
  // 只把公开方法绑定到原服务；私有Context不接管共享服务生命周期。
  privateCtx.provide('tokenMeter', { measure: (...args) => meter.measure(...args), estimateMessage: message => meter.estimateMessage(message) })
  privateCtx.provide('llm', { stream: options => llm.stream(options), resolveModelInfo: (...args) => llm.resolveModelInfo(...args) })
  privateCtx.provide('sessions', { flush: session => sessions.flush(session) })
  const combined = signal => signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal
  const check = signal => { combined(signal).throwIfAborted() }
  const Compaction = createProvenanceCompaction(Basic, { sourceModuleId, isActive: () => active, signalOf: () => lifetime.signal })
  try {
    if (config.prune) {
      const CitedPruner = createProvenancePruner(Pruner, { sourceModuleId, isActive: () => active, signalOf: () => lifetime.signal })
      await privateCtx.plugin(CitedPruner, config.pruner)
      check()
    }
    await privateCtx.plugin(Compaction, { ...config.basic, auto: config.auto })
    check()
  } catch (error) { await dispose(); throw error }
  const compaction = privateCtx.get('compaction'), pruner = privateCtx.get('toolResultPruner')
  const run = async (action, signal) => {
    check(signal); status.state = 'running'
    try {
      const result = await action(combined(signal))
      check(signal)
      status.state = result === null ? 'no-op' : 'success'; status.last = result
      return result
    } catch (error) { status.state = combined(signal).aborted ? 'cancelled' : 'failed'; throw error }
  }
  runtime = {
    status: () => ({ ...status }),
    compactNow: (signal, commandId) => run(abort => compaction.compactNow(agent, abort, commandId), signal),
    compactRegion: (start, end, signal) => run(abort => agent.status === 'idle'
      ? agent.runMaintenance(maintenanceSignal => compactIdleRegion({ agent, range: { start, end },
        signal: AbortSignal.any([abort, maintenanceSignal]), meter, sessions, compaction, pairing }))
      : compaction.compactRegion(start, end, agent, abort), signal),
    compactRecovery: signal => run(abort => agent.runMaintenance(async maintenanceSignal => {
      const operation = AbortSignal.any([abort, maintenanceSignal])
      operation.throwIfAborted()
      const range = compactableRange(agent.session, meter.measure(agent.session), config.recoveryRetainTokens, pairing)
      if (!range) return null
      return compactIdleRegion({ agent, range, signal: operation, meter, sessions, compaction, pairing })
    }), signal),
  }
  try {
  runtimes.set(agent, runtime)
  offRoute = routeContextRuntime(ctx, agent, {
    compaction: {
      compactNow: (_owner, signal, commandId) => runtime.compactNow(signal, commandId),
      compactRegion: (start, end, _owner, signal) => runtime.compactRegion(start, end, signal),
      compactIfNeeded: (_owner, trigger, signal) => run(abort => compaction.compactIfNeeded(agent, trigger, abort), signal),
    },
    toolResultPruner: pruner ? { pruneSession: session => { check(); return pruner.pruneSession(session, lifetime.signal) } } : undefined,
  })
  for (const event of ['agent/pre-step', 'agent/request-error']) off.push(ctx.on(event, async (payload, next) => {
    if (!active || payload.agent !== agent) return next()
    const result = await privateCtx.waterfall(event, { ...payload, signal: combined(payload.signal) }, () => undefined)
    return result === undefined ? next() : result
  }, { prepend: true }))
  // Basic的retry账本按官方durable结算与idle复位。
  off.push(ctx.on('session/event', (session, event) => { if (active && session === agent.session) privateCtx.emit('session/event', session, event) }))
  off.push(ctx.on('agent/status', payload => { if (active && payload.agent === agent) privateCtx.emit('agent/status', payload) }))
  if (config.modelSwitch) off.push(ctx.on('agent/request', async (payload, next) => {
    const request = await next()
    if (!active || payload.agent !== agent || payload.signal?.aborted) return request
    const previous = agent.session.requestHeader()
    if (!previous || previous.config.provider === request.provider && previous.config.model === request.model) return request
    const signal = combined(payload.signal)
    const info = await llm.resolveModelInfo(request.provider, request.model, signal)
    check(signal)
    const policy = { ...compaction.config, ...(compaction.config.modelPolicies?.find(p => p.provider === request.provider && p.model === request.model) ?? {}) }
    const capacity = info.context?.contextWindow
    const reserved = request.maxTokens ?? info.defaultMaxTokens ?? 0
    if (!Number.isFinite(capacity) || capacity <= reserved + policy.headroomTokens) throw new Error('context-provenance: model switch has no message budget')
    const threshold = Math.floor(Math.min(capacity * policy.thresholdRatio, capacity - reserved - policy.headroomTokens))
    const retain = policy.retainTokens ?? Math.floor((capacity - reserved) * policy.retainRatio)
    if (retain >= threshold) throw new Error('context-provenance: model switch retention exceeds budget')
    for (let attempt = 0; ; attempt++) {
      const measurement = meter.measure(agent.session, { ...previous, config: { ...previous.config, ...request } })
      if (measurement.totalTokens < threshold) return request
      if (attempt > policy.compactionRetries) throw new Error('context-provenance: model switch remains above budget')
      const range = compactableRange(agent.session, measurement, retain, pairing)
      if (!range) throw new Error('context-provenance: model switch has no compactable range')
      await runtime.compactRegion(range.start, range.end, signal)
    }
  }, { prepend: true }))
  return dispose
  } catch (error) { await dispose(); throw error }
}

export async function apply(ctx, config, options = {}) {
  const parsed = configContract.parse(config, name)
  if (!parsed.enabled) return
  const [{ BasicCompactionEngine: Basic }, { ToolResultPruner: Pruner }, pairing] = await Promise.all([
    importHostCapability('@deepseek-ai/dsh-compaction-basic'), importHostCapability('@deepseek-ai/dsh-compaction-tool-result-pruner'), importHostCapability('@deepseek-ai/dsh-compaction'),
  ])
  return mountContextRuntime(ctx, parsed, options, { Basic, Pruner, pairing })
}
