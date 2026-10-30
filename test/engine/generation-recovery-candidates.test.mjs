import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { apply } from '../../engine/generation-recovery.mjs'

test('恢复候选：流与末步结算共享身份，前步工具不掩盖末步空输出，重复事件幂等', async t => {
  const ctx = new Context(), candidates = []
  const agent = { session: { id: 'candidates', header: {}, snapshotEvents: () => [] } }
  t.after(apply(ctx, { enabled: true, recoverEmpty: true, silentReasoningChars: 6 }, { agent, onRecoveryCandidate: value => candidates.push(value) }))
  const signal = new AbortController().signal
  await ctx.waterfall('agent/request', { agent, turn: 4, step: 1, signal }, async () => ({}))
  ctx.emit('session/event', agent.session, { type: 'assistant/message', data: { turn: 4, step: 1, message: { content: [{ type: 'tool-call' }] } } })
  await ctx.waterfall('agent/request', { agent, turn: 4, step: 2, signal }, async () => ({}))
  const chunks = [{ type: 'block-start', index: 0, blockType: 'reasoning' }, { type: 'reasoning-delta', index: 0, text: 'abcdefTAIL' }, { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'abcdefTAIL' } }, { type: 'finish', reason: { kind: 'stop' } }]
  const out = await Array.fromAsync(ctx.waterfall('llm/stream', { sessionId: agent.session.id, signal }, async function* () { yield* chunks }))
  assert.equal(out.filter(chunk => chunk.type === 'finish').length, 1)
  assert.equal(out[1].text, 'abcdef')
  ctx.emit('session/event', agent.session, { type: 'assistant/message', data: { turn: 4, step: 2, message: { content: [{ type: 'reasoning', text: 'abcdef' }] } } })
  const end = { type: 'turn/end', data: { turn: 4, reason: { kind: 'completed' } } }
  ctx.emit('session/event', agent.session, end)
  ctx.emit('session/event', agent.session, end)
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].execution, '4:2')
  assert.equal(candidates[0].reason, 'silent-reasoning')
  await ctx.waterfall('agent/request', { agent, turn: 5, step: 1, signal }, async () => ({}))
  ctx.emit('session/event', agent.session, { type: 'assistant/message', data: { turn: 5, step: 1, message: { content: [{ type: 'text', text: 'RESULT' }] } } })
  ctx.emit('session/event', agent.session, { type: 'turn/end', data: { turn: 5, reason: { kind: 'completed' } } })
  assert.equal(candidates.length, 1, '正常末步不创建候选')
  await ctx.waterfall('agent/request', { agent, turn: 6, step: 1, signal }, async () => ({}))
  ctx.emit('session/event', agent.session, { type: 'assistant/message', data: { turn: 6, step: 1, message: { content: [{ type: 'reasoning', text: 'thinking' }] } } })
  ctx.emit('session/event', agent.session, { type: 'turn/end', data: { turn: 6, reason: { kind: 'completed' } } })
  assert.equal(candidates.length, 2)
  assert.equal(candidates[1].reason, 'empty-final-step', '自然reasoning-only流无重复terminal也能恢复')
})
