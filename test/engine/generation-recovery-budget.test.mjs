import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { readdirSync, readFileSync, writeFileSync, symlinkSync, mkdirSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import { isolatedHome } from '../fixtures/host-harness.mjs'
import { createGenerationRecoveryState } from '../../src/host/generation-recovery-state.ts'
import { apply } from '../../engine/generation-recovery.mjs'

const { home } = isolatedHome('pt-recovery-budget-')

test('恢复额度：两入口同一执行只扣一次，重新创建owner与重挂不清零，主子隔离', async t => {
  const root = join(home, 'persistent'), state = createGenerationRecoveryState(root)
  const wake = []
  const agent = { session: { id: 'budget', header: {}, snapshotEvents: () => [] }, whenIdle: async () => {}, followup: message => wake.push(message) }
  const config = { enabled: true, recoverEmpty: true, mainRecoveryLimit: 1, subagentRecoveryLimit: 2 }
  let ctx = new Context(), off = apply(ctx, config, { agent, recoveryState: state })
  const end = async turn => {
    await ctx.waterfall('agent/request', { agent, turn, step: 1, signal: new AbortController().signal }, async () => ({}))
    ctx.emit('session/event', agent.session, { type: 'assistant/message', data: { turn, step: 1, message: { content: [{ type: 'reasoning', text: 'thinking' }] } } })
    ctx.emit('session/event', agent.session, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
    ctx.emit('session/event', agent.session, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
    await new Promise(resolve => setImmediate(resolve))
  }
  await end(1)
  assert.equal(wake.length, 1)
  assert.ok(wake[0].content[0].text.trim())
  assert.equal(state.read('budget').used, 1)
  off()
  ctx = new Context()
  t.after(apply(ctx, config, { agent, recoveryState: createGenerationRecoveryState(root) }))
  await end(2)
  assert.equal(wake.length, 1)
  assert.equal(state.claim('child', '1:1', 2).claimed, true)
  assert.equal(state.claim('child', '1:1', 2).claimed, false)
  assert.equal(state.claim('child', '2:1', 2).claimed, true)
  assert.equal(state.claim('child', '3:1', 2).claimed, false)
  assert.throws(() => apply(new Context(), { enabled: true, mainRecoveryLimit: 1001 }, { agent }), /0 to 1000/)
  const recordFile = join(root, readdirSync(root).find(file => file.endsWith('.json') && JSON.parse(readFileSync(join(root, file), 'utf8')).sessionId === 'budget'))
  writeFileSync(recordFile, '{"broken":true}')
  assert.throws(() => state.claim('budget', '3:1', 1), /损坏/)
  assert.equal(readFileSync(recordFile, 'utf8'), '{"broken":true}', '损坏记录不可冒充零额度覆盖')
  const outside = join(home, 'outside')
  mkdirSync(outside)
  symlinkSync(outside, join(home, 'linked-state'), 'junction')
  assert.throws(() => createGenerationRecoveryState(join(home, 'linked-state')).claim('budget', '1:1', 1), /链接/)
})

test('恢复取消：idle迟到后取消或释放不再唤醒，额度已消费也不重试', async () => {
  for (const action of ['cancel', 'dispose']) {
    const ctx = new Context(), abort = new AbortController(), wake = []
    let resolveIdle
    const agent = { session: { id: action, header: {}, snapshotEvents: () => [] }, whenIdle: () => new Promise(resolve => { resolveIdle = resolve }), followup: message => wake.push(message) }
    const state = createGenerationRecoveryState(join(home, action))
    const off = apply(ctx, { enabled: true, recoverEmpty: true, mainRecoveryLimit: 1 }, { agent, recoveryState: state })
    await ctx.waterfall('agent/request', { agent, turn: 1, step: 1, signal: abort.signal }, async () => ({}))
    ctx.emit('session/event', agent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    if (action === 'cancel') abort.abort()
    else off()
    resolveIdle()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(wake.length, 0)
    assert.equal(state.read(action).used, 1)
    off()
  }
})
