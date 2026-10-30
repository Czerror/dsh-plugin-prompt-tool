import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import { apply, recoveryObservationOf } from '../../engine/generation-recovery.mjs'

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

test('generation-recovery：行覆盖和跨调用相似材料，正常引用代码与进展不截断', async t => {
  const stream = text => [{ type: 'block-start', index: 0, blockType: 'reasoning' }, { type: 'reasoning-delta', index: 0, text }, { type: 'block-end', index: 0, block: { type: 'reasoning', text } }, finish]
  const ctx = new Context()
  t.after(apply(ctx, { enabled: true, textRepeatChars: 100000, reasoningRepeatChars: 100000, lineRepeatChars: 200, crossCallRepeatChars: 200 }, { agent }))
  const line = '重复检查已经完成的相同材料但没有任何进展。'
  const looping = Array.from({ length: 20 }, (_, i) => line + ' '.repeat(i % 3) + '\n').join('')
  assert.ok((await collect(ctx, stream(looping))).blocks[0].text.length < looping.length)
  const material = Array.from({ length: 12 }, (_, i) => `材料${i}：这些不同的事实需要重新核对，但当前没有新增结果。`).join('\n') + '\n'
  assert.deepEqual((await collect(ctx, stream(material))).out, stream(material))
  assert.deepEqual((await collect(ctx, stream(material))).out, stream(material))
  const similar = material.replace('材料11：', '更新11：')
  assert.ok((await collect(ctx, stream(similar))).blocks[0].text.length < similar.length)
  for (const normal of [Array.from({ length: 30 }, () => '> ' + line).join('\n'), '```js\n' + Array.from({ length: 30 }, () => 'console.log("same");').join('\n') + '\n```', Array.from({ length: 30 }, (_, i) => `步骤${i}已完成，得到了此前没有的新结果与测量${i * 17}。`).join('\n')]) {
    assert.deepEqual((await collect(ctx, stream(normal))).out, stream(normal))
  }
  const fresh = new Context()
  t.after(apply(fresh, { enabled: true, textRepeatChars: 100000, reasoningRepeatChars: 100000, crossCallRepeatChars: 200 }, { agent: { session: { id: 'main', header: {} } } }))
  assert.deepEqual((await collect(fresh, stream(material))).out, stream(material), '其他Agent对象不继承跨调用特征')
  const cancelled = new AbortController()
  cancelled.abort()
  await collect(fresh, stream(material))
  await collect(fresh, stream(material), { signal: cancelled.signal })
  assert.deepEqual((await collect(fresh, stream(material))).out, stream(material), '取消清除跨调用观察状态')
})

test('generation-recovery：512周期窗覆盖409字符周期', async t => {
  const ctx = new Context()
  t.after(apply(ctx, { enabled: true, maxCycleChars: 512 }, { agent }))
  const cycle = Array.from({ length: 409 }, (_, i) => String.fromCodePoint(0x4e00 + i)).join('')
  const text = cycle.repeat(24) + 'TAIL'
  const chunks = [{ type: 'block-start', index: 0, blockType: 'reasoning' }, { type: 'reasoning-delta', index: 0, text }, { type: 'block-end', index: 0, block: { type: 'reasoning', text } }, finish]
  assert.ok((await collect(ctx, chunks)).blocks[0].text.length < text.length)
})

test('generation-recovery：运行观测只在真实候选产生并随卸载撤回', async () => {
  const ctx = new Context()
  const observedAgent = { session: { id: 'main', header: {}, snapshotEvents: () => [] } }
  const off = apply(ctx, { enabled: true, recoverEmpty: true }, { agent: observedAgent })
  assert.equal(recoveryObservationOf(observedAgent), undefined)
  await ctx.waterfall('agent/request', { agent: observedAgent, turn: 1, step: 1, signal: new AbortController().signal }, async () => ({}))
  ctx.emit('session/event', observedAgent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  assert.equal(recoveryObservationOf(observedAgent).state, 'candidate')
  assert.deepEqual(Object.keys(recoveryObservationOf(observedAgent)).sort(), ['observedAt', 'state'])
  off()
  assert.equal(recoveryObservationOf(observedAgent), undefined)
})

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
