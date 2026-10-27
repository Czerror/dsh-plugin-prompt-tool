import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import { apply } from '../../engine/generation-recovery.mjs'

const config = { enabled: true, textRepeatChars: 12, reasoningRepeatChars: 12, maxCycleChars: 3 }
const agent = { session: { id: 'main', header: { delegationDepth: 0 } } }
const finish = { type: 'finish', reason: { kind: 'stop' } }

async function* source(chunks) { yield* chunks }

async function collect(ctx, chunks, options = {}) {
  const out = []
  for await (const chunk of ctx.waterfall('llm/stream', { sessionId: 'main', ...options }, () => source(chunks))) out.push(chunk)
  const assembler = new BlockAssembler()
  for (const chunk of out) assembler.push(chunk)
  assert.equal(out.filter(chunk => chunk.type === 'finish').length, 1)
  assert.equal(out.at(-1).type, 'finish')
  const open = new Set()
  for (const chunk of out) {
    if (chunk.type === 'block-start') open.add(chunk.index)
    if (chunk.type === 'block-end') open.delete(chunk.index)
  }
  assert.equal(open.size, 0, '成功流必须闭合所有内容块')
  return { out, blocks: assembler.blocks(), reason: assembler.finish }
}

test('generation-recovery：正文和推理在声明阈值截断，大delta的尾文不进入最终块', async t => {
  const ctx = new Context()
  t.after(apply(ctx, config, { agent }))
  for (const kind of ['text', 'reasoning']) {
    const chunks = [
      { type: 'block-start', index: 0, blockType: kind },
      { type: `${kind}-delta`, index: 0, text: 'abcabcabcabcTAIL' },
      { type: 'block-end', index: 0, block: { type: kind, text: 'abcabcabcabcTAIL' } },
      finish,
    ]
    const result = await collect(ctx, chunks)
    assert.deepEqual(result.blocks, [{ type: kind, text: 'abcabcabcabc' }])
    assert.deepEqual(result.reason, { kind: 'stop' })
    assert.deepEqual(result.out.map(chunk => chunk.type), ['block-start', `${kind}-delta`, 'block-end', 'finish'])
  }
})

test('generation-recovery：正常流完整透传，开放或已闭合工具调用不被截成成功', async t => {
  const ctx = new Context()
  t.after(apply(ctx, config, { agent }))
  const normal = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'abcdefghijklmno' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'abcdefghijklmno' } }, finish,
  ]
  assert.deepEqual((await collect(ctx, normal)).out, normal)
  for (const closed of [false, true]) {
    const tool = { type: 'tool-call', id: 'call-1', name: 'read_file', arguments: '{"path":"ok"}' }
    const chunks = [
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 0, id: 'call-1', name: 'read_file', argumentsDelta: '{"path":' },
      ...(closed ? [{ type: 'block-end', index: 0, block: tool }] : []),
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'text-delta', index: 1, text: 'abcabcabcabcTAIL' },
      { type: 'block-end', index: 1, block: { type: 'text', text: 'abcabcabcabcTAIL' } },
      ...(!closed ? [{ type: 'tool-call-delta', index: 0, id: 'call-1', argumentsDelta: '"ok"}' }, { type: 'block-end', index: 0, block: tool }] : []),
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ]
    const result = await collect(ctx, chunks)
    assert.deepEqual(result.out, chunks, '保留完整参数、合法工具和原始finish')
    assert.deepEqual(result.blocks, [tool, { type: 'text', text: 'abcabcabcabcTAIL' }])
  }
})

test('generation-recovery：分块、受众、取消及卸载保持Agent隔离且重复装配只收尾一次', async t => {
  const repetitive = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'abcabcabcabcTAIL' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'abcabcabcabcTAIL' } }, finish,
  ]
  for (const options of [{ sessionId: 'other' }, { sessionId: undefined }, { purpose: 'compaction' }, { purpose: 'session-title' }]) {
    const ctx = new Context()
    t.after(apply(ctx, config, { agent }))
    assert.deepEqual((await collect(ctx, repetitive, options)).out, repetitive)
  }
  for (const delegationDepth of [0, 1]) {
    const ctx = new Context()
    const scopedAgent = { session: { id: 'main', header: { delegationDepth } } }
    const off = apply(ctx, { ...config, audience: delegationDepth === 0 ? 'subagent' : 'main' }, { agent: scopedAgent })
    if (off !== undefined) t.after(off)
    assert.deepEqual((await collect(ctx, repetitive)).out, repetitive)
  }
  for (const action of ['cancel', 'unload']) {
    const ctx = new Context()
    const abort = new AbortController()
    t.after(apply(ctx, config, { agent }))
    const input = async function* () {
      yield repetitive[0]
      if (action === 'cancel') abort.abort()
      else await ctx.fiber.dispose()
      yield* repetitive.slice(1)
    }
    const stream = ctx.waterfall('llm/stream', { sessionId: 'main', signal: abort.signal }, input)
    assert.deepEqual(await Array.fromAsync(stream), repetitive, `${action}后不再执行本项目截断`)
  }
  const ctx = new Context()
  t.after(apply(ctx, config, { agent }))
  t.after(apply(ctx, config, { agent }))
  const split = [repetitive[0], ...[...'abcabcabcabcTAIL'].map(text => ({ type: 'text-delta', index: 0, text })), ...repetitive.slice(2)]
  for (const chunks of [repetitive, split, split.slice(1)]) {
    assert.deepEqual((await collect(ctx, chunks)).blocks, [{ type: 'text', text: 'abcabcabcabc' }])
  }
  for (const action of ['cancel', 'unload']) for (const boundary of ['text-delta', 'block-end']) {
    const interrupted = new Context()
    const abort = new AbortController()
    t.after(apply(interrupted, config, { agent }))
    const terminal = action === 'cancel' ? { type: 'finish', reason: { kind: 'aborted', failure: { message: 'cancelled' } } } : finish
    const upstream = [...repetitive.slice(0, -1), terminal]
    const out = []
    for await (const chunk of interrupted.waterfall('llm/stream', { sessionId: 'main', signal: abort.signal }, () => source(upstream))) {
      out.push(chunk)
      if (chunk.type === boundary) {
        if (action === 'cancel') abort.abort()
        else await interrupted.fiber.dispose()
      }
    }
    assert.deepEqual(out.at(-1), terminal, '消费者暂停期间取消／卸载不得覆盖原始finish')
    assert.equal(out.filter(chunk => chunk.type === 'finish').length, 1)
    assert.equal(out.filter(chunk => chunk.type === 'block-end').length, 1, '已合成闭合的块不得再次关闭')
    const assembly = new BlockAssembler()
    for (const chunk of out) assembly.push(chunk)
    assert.deepEqual(assembly.blocks(), [{ type: 'text', text: boundary === 'text-delta' ? 'abcabcabcabcTAIL' : 'abcabcabcabc' }])
  }
  const independent = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'abcabc' },
    { type: 'block-start', index: 1, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 1, text: 'abcabc' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'abcabc' } },
    { type: 'block-end', index: 1, block: { type: 'reasoning', text: 'abcabc' } }, finish,
  ]
  assert.deepEqual((await collect(ctx, independent)).out, independent, '正文和推理不能相加凑阈值')
  const closed = [independent[0], independent[1], independent[4], repetitive[1], finish]
  assert.deepEqual((await collect(ctx, closed)).out, closed, '已经关闭的块不重新进入检测')
})
