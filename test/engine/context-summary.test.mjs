import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createProvenanceCompaction } from '../../engine/context-summary.mjs'

class Base {
  constructor(ctx) { this.ctx = ctx }
  async summarize() { return { summary: [{ type: 'text', text: 'SUMMARY' }], provider: 'p', model: 'm' } }
  compact(input, agent, signal) { return this.summarize(input, agent, signal) }
}
function fixture(id, tokens = 10000) {
  const messages = ['sys', 'one', 'two', 'three'].map((name, index) => ({ id: name, role: index ? 'user' : 'system', content: [{ type: 'text', text: 'SAME BODY' }] }))
  const events = messages.map((message, seq) => ({ seq, type: seq ? 'user/message' : 'system/message', data: { message } }))
  const session = { id, surface: { nodes: [0, 3, 1, 2] }, snapshotEvents: () => events, deriveEventMessage: event => event.data.message }
  const warnings = []
  const ctx = { tokenMeter: { measure: () => ({ nodes: session.surface.nodes.map(seq => ({ seq, tokens })) }), estimateMessage: message => message.content.reduce((sum, block) => sum + block.text.length, 0) }, logger: { warn: text => warnings.push(text) } }
  return { session, agent: { session }, ctx, messages, warnings }
}

test('压缩摘要按真实message身份引用非单调surface，缓存system头不计入来源', async () => {
  const f = fixture('session-A')
  const Compaction = createProvenanceCompaction(Base, { sourceModuleId: 'soul' })
  const result = await new Compaction(f.ctx).compact({ messages: [f.messages[0], f.messages[3], f.messages[1]] }, f.agent)
  const reference = JSON.parse(/^\[source: (.+)\]/.exec(result.summary[0].text)[1])
  assert.equal(reference.sessionId, 'session-A')
  assert.deepEqual(reference.seqs, [3, 1], '相同正文不能被误当作相同来源')
  assert.equal(result.summary.at(-1).text, 'SUMMARY')
  assert.equal(result.provider, 'p')
  assert.equal(f.warnings.length, 0)
})

test('门牌必须连同官方framing通过shrink预算；来源不明时不按正文猜seq', async () => {
  const Compaction = createProvenanceCompaction(Base, { sourceModuleId: 'soul' })
  const tight = fixture('tight', 200)
  const input = { messages: [tight.messages[0], tight.messages[3], tight.messages[1]] }
  const result = await new Compaction(tight.ctx).compact(input, tight.agent)
  assert.deepEqual(result.summary, [{ type: 'text', text: 'SUMMARY' }], '预算紧时保留原本可用的摘要')
  assert.equal(tight.warnings.length, 1)
  assert.match(tight.warnings[0], /shrink budget/)
  const unknown = fixture('unknown')
  const copiedBody = { ...unknown.messages[3], id: 'NOT-A-REAL-MESSAGE' }
  const original = await new Compaction(unknown.ctx).compact({ messages: [unknown.messages[0], copiedBody] }, unknown.agent)
  assert.deepEqual(original.summary, [{ type: 'text', text: 'SUMMARY' }])
  assert.equal(unknown.warnings.length, 1)
})

test('异步摘要按会话隔离来源，取消或卸载后不发布迟到summary', async () => {
  class Deferred extends Base {
    async summarize(input, agent) {
      await agent.wait
      return super.summarize(input, agent)
    }
  }
  let active = true
  const Compaction = createProvenanceCompaction(Deferred, { sourceModuleId: 'soul', isActive: () => active })
  const a = fixture('A'), b = fixture('B')
  let finishA, finishB
  a.agent.wait = new Promise(resolve => { finishA = resolve })
  b.agent.wait = new Promise(resolve => { finishB = resolve })
  const compactor = new Compaction({ ...a.ctx, tokenMeter: { ...a.ctx.tokenMeter, measure: session => ({ nodes: session.surface.nodes.map(seq => ({ seq, tokens: 10000 })) }) } })
  const first = compactor.compact({ messages: [a.messages[0], a.messages[3], a.messages[1]] }, a.agent)
  const second = compactor.compact({ messages: [b.messages[0], b.messages[2]] }, b.agent)
  finishB()
  assert.match((await second).summary[0].text, /"sessionId":"B"/)
  finishA()
  assert.match((await first).summary[0].text, /"sessionId":"A"/)
  const abort = new AbortController()
  let finish
  a.agent.wait = new Promise(resolve => { finish = resolve })
  const cancelled = compactor.compact({ messages: [a.messages[0], a.messages[1]] }, a.agent, abort.signal)
  abort.abort(); finish()
  await assert.rejects(cancelled, /abort/i)
  a.agent.wait = new Promise(resolve => { finish = resolve })
  const released = compactor.compact({ messages: [a.messages[0], a.messages[1]] }, a.agent)
  active = false; finish()
  await assert.rejects(released, /released/)
})
