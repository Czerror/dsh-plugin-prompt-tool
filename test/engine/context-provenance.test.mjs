import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context, Service } from '@deepseek-ai/cordis'
import { createScope, scopeTarget, scopeOf } from '@deepseek-ai/dsh-scope'
import { routeContextRuntime } from '../../engine/context-routing.mjs'
import { mountContextRuntime, contextRuntimeOf } from '../../engine/context-provenance.mjs'

test('上下文运行时按真实Agent选择唯一执行者，属性消费者路由且释放回落', async t => {
  const ctx = new Context(), counts = { stock: 0, runtime: 0, other: 0 }
  class Stock extends Service {
    constructor(ctx) {
      super(ctx, 'compaction')
      ctx.on('agent/pre-step', (_p, next) => { counts.stock++; return next() })
    }
    compactNow() { counts.stock++; return null }
  }
  await ctx.plugin(Stock)
  const scope = createScope(ctx, {}), other = createScope(ctx, {})
  const agent = { ctx: scope.ctx, session: { id: 'a' } }, b = { ctx: other.ctx, session: { id: 'b' } }
  const runtime = { compactNow() { counts.runtime++; return { shadowedSeqs: [9, 2] } } }
  const dispose = routeContextRuntime(scope.ctx, agent, { compaction: runtime })
  await Promise.resolve()
  scope.ctx.on('agent/pre-step', (_p, next) => { counts.other++; counts.runtime++; return next() })
  let consumer
  await ctx.plugin({ inject: ['compaction'], apply: c => { consumer = owner => c.compaction.compactNow(owner) } })
  await ctx.waterfall(scopeTarget(agent, scopeOf(agent.ctx)), 'agent/pre-step', { agent }, () => ({}))
  assert.deepEqual(counts, { stock: 0, runtime: 1, other: 1 })
  assert.deepEqual(consumer(agent), { shadowedSeqs: [9, 2] })
  await ctx.waterfall(scopeTarget(b, scopeOf(b.ctx)), 'agent/pre-step', { agent: b }, () => ({}))
  assert.equal(counts.stock, 1)
  assert.equal(consumer(b), null)
  dispose()
  assert.equal(consumer(agent), null)
  assert.equal(counts.stock, 3)
  t.after(() => ctx.fiber.dispose())
})

test('换模型只按目标config预算处理，失败保持原路由，运行时释放使迟到操作失效', async t => {
  const ctx = new Context(), scope = createScope(ctx, {})
  const header = { config: { provider: 'p', model: 'large', maxTokens: 10 }, tools: [] }
  const agent = { ctx: scope.ctx, session: { id: 'a', header: {}, requestHeader: () => header,
    surface: { nodes: [9, 2] }, snapshotEvents: () => [{ seq: 2, type: 'user/message' }, { seq: 9, type: 'user/message' }] } }
  let changed = false, calls = 0, resolved = 0, failure = false, measuredHeader
  ctx.provide('tokenMeter', { estimateMessage: () => 1, measure: (_session, proposed) => {
    measuredHeader = proposed
    return { totalTokens: changed ? 20 : 800, nodes: [{ seq: 9, tokens: 500 }, { seq: 2, tokens: 300 }] }
  } })
  ctx.provide('llm', { resolveModelInfo: async () => { resolved++; return { context: { contextWindow: 1000 }, defaultMaxTokens: 10 } } })
  ctx.provide('sessions', { flush: async () => {} })
  class Basic extends Service {
    constructor(c, config) { super(c, 'compaction'); this.config = { thresholdRatio: .5, headroomTokens: 10, retainTokens: 0, compactionRetries: 0, ...config } }
    async compactRegion() { calls++; if (failure) throw new Error('expected failure'); changed = true; return { shadowedSeqs: [9, 2] } }
  }
  const off = await mountContextRuntime(scope.ctx, { enabled: true, auto: false, prune: false }, { agent, sourceModuleId: 'soul' }, {
    Basic, pairing: { toolPairingBalancedBefore: () => true, toolPairingBalancedAfter: () => true },
  })
  const carrier = scopeTarget(agent, scopeOf(agent.ctx)), signal = new AbortController().signal
  await ctx.waterfall(carrier, 'agent/request', { agent, signal }, () => header.config)
  assert.equal(resolved, 0, '没有换模型不查询新模型预算')
  await ctx.waterfall(carrier, 'agent/request', { agent, signal }, () => ({ ...header.config, model: 'small' }))
  assert.equal(calls, 1)
  assert.equal(measuredHeader.config.model, 'small')
  assert.equal(header.config.model, 'large', '原header由宿主在成功请求准入时提交')
  failure = true; changed = false
  await assert.rejects(ctx.waterfall(carrier, 'agent/request', { agent, signal }, () => ({ ...header.config, model: 'small' })), /expected failure/)
  assert.equal(header.config.model, 'large')
  const runtime = contextRuntimeOf(agent)
  await off()
  assert.equal(contextRuntimeOf(agent), undefined)
  await assert.rejects(runtime.compactRegion(9, 2, signal), /abort/i)
  t.after(() => ctx.fiber.dispose())
})

test('装配尚在等待时释放父scope，不发布运行时且释放私有provider', async () => {
  const ctx = new Context(), agent = { session: { id: 'early', header: {} } }
  ctx.provide('tokenMeter', {}); ctx.provide('llm', {}); ctx.provide('sessions', {})
  let disposed = false
  class Basic extends Service {
    constructor(c) { super(c, 'compaction'); c.effect(() => () => { disposed = true }) }
  }
  const pending = mountContextRuntime(ctx, { enabled: true, prune: false, auto: false, modelSwitch: false },
    { agent, sourceModuleId: 'soul' }, { Basic, pairing: {} })
  const rejected = assert.rejects(pending)
  await ctx.fiber.dispose()
  await rejected
  assert.equal(contextRuntimeOf(agent), undefined)
  assert.equal(disposed, true)
})
