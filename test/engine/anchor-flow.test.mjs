import test from 'node:test'
import assert from 'node:assert/strict'
import { compileRules } from '../../engine/rule-spec.mjs'
import { mountRuleSources } from '../../engine/rule-runtime.mjs'

function harness(services = {}) {
  const listeners = new Map()
  const ctx = {
    get(name) { return services[name] }, logger: { warn() {}, info() {} },
    on(name, callback) {
      const list = listeners.get(name) ?? []; listeners.set(name, list); list.push(callback)
      return () => { const index = list.indexOf(callback); if (index >= 0) list.splice(index, 1) }
    },
    effect(callback) { return callback() },
  }
  return { ctx, listeners, async emit(name, ...args) {
    for (const callback of (listeners.get(name) ?? []).slice()) await callback(...args)
  }, run(agent, messages) {
    const list = [...listeners.get('agent/pre-step') ?? []]
    const invoke = index => index === list.length ? { kind: 'enter', messages }
      : list[index]({ agent, messages }, () => invoke(index + 1))
    return invoke(0)
  } }
}
const user = id => ({ id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'TASK' }] })
const action = (id, text, extra = {}) => ({ id, kind: 'inject-text', config: {
  layer: 'pre-step', strategy: 'static', mergeMode: 'separate', dedupe: 'session', text, ...extra,
} })
const texts = decision => decision.messages.flatMap(message => message.content.map(block => block.text))
function actor(id, depth = 0) {
  const state = { events: [], nodes: [], generation: 0, projections: new Map() }
  const session = { id, header: { delegationDepth: depth }, inheritedEventCount: 0,
    snapshotEvents: () => state.events,
    surface: { get nodes() { return state.nodes }, get replaceGeneration() { return state.generation },
      get contentGeneration() { return state.generation },
      deriveEventMessage(event) { return state.projections.get(event.seq) ?? (event.type === 'user/message' ? event.data : event.data.message) },
    },
  }
  return { state, session, options: { model: 'deepseek-chat' } }
}
async function admit(h, agent, type, data) {
  const event = { type, seq: agent.state.events.length, data }
  agent.state.events.push(event); agent.state.nodes.push(event.seq)
  await h.emit('session/event', agent.session, event)
  return event
}
const output = (text, type = 'reasoning', extra = {}) => ({ turn: 1, step: 1,
  message: { role: 'assistant', content: [{ type, text }], source: { kind: 'model' } }, ...extra,
})
function flow(anchor = {}) {
  return compileRules([{ id: 'flow', then: [
    action('seed', 'SEED'),
    { if: { anchor: { subject: 'assistantReasoning', keys: ['READY'], after: { action: 'seed' }, ...anchor } },
      then: [action('body', 'BODY')] },
  ] }])
}

test('确认注入主路径：只接受锚句实际投递后的推理，候选与旧输出不确认', async () => {
  const h = harness(), agent = actor('main')
  const dispose = mountRuleSources(h.ctx, [{ moduleId: 'module', rules: flow() }])
  await admit(h, agent, 'assistant/message', output('READY old'))
  const candidate = await h.run(agent, [user('u1')])
  assert.deepEqual(texts(candidate), ['TASK', 'SEED'])
  await admit(h, agent, 'assistant/message', output('READY before admission'))
  assert.deepEqual(texts(await h.run(agent, [user('u2')])), ['TASK', 'SEED'], '丢弃候选后不能以它开始观察')
  await admit(h, agent, 'user/message', candidate.messages[1])
  assert.deepEqual(texts(await h.run(agent, [user('u3')])), ['TASK'], '旧输出即使匹配也不能确认')
  await admit(h, agent, 'assistant/message', output('READY answer', 'text'))
  assert.deepEqual(texts(await h.run(agent, [user('u4')])), ['TASK'], '回答不能冒充推理')
  await admit(h, agent, 'assistant/message', output('READY current'))
  const confirmed = await h.run(agent, [user('u5')])
  assert.deepEqual(texts(confirmed), ['TASK', 'BODY'])
  await admit(h, agent, 'user/message', confirmed.messages[1])
  assert.deepEqual(texts(await h.run(agent, [user('u6')])), ['TASK'])
  dispose()
  assert.ok([...h.listeners.values()].every(list => list.length === 0))
  for (const [subject, type, data] of [
    ['userMessage', 'user/message', { ...user('direct-user'), content: [{ type: 'text', text: 'prefix READY suffix' }] }],
    ['assistantText', 'assistant/message', output('prefix READY suffix', 'text')],
    ['toolResult', 'tool/result', { message: { role: 'tool', source: { kind: 'tool', callId: 'call' }, content: [{ type: 'text', text: 'prefix READY suffix' }] } }],
  ]) {
    const direct = actor(subject)
    const release = mountRuleSources(h.ctx, [{ moduleId: 'direct', rules: compileRules([{ id: 'direct',
      if: { anchor: { subject, keys: ['READY'], mode: 'scan' } }, then: [action('direct-body', 'DIRECT')],
    }]) }])
    assert.deepEqual(texts(await h.run(direct, [user('before')])), ['TASK'])
    await admit(h, direct, type, data)
    assert.deepEqual(texts(await h.run(direct, [user('after')])), ['TASK', 'DIRECT'], `${subject} 可直接匹配，无需前置动作`)
    release()
  }
  const contexts = []
  const runtime = harness({ systemPrompt: { variable() { return () => {} }, context(entry) { contexts.push(entry); return () => {} } } })
  const runtimeAgent = actor('runtime')
  const releaseRuntime = mountRuleSources(runtime.ctx, [{ moduleId: 'runtime', rules: compileRules([{ id: 'flow', then: [
    { id: 'seed', kind: 'inject-text', config: { layer: 'runtime-context', strategy: 'static', text: 'CONTEXT SEED', params: { contextName: 'own-seed' } } },
    { if: { anchor: { subject: 'assistantReasoning', keys: ['READY'], after: { action: 'seed' } } }, then: [action('body', 'RUNTIME BODY')] },
  ] }]) }])
  assert.equal(contexts[0].name, 'own-seed', '命名贡献通过现有宿主注册接口发布')
  await admit(runtime, runtimeAgent, 'assistant/message', output('READY before snapshot'))
  assert.deepEqual(texts(await runtime.run(runtimeAgent, [user('r1')])), ['TASK'], '注册贡献不代表实际入账')
  await admit(runtime, runtimeAgent, 'user/message', { role: 'user', source: { kind: 'runtime-context', form: 'snapshot', sections: [{ name: 'other', text: 'CONTEXT SEED' }] }, content: [{ type: 'text', text: 'CONTEXT SEED' }] })
  assert.deepEqual(texts(await runtime.run(runtimeAgent, [user('r2')])), ['TASK'], '相同正文的其他贡献不能冒充目标')
  await admit(runtime, runtimeAgent, 'user/message', { role: 'user', source: { kind: 'runtime-context', form: 'snapshot', sections: [{ name: 'own-seed', text: 'CONTEXT SEED' }] }, content: [{ type: 'text', text: 'CONTEXT SEED' }] })
  assert.deepEqual(texts(await runtime.run(runtimeAgent, [user('r3')])), ['TASK'])
  await admit(runtime, runtimeAgent, 'assistant/message', output('READY after snapshot'))
  assert.deepEqual(texts(await runtime.run(runtimeAgent, [user('r4')])), ['TASK', 'RUNTIME BODY'])
  releaseRuntime()
  const merged = harness(), mergedAgent = actor('merged-body')
  const releaseMerged = mountRuleSources(merged.ctx, [{ moduleId: 'merged', rules: compileRules([{ id: 'flow', then: [
    action('seed', 'SEED'),
    { if: { anchor: { keys: ['READY'], after: { action: 'seed' } } }, then: [
      action('first', 'ONE', { mergeMode: 'merged' }), action('second', 'TWO', { mergeMode: 'merged' }),
    ] },
  ] }]) }])
  await admit(merged, mergedAgent, 'user/message', (await merged.run(mergedAgent, [user('m1')])).messages[1])
  await admit(merged, mergedAgent, 'assistant/message', output('READY'))
  const combined = await merged.run(mergedAgent, [user('m2')])
  assert.equal(combined.messages.length, 2)
  assert.deepEqual(texts(combined), ['TASK', 'ONE', 'TWO'])
  await admit(merged, mergedAgent, 'user/message', combined.messages[1])
  assert.deepEqual(texts(await merged.run(mergedAgent, [user('m3')])), ['TASK'], '关联正文合并后仍按既有合并身份去重')
  releaseMerged()
})

test('确认注入拒绝：动作引用必须存在、可追踪且没有自引用或依赖环', () => {
  const condition = target => ({ anchor: { subject: 'assistantReasoning', keys: ['READY'], after: { action: target } } })
  const branch = (target, id) => ({ if: condition(target), then: [action(id, id.toUpperCase())] })
  for (const then of [
    [branch('missing', 'body')],
    [branch('body', 'body')],
    [branch('b', 'a'), branch('a', 'b')],
    [{ id: 'seed', kind: 'inject-text', config: { layer: 'system-section', text: 'SEED' } }, branch('seed', 'body')],
    [action('seed', 'SEED', { mergeMode: 'merged' }), branch('seed', 'body')],
  ]) assert.throws(() => compileRules([{ id: 'invalid', then }]), /after|action|投递|引用|循环|追踪/i)
  assert.throws(() => compileRules([
    { id: 'one', then: [action('seed', 'SEED')] },
    { id: 'two', then: [branch('seed', 'body')] },
  ]), /after|action|引用/i, '另一规则的同名动作不能作为起点')
  for (const fallbackAfter of [0, -1, 1.5, NaN]) {
    assert.throws(() => flow({ fallbackAfter }), /fallbackAfter|正整数/)
  }
  assert.throws(() => flow({ mode: 'prefix', caseSensitive: true }), /prefix|scan/, '字面前缀不静默忽略不支持的匹配选项')
  const named = id => ({ id, then: [
    { id: 'seed', kind: 'inject-text', config: { layer: 'runtime-context', text: 'SEED', params: { contextName: 'shared-name' } } },
    branch('seed', 'body'),
  ] })
  assert.throws(() => compileRules([named('one'), named('two')]), /ambiguous|同名|identity|context/i, '跨规则的同名快照不能作为独立动作起点')
  const h = harness()
  assert.throws(() => mountRuleSources(h.ctx, [
    { moduleId: 'one', rules: compileRules([named('flow')]) },
    { moduleId: 'two', rules: compileRules([named('flow')]) },
  ]), /ambiguous|同名|identity|context/i, '跨模块同名关联在装配前拒绝')
  assert.equal(h.listeners.size, 0, '拒绝冲突不遗留观察器')
  let variables = 0
  const blocked = harness({ systemPrompt: { context() { throw new Error('duplicate context') }, variable() { variables++; return () => { variables-- } } } })
  assert.throws(() => mountRuleSources(blocked.ctx, [{ moduleId: 'blocked', rules: compileRules([named('flow')]) }]), /duplicate context/, '被关联的注册失败不能继续使用同名旧快照')
  assert.equal(variables, 0, '失败装配释放已注册变量')
})

test('确认注入边界：阈值、投影、压缩重挂与主子会话分别按可见事实判断', async () => {
  const h = harness(), main = actor('main-boundary'), child = actor('child-boundary', 1)
  let dispose = mountRuleSources(h.ctx, [{ moduleId: 'module', rules: flow({ fallbackAfter: 2 }) }])
  const seed = await h.run(main, [user('u1')])
  await admit(h, main, 'user/message', seed.messages[1])
  await admit(h, main, 'assistant/message', output('READY interrupted', 'reasoning', { interrupted: true }))
  assert.deepEqual(texts(await h.run(main, [user('u2')])), ['TASK'], '中断输出不确认且不占兜底次数')
  await admit(h, main, 'assistant/message', output('first miss'))
  assert.deepEqual(texts(await h.run(main, [user('u3')])), ['TASK'], 'N-1 次仍等待')
  await admit(h, main, 'assistant/message', output('second miss'))
  assert.deepEqual(texts(await h.run(main, [user('u4')])), ['TASK', 'BODY'], '第 N 次未命中即兜底')
  assert.deepEqual(texts(await h.run(child, [user('c1')])), ['TASK', 'SEED'], '主会话确认不能泄露到子会话')
  dispose()

  // 冷重挂仍从可见日志恢复；正文候选未被接纳，不能提前去重。
  dispose = mountRuleSources(h.ctx, [{ moduleId: 'module', rules: flow({ fallbackAfter: 2 }) }])
  assert.deepEqual(texts(await h.run(main, [user('u5')])), ['TASK', 'BODY'])
  const confirmed = await h.run(main, [user('u6')])
  await admit(h, main, 'user/message', confirmed.messages[1])
  assert.deepEqual(texts(await h.run(main, [user('u7')])), ['TASK'])
  main.state.nodes = []
  main.state.generation += 1
  assert.deepEqual(texts(await h.run(main, [user('u8')])), ['TASK', 'SEED'], '裁剪全部后重新投递锚句')
  const fresh = await h.run(main, [user('u9')])
  await admit(h, main, 'user/message', fresh.messages[1])
  const projected = await admit(h, main, 'assistant/message', output('READY raw'))
  main.state.projections.set(projected.seq, { ...projected.data.message, content: [{ type: 'reasoning', text: 'removed' }] })
  main.state.generation += 1
  assert.deepEqual(texts(await h.run(main, [user('u10')])), ['TASK'], '投影移除确认词后不扫描原始内容')
  main.state.projections.set(projected.seq, { ...projected.data.message, content: [{ type: 'reasoning', text: 'READY projected' }] })
  main.state.generation += 1
  assert.deepEqual(texts(await h.run(main, [user('u11')])), ['TASK', 'BODY'], '内容代次变化应重读投影')
  child.state.events = [...main.state.events]
  child.state.nodes = [...main.state.nodes]
  child.session.inheritedEventCount = child.state.events.length
  assert.deepEqual(texts(await h.run(child, [user('c2')])), ['TASK', 'SEED'], '继承的父会话锚句不代表子会话已投递')
  dispose()
  assert.deepEqual(texts(await h.run(main, [user('released')])), ['TASK'], '释放后没有残留注入')

  const continuation = harness(), continuingAgent = actor('continuation'), steered = []
  continuingAgent.steer = message => steered.push(message)
  const releaseContinue = mountRuleSources(continuation.ctx, [{ moduleId: 'continue', rules: compileRules([{ id: 'flow', then: [
    action('seed', 'SEED'),
    { if: { anchor: { subject: 'assistantReasoning', keys: ['READY'], after: { action: 'seed' } } },
      then: [{ id: 'body', kind: 'inject-text', config: { layer: 'turn-stop', strategy: 'static', text: 'CONTINUE BODY', dedupe: 'session' } }] },
  ] }]) }])
  const pending = await continuation.run(continuingAgent, [user('s1')])
  await admit(continuation, continuingAgent, 'user/message', pending.messages[1])
  await admit(continuation, continuingAgent, 'assistant/message', output('READY'))
  const cancelled = new AbortController(); cancelled.abort()
  await continuation.emit('agent/turn-stopping', { agent: continuingAgent, turn: 1, signal: cancelled.signal })
  assert.equal(steered.length, 0, '取消后不得续跑')
  const signal = new AbortController().signal
  await continuation.emit('agent/turn-stopping', { agent: continuingAgent, turn: 1, signal })
  await continuation.emit('agent/turn-stopping', { agent: continuingAgent, turn: 1, signal })
  assert.deepEqual(steered.map(message => message.content[0].text), ['CONTINUE BODY'], '重复终止检查只排队一次')
  await admit(continuation, continuingAgent, 'user/message', steered[0])
  await continuation.emit('agent/turn-stopping', { agent: continuingAgent, turn: 2, signal })
  assert.equal(steered.length, 1, '正文已接纳后后续轮次不能重复续跑')
  releaseContinue()
  await continuation.emit('agent/turn-stopping', { agent: continuingAgent, turn: 3, signal })
  assert.equal(steered.length, 1, '释放后不得续跑')
})
