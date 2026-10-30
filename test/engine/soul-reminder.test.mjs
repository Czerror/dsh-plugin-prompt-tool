import test from 'node:test'
import assert from 'node:assert/strict'
import { createSoulReminder } from '../../src/runtime/soul-reminder.ts'
import { compileWhen } from '../../engine/conditions/index.mjs'
import { UNAVAILABLE } from '../../engine/conditions/availability.mjs'
import { compileRules } from '../../engine/rule-spec.mjs'
import { mountRuleSources } from '../../engine/rule-runtime.mjs'
import { SOUL_SELF_SERVICE } from '../../engine/service-names.mjs'

test('Soul提醒只以最后确认投递和成功压缩去重，候选和重挂不消费', () => {
  const events = [], session = { id: 'session', header: {}, snapshotEvents: () => events }, agent = { session }
  let pendingVersion = 'A', count = 1
  const read = () => ({ pendingVersion, open: count, pendingReview: 0 })
  let reminder = createSoulReminder(read)
  const current = () => reminder.read('soul', agent)
  const deliver = () => events.push({ seq: events.length, type: 'user/message', data: { message: { source: { kind: 'plugin:soul-reminder', moduleId: 'soul', sessionId: session.id, soulReminder: current() } } } })
  assert.equal(current().due, true)
  assert.equal(current().due, true, '重复候选不能消费')
  deliver()
  assert.equal(current().due, false)
  pendingVersion = 'B'
  assert.equal(current().due, true)
  pendingVersion = 'A'
  assert.equal(current().due, false, '未投递B不覆盖确认A')
  pendingVersion = 'B'; deliver()
  pendingVersion = 'A'
  assert.equal(current().due, true, '已投递A→B→A是新变化')
  deliver()
  reminder = createSoulReminder(read)
  assert.equal(current().due, false, '重挂从持久事件恢复')
  events.push({ seq: events.length, type: 'compaction/end', data: { error: 'failed' } })
  assert.equal(current().due, false)
  events.push({ seq: events.length, type: 'compaction/end', data: {} })
  assert.equal(current().due, true)
  deliver()
  assert.equal(current().due, false)
  count = 0
  assert.equal(current().due, false)
  assert.equal(reminder.read('soul', { session: { ...session, header: { delegationDepth: 1 } } }).due, false)
})

test('Soul条件缺来源保持UNAVAILABLE，not不可反转，撤权不当零未结', () => {
  assert.equal(compileWhen({ not: { soul: { pending: true } } })({}), UNAVAILABLE)
  const reminder = createSoulReminder(() => { throw new Error('REVOKED') })
  assert.equal(reminder.read('soul', { session: { id: 'session' } }), undefined)
  assert.throws(() => compileRules([{ id: 'unsupported', if: { soul: { pending: true } }, then: [{ id: 'inject', kind: 'inject-text', config: { layer: 'system-section', text: 'X' } }] }]), /only pre-step or runtime-context/)
})

test('runtime-context只在官方持久snapshot确认提醒，候选和取消装配不消费', async () => {
  const events = [], listeners = new Map(), contexts = []
  const agent = { session: { id: 'runtime', header: {}, snapshotEvents: () => events } }
  const soulReminder = createSoulReminder(() => ({ pendingVersion: 'CURRENT', open: 1, pendingReview: 0 }))
  const systemPrompt = { variable: () => () => {}, context: config => { contexts.push(config); return () => {} } }
  const ctx = { get: name => name === 'systemPrompt' ? systemPrompt : undefined, on: (name, handler) => {
    const list = listeners.get(name) ?? []; list.push(handler); listeners.set(name, list); return () => list.splice(list.indexOf(handler), 1)
  } }
  const rules = compileRules([{ id: 'remind', if: { soul: { pending: true } }, then: [{ id: 'inject', kind: 'inject-text', config: { layer: 'runtime-context', text: 'OPEN ITEMS' } }] }], { moduleId: 'soul' })
  const off = mountRuleSources(ctx, [{ moduleId: 'soul', rules }], { soulReminder })
  const assemble = async signal => {
    const assembly = { sections: [], contexts: contexts.map(entry => ({ name: entry.name, text: '' })) }
    const context = { agent, signal }
    const invoke = i => i === listeners.get('system-prompt/assemble').length ? assembly : listeners.get('system-prompt/assemble')[i](assembly, context, () => invoke(i + 1))
    await invoke(0); return assembly.contexts
  }
  const candidate = await assemble()
  assert.match(candidate[0].text, /OPEN ITEMS/)
  assert.match(candidate[0].text, /soul-reminder:/)
  assert.match((await assemble())[0].text, /OPEN ITEMS/)
  assert.equal((await assemble(AbortSignal.abort()))[0].text, '')
  events.push({ seq: 0, type: 'user/message', data: { message: { source: { kind: 'runtime-context', form: 'snapshot', sections: candidate } } } })
  assert.equal((await assemble())[0].text, '')
  off()
})

test('真实规则投递携带候选集合版本，门控剥离后不消费，重新挂载不重发', async () => {
  const events = [], listeners = new Map()
  const agent = { session: { id: 'flow', header: {}, snapshotEvents: () => events } }
  let pendingVersion = 'A'
  const soulReminder = createSoulReminder(() => ({ pendingVersion, open: 1, pendingReview: 0 }))
  const ctx = { get: () => undefined, on: (name, handler) => {
    const list = listeners.get(name) ?? []; list.push(handler); listeners.set(name, list)
    return () => list.splice(list.indexOf(handler), 1)
  } }
  const rules = compileRules([{ id: 'soul-ledger-open', if: { soul: { pending: true } }, then: [{ id: 'remind', kind: 'inject-text', config: { layer: 'pre-step', position: 'before-all', text: 'CLOSE ITEMS', dedupe: 'batch' } }] }], { moduleId: 'soul' })
  const mount = () => mountRuleSources(ctx, [{ moduleId: 'soul', rules }], { soulReminder })
  let off = mount()
  const run = () => listeners.get('agent/pre-step')[0]({ agent }, () => ({ kind: 'allow', messages: [] }))
  let candidate = await run()
  assert.equal(candidate.messages.length, 1)
  assert.equal(candidate.messages[0].source.soulReminder.pendingVersion, 'A')
  assert.equal((await run()).messages.length, 1)
  events.push({ seq: 0, type: 'user/message', data: { message: candidate.messages[0] } })
  assert.equal((await run()).messages.length, 0)
  off(); off = mount()
  assert.equal((await run()).messages.length, 0)
  pendingVersion = 'B'
  candidate = await run()
  assert.equal(candidate.messages.length, 1)
  assert.equal(candidate.messages[0].source.soulReminder.pendingVersion, 'B')
  off()
})

test('Soul组合条件保留else、any其他真分支和不相关动作的原有投递语义', async () => {
  for (const layer of ['pre-step', 'runtime-context']) {
    const listeners = new Map(), contexts = [], agent = { session: { id: 'branches', header: {}, snapshotEvents: () => [] } }
    const systemPrompt = { variable: () => () => {}, context: config => { contexts.push(config); return () => {} } }
    const ctx = { get: name => name === 'systemPrompt' ? systemPrompt : undefined, on: (name, handler) => {
      const list = listeners.get(name) ?? []; list.push(handler); listeners.set(name, list); return () => list.splice(list.indexOf(handler), 1)
    } }
    const inject = (id, text) => ({ id, kind: 'inject-text', config: { layer, ...(layer === 'pre-step' ? { position: 'before-all' } : {}), text, mergeMode: 'separate' } })
    const rules = compileRules([
      { id: 'branch', if: { soul: { pending: true } }, then: [inject('yes', 'YES')], else: [inject('else', 'ELSE')] },
      { id: 'either', if: { any: [{ soul: { pending: true } }, { scope: { audience: 'main' } }] }, then: [inject('either', 'EITHER')] },
      { id: 'nested', then: [inject('plain', 'PLAIN'), { if: { soul: { pending: true } }, then: [inject('nested', 'NESTED')] }] },
    ], { moduleId: 'soul' })
    const off = mountRuleSources(ctx, [{ moduleId: 'soul', rules }], { soulReminder: { read: () => ({ count: 0, pendingVersion: 'ZERO', epoch: -1, due: false }) } })
    let messages
    if (layer === 'pre-step') messages = (await listeners.get('agent/pre-step')[0]({ agent }, () => ({ kind: 'allow', messages: [] }))).messages
    else {
      const assembly = { sections: [], contexts: contexts.map(entry => ({ name: entry.name, text: '' })) }
      const invoke = i => i === listeners.get('system-prompt/assemble').length ? assembly : listeners.get('system-prompt/assemble')[i](assembly, { agent }, () => invoke(i + 1))
      await invoke(0); messages = assembly.contexts.map(section => ({ content: [{ text: section.text }], source: {} }))
    }
    const text = messages.flatMap(message => message.content.map(block => block.text)).join(' ')
    assert.match(text, /ELSE/, layer)
    assert.match(text, /EITHER/, layer)
    assert.match(text, /PLAIN/, layer)
    assert.doesNotMatch(text, /YES|NESTED|soul-reminder:/, layer)
    assert.ok(messages.every(message => message.source.soulReminder === undefined))
    off()
  }
})

test('Soul候选await后必须保持同一正向路径、集合版本和epoch', async () => {
  for (const layer of ['pre-step', 'runtime-context']) {
    for (const change of ['path', 'version', 'epoch']) {
      const listeners = new Map(), contexts = [], agent = { session: { id: 'await', header: {}, snapshotEvents: () => [] } }
      let fact = { count: 1, pendingVersion: 'A', epoch: -1, due: true }, release, entered
      const ready = new Promise(resolve => { entered = resolve })
      const systemPrompt = { variable: () => () => {}, context: config => { contexts.push(config); return () => {} } }
      const service = { render: () => { entered(); return new Promise(resolve => { release = resolve }) } }
      const ctx = { get: name => name === SOUL_SELF_SERVICE ? service : name === 'systemPrompt' ? systemPrompt : undefined, on: (name, handler) => {
        const list = listeners.get(name) ?? []; list.push(handler); listeners.set(name, list); return () => list.splice(list.indexOf(handler), 1)
      } }
      const config = { layer, strategy: 'placeholder', fill: 'soul-self', ...(layer === 'pre-step' ? { position: 'before-all' } : {}) }
      const rules = compileRules([{ id: 'await', if: { any: [{ soul: { pending: true } }, { scope: { audience: 'main' } }] }, then: [{ id: 'inject', kind: 'inject-text', config }] }], { moduleId: 'soul' })
      const off = mountRuleSources(ctx, [{ moduleId: 'soul', rules }], { soulReminder: { read: () => fact } })
      let assembly
      const waiting = layer === 'pre-step' ? listeners.get('agent/pre-step')[0]({ agent }, () => ({ kind: 'allow', messages: [] })) : (() => {
        assembly = { sections: [], contexts: contexts.map(entry => ({ name: entry.name, text: '' })) }
        const invoke = i => i === listeners.get('system-prompt/assemble').length ? assembly : listeners.get('system-prompt/assemble')[i](assembly, { agent }, () => invoke(i + 1))
        return invoke(0)
      })()
      await ready
      fact = { ...fact, ...(change === 'path' ? { due: false } : change === 'version' ? { pendingVersion: 'B' } : { epoch: 10 }) }
      release('OLD CANDIDATE')
      const result = await waiting
      if (layer === 'pre-step') assert.equal(result.messages.length, 0, change)
      else assert.equal(assembly.contexts[0].text, '', change)
      off()
    }
  }
})
