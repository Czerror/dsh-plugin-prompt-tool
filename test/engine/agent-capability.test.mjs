import test from 'node:test'
import assert from 'node:assert/strict'
import { capabilityAudience, matchesCapabilityAudience, createAgentCapability } from '../../engine/agent-capability.mjs'

const scope = () => {
  const disposers = []
  return { disposers, effect(callback) { const dispose = callback(); if (typeof dispose === 'function') disposers.push(dispose); return () => {} } }
}
const agent = (id = 's1', ctx = scope()) => ({ session: { id }, ctx })
const subagent = (id = 'c1', ctx = scope()) => ({ session: { id, header: { delegationDepth: 1 } }, ctx })

test('受众判定：主会话与子代理', () => {
  assert.equal(capabilityAudience(agent()), 'main')
  assert.equal(capabilityAudience(subagent()), 'subagent')
  assert.equal(capabilityAudience({}), 'main')
})

test('受众匹配：undefined / both 覆盖两类，main/subagent 精确匹配', () => {
  for (const audience of [undefined, null, 'both']) {
    assert.equal(matchesCapabilityAudience(agent(), audience), true)
    assert.equal(matchesCapabilityAudience(subagent(), audience), true)
  }
  assert.equal(matchesCapabilityAudience(agent(), 'main'), true)
  assert.equal(matchesCapabilityAudience(agent(), 'subagent'), false)
  assert.equal(matchesCapabilityAudience(subagent(), 'subagent'), true)
})

test('声明表：同 agent 同 key 幂等，只挂一次', () => {
  let mounts = 0
  const capability = createAgentCapability(() => {
    mounts += 1
    let alive = true
    return { disposers: [() => { alive = false }], data: { alive } }
  })
  const a = agent()
  capability.sync(a, 'k1')
  capability.sync(a, 'k1')
  assert.equal(mounts, 1)
  assert.equal(capability.get(a.session).data.alive, true)
})

test('声明表：key 或 scope 变化先撤旧再挂新', () => {
  const disposed = []
  let mounts = 0
  const capability = createAgentCapability(() => {
    mounts += 1
    const index = mounts
    return { disposers: [() => disposed.push(index)] }
  })
  const a = agent()
  capability.sync(a, 'k1')
  capability.sync(a, 'k2')
  assert.deepEqual(disposed, [1], 'key 变化先撤旧闸')
  const nextScope = scope()
  a.ctx = nextScope
  capability.sync(a, 'k2')
  assert.deepEqual(disposed, [1, 2], 'scope 变化先撤旧闸')
  assert.equal(mounts, 3)
})

test('声明表：mount 返回 undefined 时不建状态，下次重试', () => {
  let mounts = 0
  const capability = createAgentCapability(() => {
    mounts += 1
    return mounts === 1 ? undefined : { disposers: [] }
  })
  const a = agent()
  assert.equal(capability.sync(a, 'k'), undefined)
  assert.equal(capability.get(a.session), undefined)
  capability.sync(a, 'k')
  assert.equal(mounts, 2)
  assert.notEqual(capability.get(a.session), undefined)
})

test('声明表：scope effect 触发时只移出自己的状态', () => {
  const disposed = []
  const capability = createAgentCapability(() => ({ disposers: [() => disposed.push('x')] }))
  const a = agent()
  capability.sync(a, 'k')
  assert.equal(a.ctx.disposers.length, 1)
  a.ctx.disposers[0]()
  assert.deepEqual(disposed, ['x'])
  assert.equal(capability.get(a.session), undefined)
})

test('声明表：releaseAll 撤销全部会话', () => {
  const disposed = []
  const capability = createAgentCapability(() => ({ disposers: [() => disposed.push('x')] }))
  capability.sync(agent('s1'), 'k')
  capability.sync(agent('s2'), 'k')
  capability.releaseAll()
  assert.equal(disposed.length, 2)
  assert.equal(capability.get('s1'), undefined)
  assert.equal(capability.get('s2'), undefined)
})
