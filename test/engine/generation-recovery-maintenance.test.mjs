import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { apply } from '../../engine/generation-recovery.mjs'

test('恢复维护：默认不扩大失败范围，null停止，显式fallback只用真实结果', async () => {
  for (const mode of ['failed', 'null', 'fallback', 'success', 'abort', 'unload']) {
    const ctx = new Context(), abort = new AbortController(), wake = [], reports = [], calls = []
    ctx.logger = { warn: text => reports.push(text), info: text => reports.push(text) }
    const agent = { session: { id: mode, header: {}, snapshotEvents: () => [] }, whenIdle: async () => {}, followup: message => wake.push(message) }
    let off
    const runtime = {
      async compactRecovery() {
        calls.push('region')
        if (mode === 'abort') { abort.abort(); throw abort.signal.reason }
        if (mode === 'unload') { off(); throw new Error('released') }
        if (mode === 'null') return null
        if (mode === 'success') return { shadowedSeqs: [9, 2], shadowedRange: { start: 9, end: 2 } }
        throw new Error('region failed')
      },
      async compactNow() { calls.push('full'); return { shadowedSeqs: [11, 3], shadowedRange: { start: 11, end: 3 } } },
    }
    off = apply(ctx, { enabled: true, recoverEmpty: true, mainRecoveryLimit: 1, maintenanceCompression: true, allowFullFallback: mode === 'fallback' || mode === 'abort' || mode === 'unload' },
      { agent, recoveryState: { claim: () => ({ claimed: true, used: 1 }) }, contextRuntimeOf: () => runtime })
    await ctx.waterfall('agent/request', { agent, turn: 1, step: 1, signal: abort.signal }, async () => ({}))
    const end = { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }
    ctx.emit('session/event', agent.session, end)
    ctx.emit('session/event', agent.session, end)
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(calls, mode === 'fallback' ? ['region', 'full'] : ['region'])
    assert.equal(wake.length, mode === 'fallback' || mode === 'success' ? 1 : 0)
    if (mode === 'fallback') {
      assert.match(wake[0].content[0].text, /11,3/)
      assert.doesNotMatch(wake[0].content[0].text, /9,2/)
    }
    if (mode === 'null') assert.ok(reports.some(text => text.includes('no-op')))
    off()
  }
})
