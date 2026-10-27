import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createProvenancePruner } from '../../engine/context-pruner.mjs'

const marker = '\n\n[... tool result middle pruned ...]\n\n'
class BasePruner {
  constructor(ctx, config) { this.ctx = ctx; this.config = config }
  measureContent(blocks) { return blocks.filter(block => block.type === 'text').reduce((sum, block) => sum + [...block.text].length, 0) }
  pruneContent(blocks) {
    const text = blocks[0].text, points = [...text]
    return points.length > this.config.thresholdChars ? [{ type: 'text', text: points.slice(0, this.config.headChars).join('') + marker + points.slice(-this.config.tailChars).join('') }, ...blocks.slice(1)] : null
  }
}
function session(id, texts) {
  const events = texts.map((text, seq) => ({ seq, type: 'tool/result', data: { turn: 1, step: 1, message: { id: 'm' + seq, role: 'tool', source: { kind: 'tool', callId: 'c' + seq }, content: [{ type: 'text', text }] } } }))
  const original = structuredClone(events)
  return { id, events, original, surface: { nodes: [2, 0, 1] }, snapshotEvents: () => events, eventAt: seq => events[seq], deriveEventMessage: event => event.data.message,
    append(type, data, metadata) { const event = { seq: events.length, type, data, ...metadata }; events.push(event); return event } }
}

test('工具裁剪：实际surface来源不串seq，原文marker保留，预算内引用可按事件回取', () => {
  const warnings = [], ctx = { tokenMeter: { estimateMessage: () => 100 }, logger: { warn: value => warnings.push(value) } }
  const Pruner = createProvenancePruner(BasePruner, { sourceModuleId: 'soul' })
  const pruner = new Pruner(ctx, { thresholdChars: 800, headChars: 80, tailChars: 10 })
  const s = session('real-session', ['SHORT', marker + '😀'.repeat(1500), 'LONG'.repeat(600)])
  const result = pruner.pruneSession(s)
  assert.deepEqual(result.pruned.map(value => value.originalSeq), [2, 1])
  for (const item of result.pruned) {
    const replacement = s.events[item.replacementSeq]
    assert.deepEqual(replacement.sourceEventSeqs, [item.originalSeq])
    const text = replacement.data.message.content[0].text
    const reference = JSON.parse(/\[source: (.+)\]/.exec(text)[1])
    assert.equal(reference.sessionId, 'real-session')
    assert.deepEqual(reference.seqs, [item.originalSeq])
    assert.ok([...text].length <= 800)
    assert.ok(item.charsAfter < item.charsBefore)
  }
  assert.ok(s.events[result.pruned[1].replacementSeq].data.message.content[0].text.startsWith(marker))
  assert.deepEqual(s.events.slice(0, 3), s.original)
  assert.equal(s.events.some(event => event.type === 'compaction/end'), false)
  assert.equal(warnings.length, 0)
})

test('工具裁剪：缺身份或引用放不下时明确降级，取消及卸载不追加结果', () => {
  const warnings = [], abort = new AbortController()
  const ctx = { tokenMeter: { estimateMessage: () => 100 }, logger: { warn: text => warnings.push(text) } }
  let active = true
  const Pruner = createProvenancePruner(BasePruner, { sourceModuleId: 'soul', isActive: () => active })
  const pruner = new Pruner(ctx, { thresholdChars: 60, headChars: 5, tailChars: 5 })
  for (const id of ['sid', undefined]) {
    const s = session(id, ['x', 'x'.repeat(200), 'y'])
    const result = pruner.pruneSession(s)
    assert.equal(result.pruned.length, 1)
    assert.equal(s.events.at(-1).data.message.content[0].text.includes('[source:'), false)
  }
  assert.equal(warnings.length, 2)
  const s = session('cancel', ['x', 'x'.repeat(200), 'y'])
  abort.abort()
  assert.throws(() => pruner.pruneSession(s, abort.signal), /abort/i)
  assert.equal(s.events.length, 3)
  active = false
  assert.throws(() => pruner.pruneSession(s), /released/)
  assert.equal(s.events.length, 3)
})
