import test from 'node:test'
import assert from 'node:assert/strict'
import { Context, Service, symbols } from '@deepseek-ai/cordis'
import { createCommandConfine } from '../../engine/command-confine.mjs'
import { compileRules } from '../../engine/rule-spec.mjs'

const action = { capability: 'command-confine-passthrough', value: true }
test('command process rules compile only with explicit process scope and without private facts', () => {
  const rule = { id: 'command', executionScope: 'process', then: [{ id: 'call', kind: 'host-control', ...action }] }
  assert.equal(compileRules([rule])[0].actions[0].capability, 'command-confine-passthrough')
  assert.throws(() => compileRules([{ ...rule, executionScope: 'agent' }]), /executionScope process/)
  assert.throws(() => compileRules([{ ...rule, if: { scope: { audience: 'main' } } }]), /Agent conditions/)
})
class Provider extends Service {
  constructor(ctx) { super(ctx, 'sandbox') }
  confine(...args) { this.seen = args; if (this.error) throw this.error; return this.result }
}

test('public sandbox calls preserve original identity, process selection and caller cancellation', async () => {
  const ctx = new Context()
  await ctx.plugin(Provider)
  const state = createCommandConfine()
  const wrong = await state.install(ctx, class OtherProvider extends Provider {})
  assert.equal(state.status().available, false)
  await wrong()
  const off = await state.install(ctx, Provider)
  assert.equal(state.status().available, true)
  const owner = ctx.sandbox, argv = ['fixture', 'literal'], policy = { mode: 'read-only' }
  const signal = new AbortController().signal
  const originalResult = { original: true }
  owner.result = originalResult
  assert.equal(owner.confine(argv, policy, signal), originalResult)
  assert.deepEqual(owner.seen, [argv, policy, signal])
  const error = new Error('original refusal')
  owner.error = error
  assert.throws(() => owner.confine(argv, policy, signal), e => e === error)
  assert.throws(() => state.replace('module', [{ ...action, agentId: 'private' }]), /process/)
  const withdraw = state.replace('module', [action])
  const newer = state.replace('module', [action])
  withdraw()
  assert.deepEqual(owner.confine(argv, policy, signal), {
    argv, enforcement: 'full', denialSignatures: [], runnerFailureRules: [],
  })
  const cancelled = new AbortController()
  cancelled.abort(error)
  assert.throws(() => owner.confine(argv, policy, cancelled.signal), e => e === error)
  newer()
  assert.throws(() => owner.confine(argv, policy, signal), e => e === error)
  await off()
  assert.equal(ctx.sandbox[symbols.original].confine, Provider.prototype.confine)
  assert.equal(state.status().available, false)
  await ctx.fiber.dispose()
})

test('async calls keep accepted snapshots; disposal leaves third party wrappers and dead owners inert', async () => {
  class AsyncProvider extends Provider { async confine(...args) { return super.confine(...args) } }
  const ctx = new Context()
  await ctx.plugin(AsyncProvider)
  const state = createCommandConfine(), off = await state.install(ctx, AsyncProvider)
  const owner = ctx.sandbox[symbols.original], original = owner.confine
  await state.install(ctx, AsyncProvider)
  assert.equal(owner.confine, original)
  const withdraw = state.replace('module', [action])
  const abort = new AbortController(), error = new Error('caller cancellation')
  abort.abort(error)
  await assert.rejects(owner.confine([], {}, abort.signal), e => e === error)
  const accepted = owner.confine(['fixture'], {})
  assert.ok(accepted instanceof Promise)
  withdraw()
  assert.deepEqual(await accepted, { argv: ['fixture'], enforcement: 'full', denialSignatures: [], runnerFailureRules: [] })
  const result = Promise.resolve({ original: true })
  owner.result = result
  assert.deepEqual(await owner.confine([], {}), await result)
  const outer = function (...args) { return original.apply(this, args) }
  owner.confine = outer
  await off()
  state.replace('module', [action])
  await state.install(ctx, AsyncProvider)
  assert.equal(owner.confine, outer)
  assert.deepEqual(await owner.confine([], {}), await result)
  assert.equal(state.status().available, false)
  await ctx.fiber.dispose()
})

test('reinstalling the adapter on a still-live public provider restores command selection', async () => {
  const ctx = new Context()
  await ctx.plugin(Provider)
  const state = createCommandConfine()
  const first = await state.install(ctx, Provider)
  state.replace('module', [action])
  assert.deepEqual(ctx.sandbox.confine(['fixture'], {}), {
    argv: ['fixture'], enforcement: 'full', denialSignatures: [], runnerFailureRules: [],
  })
  await first()
  ctx.sandbox.result = { original: true }
  assert.deepEqual(ctx.sandbox.confine(['fixture'], {}), { original: true })
  const second = await state.install(ctx, Provider)
  try {
    assert.deepEqual(ctx.sandbox.confine(['fixture'], {}), {
      argv: ['fixture'], enforcement: 'full', denialSignatures: [], runnerFailureRules: [],
    })
  } finally { await second(); await ctx.fiber.dispose() }
})
