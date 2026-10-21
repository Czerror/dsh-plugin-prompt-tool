import { test } from 'node:test'
import assert from 'node:assert/strict'
import { composePreStepSources, createPreStepSource } from '../../engine/pre-step-source.mjs'
import { applyPromptConfigSources, moduleSourceId } from '../fixtures/pre-step.mjs'
import { PRE_STEP_COORDINATOR_SERVICE } from '../../engine/service-names.mjs'

const promotion = () => ({ main: {}, withSubagents: {} })

test('createPreStepSource：resolve 使用来源 ctx，而不是批 ctx', async () => {
  const sourceCtx = { scope: 'source' }
  let seen
  const source = createPreStepSource({
    sourceId: moduleSourceId('alpha'),
    ctx: sourceCtx,
    configs: [{ id: 'alpha', resolve: async (input) => { seen = input.ctx; return { text: 'A' } } }],
    promotion: promotion(),
  })
  await source.configs[0].resolve({ ctx: { scope: 'batch' } })
  assert.equal(seen, sourceCtx)
})

test('composePreStepSources：按 rule 把上报分给来源自己的 sink', () => {
  const ruleA = { id: 'rule-a' }
  const ruleB = { id: 'rule-b' }
  const owner = promotion()
  const seen = []
  const a = createPreStepSource({ sourceId: 'a', ctx: {}, promotion: owner,
    configs: [{ id: 'a', rule: ruleA, resolve: async () => ({}) }],
    onOutcome: report => seen.push(['a', report]) })
  const b = createPreStepSource({ sourceId: 'b', ctx: {}, promotion: owner,
    configs: [{ id: 'b', rule: ruleB, resolve: async () => ({}) }],
    onOutcome: report => seen.push(['b', report]) })
  const composed = composePreStepSources([a, b])
  assert.equal(composed.configs.length, 2)
  composed.report?.(ruleA, 'agent/pre-step', 'hit')
  composed.report?.(ruleB, 'agent/pre-step', 'miss')
  assert.deepEqual(seen, [
    ['a', { ruleId: 'rule-a', channel: 'agent/pre-step', outcome: 'hit' }],
    ['b', { ruleId: 'rule-b', channel: 'agent/pre-step', outcome: 'miss' }],
  ])
})

test('composePreStepSources：promotion owner 不一致或缺失都 fail loud', () => {
  const a = createPreStepSource({ sourceId: 'a', ctx: {}, promotion: promotion(), configs: [] })
  const b = createPreStepSource({ sourceId: 'b', ctx: {}, promotion: promotion(), configs: [] })
  assert.throws(() => composePreStepSources([a, b]), /promotion owner/)
  const none = createPreStepSource({ sourceId: 'none', ctx: {}, configs: [{ id: 'none', resolve: async () => ({}) }] })
  assert.throws(() => composePreStepSources([none]), /promotion owner/)
})

test('composePreStepSources：空来源没有 promotion 也返回空批', () => {
  const composed = composePreStepSources([])
  assert.deepEqual(composed.configs, [])
  assert.deepEqual(composed.ruleActions, [])
  assert.equal(composed.report, undefined)
})

test('applyPromptConfigSources：协调器替换时 source 改用新 owner 重新注册', async () => {
  const services = {}
  const listeners = new Map()
  const ctx = {
    get: name => services[name],
    on(name, handler) {
      const list = listeners.get(name) ?? []
      list.push(handler)
      listeners.set(name, list)
      return () => listeners.set(name, list.filter(item => item !== handler))
    },
    effect(callback) { callback() },
    logger: { warn() {} },
  }
  const pair = () => ({ main: {}, withSubagents: {} })
  const coordinator = (name, owner) => ({
    name,
    promotion: owner,
    registered: [],
    released: 0,
    registerPreset(sourceId, source) {
      this.registered.push({ sourceId, source })
      return () => { this.released += 1 }
    },
  })
  const a = coordinator('a', pair())
  const b = coordinator('b', pair())
  services[PRE_STEP_COORDINATOR_SERVICE] = a
  const source = createPreStepSource({ sourceId: 'direct:switch', ctx,
    configs: [{ id: 'switch', layer: 'pre-step', position: 'after-user', resolve: async () => ({}) }] })
  const release = applyPromptConfigSources([source])
  assert.equal(a.registered[0].source.promotion, a.promotion)
  services[PRE_STEP_COORDINATOR_SERVICE] = b
  await listeners.get('agent/pre-step')[0]({}, async () => ({ kind: 'enter', messages: [] }))
  assert.equal(a.released, 1, '旧协调器来源被撤销')
  assert.equal(b.registered[0].source.promotion, b.promotion, '新来源携带新协调器 owner')
  release()
  assert.equal(b.released, 1, '释放 apply 时撤新注册')
})
