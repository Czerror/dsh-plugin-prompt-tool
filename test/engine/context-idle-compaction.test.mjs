import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compactIdleRegion } from '../../engine/context-idle-compaction.mjs'

function fixture() {
  const events = [
    { seq: 0, type: 'turn/end', data: { turn: 1 } },
    { seq: 2, type: 'user/message', data: { id: 'b', role: 'user', content: [{ type: 'text', text: 'B'.repeat(2000) }] } },
    { seq: 9, type: 'user/message', data: { id: 'a', role: 'user', content: [{ type: 'text', text: 'A'.repeat(2000) }] } },
  ]
  const session = {
    id: 's', surface: { nodes: [9, 2] }, snapshotEvents: () => [...events],
    deriveEventMessage: e => e.data,
    requestHeader: () => ({}), append(type, data, extra) { const e = { seq: 10 + events.length, type, data, ...extra }; events.push(e); return e },
  }
  let flushed = 0
  const dependencies = {
    agent: { session }, range: { start: 9, end: 2 }, signal: new AbortController().signal,
    meter: { measure: () => ({ nodes: [{ seq: 9, tokens: 1000, heuristicTokens: 1000 }, { seq: 2, tokens: 1000, heuristicTokens: 1000 }] }), estimateMessage: () => 20 },
    sessions: { async flush() { flushed++ } },
    compaction: { async summarize() { return { summary: [{ type: 'text', text: 'known summary' }], provider: 'p', model: 'm' } } },
    pairing: { toolPairingBalancedBefore: () => true, toolPairingBalancedAfter: () => true, compactCheckpointSource: id => ({ kind: 'compact-checkpoint', compactionId: id }) },
  }
  return { dependencies, events, flushed: () => flushed }
}

test('idle局部压缩按真实surface列表提交合法来源与单次维护结算', async () => {
  const { dependencies, events, flushed } = fixture()
  const result = await compactIdleRegion(dependencies)
  assert.deepEqual(result.shadowedSeqs, [9, 2])
  assert.equal(events.at(-1).type, 'compaction/end')
  assert.equal(events.at(-1).data.turn, null)
  assert.deepEqual(events.at(-2).surfaceOp, { op: 'replace', startSeq: 9, endSeq: 2 })
  assert.equal(flushed(), 1)
})

test('idle局部压缩取消及非缩减结果不写替换，不产生成功epoch', async () => {
  for (const failure of ['cancel', 'size', 'observer']) {
    const { dependencies, events } = fixture(), abort = new AbortController()
    dependencies.signal = abort.signal
    if (failure === 'cancel') dependencies.compaction.summarize = async () => { abort.abort(); return {} }
    else if (failure === 'size') dependencies.meter.estimateMessage = () => 2000
    else {
      const append = dependencies.agent.session.append
      dependencies.agent.session.append = (...args) => { const event = append(...args); if (args[0] === 'compaction/summary') abort.abort(); return event }
    }
    await assert.rejects(compactIdleRegion(dependencies))
    assert.equal(events.filter(e => e.surfaceOp).length, 0)
    assert.ok(events.at(-1).data.error)
  }
})
