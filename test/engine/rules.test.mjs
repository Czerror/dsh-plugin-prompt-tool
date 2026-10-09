import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { compileRules, getRuleEditorMeta } from '../../engine/rule-spec.mjs'
import { mountRuleSources } from '../../engine/rule-runtime.mjs'
import { ruleFrame, ruleMatches, actionMatches } from '../../engine/conditions/evaluation.mjs'

function harness(services = {}) {
  const events = new Map()
  const effects = []
  const warnings = []
  const ctx = {
    get: name => services[name],
    logger: { warn(message) { warnings.push(message) } },
    on(name, handler, options) {
      const list = events.get(name) ?? []; events.set(name, list)
      if (options?.prepend) list.unshift(handler); else list.push(handler)
      return () => { const at = list.indexOf(handler); if (at >= 0) list.splice(at, 1) }
    },
    effect(callback) { const dispose = callback(); if (typeof dispose === 'function') effects.push(dispose); return dispose },
  }
  return { ctx, events, effects, warnings, async emit(name, ...args) {
    for (const handler of (events.get(name) ?? []).slice()) await handler(...args)
  }, run(name, args, terminal) {
    const list = (events.get(name) ?? []).slice()
    const invoke = i => i === list.length ? terminal() : list[i](...args, () => invoke(i + 1))
    return invoke(0)
  } }
}
const actor = () => ({ session: { id: 'session', header: {}, snapshotEvents: () => [] }, options: { model: 'deepseek-chat' } })
const textAction = (id, text, extra = {}) => ({ id, kind: 'inject-text', config: { id, layer: 'pre-step', text, ...extra } })

test('统一规则：同执行点共享一次条件，动作按 do 顺序，跨执行点不复用结果', async () => {
  const rules = compileRules([{ id: 'multi', if: { phase: { promoted: false } }, then: [
    { id: 'first', kind: 'request-params', patch: { maxTokens: 10 } },
    { id: 'second', kind: 'request-params', patch: { maxTokens: 20 } },
    { id: 'pre', kind: 'decision', phase: 'pre', decision: 'deny', reason: 'blocked' },
  ] }])
  let reads = 0
  rules[0].when = () => { reads++; return true }
  const h = harness()
  const dispose = mountRuleSources(h.ctx, [{ moduleId: 'module', rules }])
  let nextCalls = 0
  const request = () => h.run('agent/request', [{ agent: actor() }], () => { nextCalls++; return { maxTokens: 5 } })
  assert.equal((await request()).maxTokens, 20)
  assert.equal(reads, 1); assert.equal(nextCalls, 1)
  assert.deepEqual(await h.run('tools/pre-execute', [{ agent: actor(), name: 'bash' }], () => ({ kind: 'allow' })), { kind: 'deny', reason: 'blocked' })
  assert.equal(reads, 2)
  await request(); assert.equal(reads, 3)
  dispose()
  assert.ok([...h.events.values()].every(list => list.length === 0))
})

test('统一规则：通用条件只允许规则 when，中性旧字段不再参与动作判定', async () => {
  assert.throws(() => compileRules([{ id: 'disabled-action', then: [textAction('text', 'BODY', { enabled: false })] }]), /rule.enabled/, '内层停用不得被运行时静默重启')
  const when = { scope: { audience: 'subagent' } }
  for (const [key, value] of [['audience', 'main'], ['audience', 'subagent'], ['modelScope', 'pro'], ['modelScope', 'flash'], ['promotion', 'main'], ['promotion', 'include-subagents'], ['subject', 'userMessage'], ['match', { keys: ['USER'] }], ['match', {}]]) {
    for (const enabled of [true, false]) assert.throws(() => compileRules([{ id: 'legacy-inject', enabled, if: when, then: [textAction('text', 'BODY', { [key]: value })] }]), /rule\.if/)
  }
  for (const [key, value] of [['audience', 'main'], ['audience', 'subagent'], ['modelScope', 'pro'], ['modelScope', 'flash']]) {
    assert.throws(() => compileRules([{ id: 'legacy-request', if: when, then: [{ id: 'request', kind: 'request-params', patch: { maxTokens: 64 }, [key]: value }] }]), /rule\.if/)
  }
  const source = [{ id: 'canonical', if: when, then: [
    textAction('text', 'BODY', { audience: null, modelScope: 'all', promotion: 'none', subject: '', match: null }),
    { id: 'budget', kind: 'request-params', audience: '', modelScope: 'all', patch: { maxTokens: 64 } },
    { id: 'sampling', kind: 'request-params', patch: { temperature: 0.5 } },
  ] }]
  const original = structuredClone(source)
  const rules = compileRules(source)
  assert.deepEqual(source, original, '只规范编译副本，不隐式重写源定义')
  for (const field of ['audience', 'modelScope', 'promotion', 'subject', 'match']) assert.equal(Object.hasOwn(rules[0].actions[0].config, field), false)
  for (const field of ['audience', 'modelScope']) assert.equal(Object.hasOwn(rules[0].actions[1], field), false)
  const predicate = rules[0].when
  let reads = 0
  rules[0].when = subject => { reads++; return predicate(subject) }
  const h = harness()
  const dispose = mountRuleSources(h.ctx, [{ moduleId: 'module', rules }])
  const main = actor(), child = actor()
  child.session = { ...child.session, id: 'child-gate', header: { delegationDepth: 1 } }
  const messages = [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'USER' }] }]
  const inject = agent => h.run('agent/pre-step', [{ agent, messages }], () => ({ kind: 'enter', messages }))
  assert.equal((await inject(main)).messages.length, 1)
  assert.equal((await inject(child)).messages[1].content[0].text, 'BODY')
  for (const model of ['deepseek-pro', 'deepseek-flash']) {
    child.options.model = model
    assert.deepEqual(await h.run('agent/request', [{ agent: child }], () => ({})), { maxTokens: 64, temperature: 0.5 })
  }
  assert.deepEqual(await h.run('agent/request', [{ agent: main }], () => ({})), {})
  assert.equal(reads, 5, '同执行点的两个请求动作只读取一次顶层条件')
  dispose()
  for (const flag of ['complete', 'suppressRuntimeContext']) {
    const action = { id: 'fixed', kind: 'inject-text', config: { layer: 'system-section', audience: 'main', text: 'FIXED', params: { [flag]: true } } }
    assert.equal(compileRules([{ id: 'fixed', then: [action] }])[0].actions[0].config.audience, 'main')
    assert.throws(() => compileRules([{ id: 'fixed', if: when, then: [action] }]), /registration/)
    assert.throws(() => compileRules([{ id: 'spoofed', then: [{ ...action, config: { ...action.config, layer: 'pre-step' } }] }]), /rule\.if/)
  }
  for (const { example } of getRuleEditorMeta().actions) {
    const target = example.kind === 'inject-text' ? example.config : example.kind === 'request-params' ? example : undefined
    if (target !== undefined) for (const field of ['audience', 'modelScope', 'promotion', 'subject', 'match']) assert.equal(Object.hasOwn(target, field), false)
  }
})

test('统一规则：条件注入复用批处理，未命中不占去重，多个动作合并且只判定一次', async () => {
  const rules = compileRules([{ id: 'notices', then: [textAction('a', 'A', { mergeMode: 'merged', dedupe: 'batch' }), textAction('b', 'B', { mergeMode: 'merged', dedupe: 'batch' })] }])
  let hit = false; let reads = 0
  rules[0].when = () => { reads++; return hit }
  const h = harness()
  const dispose = mountRuleSources(h.ctx, [{ moduleId: 'module', rules }])
  const agent = actor()
  const run = messages => h.run('agent/pre-step', [{ agent, messages }], () => ({ kind: 'enter', messages, startsRequestSeries: true }))
  const original = [{ id: 'u', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'USER' }] }]
  assert.equal((await run(original)).messages.length, 1)
  hit = true
  const included = await run(original)
  assert.equal(included.messages.length, 2, JSON.stringify({ warnings: h.warnings, reads, events: [...h.events.keys()] }))
  assert.deepEqual(included.messages[1].content.map(item => item.text), ['A', 'B'])
  assert.equal(included.startsRequestSeries, true)
  assert.equal(reads, 2)
  assert.equal((await run(included.messages)).messages.length, 2)
  dispose()
})

test('统一规则：编译拒绝多启用互斥组、重复身份与动态 registration 效果', () => {
  const a = { id: 'a', group: 'mode', exclusive: true, then: [textAction('one', 'A')] }
  const b = { id: 'b', group: 'mode', then: [textAction('two', 'B')] }
  assert.throws(() => compileRules([a, b]), /exclusive|互斥/)
  assert.equal(compileRules([a, { ...b, enabled: false }]).length, 2)
  assert.throws(() => compileRules([a, a]), /duplicate/)
  for (const id of ['.', '..', '../outside', 'bad:name', 'bad?name', 'bad' + String.fromCharCode(1)]) {
    for (const enabled of [true, false]) assert.throws(() => compileRules([{ id, enabled, then: [{ id: 'action/path:encoded', kind: 'request-params', patch: {} }] }]), /rule id/)
  }
  assert.doesNotThrow(() => compileRules([{ id: '合法.rule-id', then: [{ id: 'action/path:encoded', kind: 'request-params', patch: {} }] }]))
  assert.throws(() => compileRules([{ id: 'duplicate-actions', then: [textAction('x', 'A'), textAction('x', 'B')] }]), /duplicate/)
  assert.throws(() => compileRules([{ id: 'invalid-budget', then: [{ ...textAction('x', 'A'), maxPerTurn: 1 }] }]), /maxPerTurn/)
  assert.throws(() => compileRules([{ id: 'conflicting-order', then: [
    { id: 'first', kind: 'request-params', patch: { maxTokens: 10 }, channelOrder: 20 },
    { id: 'second', kind: 'request-params', patch: { maxTokens: 20 }, channelOrder: 10 },
  ] }]), /channelOrder.*first.*second/)
  for (const action of [
    { id: 'guard', kind: 'guard', mask: { deny: ['bash'] } },
    { id: 'complete', kind: 'inject-text', config: { id: 'complete', layer: 'system-section', text: 'ALL', params: { complete: true } } },
    { id: 'suppress', kind: 'inject-text', config: { id: 'suppress', layer: 'system-section', text: 'ALL', params: { suppressRuntimeContext: true } } },
  ]) assert.throws(() => compileRules([{ id: 'fixed', if: { phase: { promoted: false } }, then: [action] }]), /registration|when/)
  const meta = getRuleEditorMeta()
  assert.equal(meta.actions.find(action => action.kind === 'inject-text').supportsWhen, true)
  const example = meta.actions.find(action => action.kind === 'inject-text').example
  const derived = compileRules([{ id: 'two-texts', then: [{ ...example, id: 'first' }, { ...example, id: 'second' }] }])[0]
  assert.deepEqual(derived.actions.map(action => action.compiledConfig.id), ['rule:two-texts:first', 'rule:two-texts:second'])
  for (const action of meta.actions) assert.doesNotThrow(() => compileRules([{ id: action.kind, then: [{ ...action.example, id: 'action' }] }]))
})

test('统一规则：真实 SystemPrompt 的条件段共享判定，主子受众隔离且卸载移除注册', async () => {
  const root = new Context()
  await root.plugin(SystemPrompt)
  const main = actor()
  const child = { ...actor(), session: { ...actor().session, id: 'child', header: { delegationDepth: 1 } } }
  createScope(root, main)
  createScope(root, child, { parent: main })
  const rules = compileRules([{ id: 'assembly-text', if: { scope: { audience: 'main' } }, then: [
    { id: 'section', kind: 'inject-text', config: { layer: 'system-section', text: 'SYSTEM', order: 10 } },
    { id: 'context', kind: 'inject-text', config: { layer: 'runtime-context', text: 'RUNTIME', order: 20 } },
  ] }])
  const predicate = rules[0].when
  let reads = 0
  rules[0].when = subject => { reads++; return predicate(subject) }
  const dispose = mountRuleSources(root, [{ moduleId: 'module', rules }])
  const context = { agent: main, scope: main }
  const owned = entries => entries.filter(entry => entry.name.startsWith('prompt-tool:'))
  const first = await root.systemPrompt.assemble(context)
  assert.deepEqual(owned(first.sections).map(entry => entry.text), ['SYSTEM'])
  assert.deepEqual(owned(first.contexts).map(entry => entry.text), ['RUNTIME'])
  assert.equal(reads, 1)
  const delegated = await root.systemPrompt.assemble({ agent: child, scope: child })
  assert.ok(owned([...delegated.sections, ...delegated.contexts]).every(entry => entry.text === ''))
  assert.equal(reads, 2)
  await root.systemPrompt.assemble(context)
  assert.equal(reads, 3, '复用同一 context 对象的下一次装配也必须重判')
  dispose()
  const released = await root.systemPrompt.assemble(context)
  assert.deepEqual(owned(released.sections), [])
  assert.deepEqual(owned(released.contexts), [])
  assert.equal(reads, 3)
})

test('统一规则：注入与过滤在同一 pre-step 按 do 顺序处理，并在压缩后重新判定', async () => {
  const rules = compileRules([{ id: 'baseline', then: [textAction('baseline', 'BASELINE')] }, { id: 'mixed', if: { phase: { promoted: true } }, then: [
    textAction('a', 'A', { sourceKind: 'plugin' }),
    { id: 'filter', kind: 'pre-step-filter', blockPlugins: ['a'] },
    textAction('b', 'B', { sourceKind: 'plugin' }),
  ] }])
  const predicate = rules[1].when
  let reads = 0
  rules[1].when = Object.assign(subject => { reads++; return predicate(subject) }, { observe: predicate.observe })
  const h = harness()
  const dispose = mountRuleSources(h.ctx, [{ moduleId: 'module', rules }])
  const events = []
  const agent = actor()
  agent.session.snapshotEvents = () => events
  const original = [{ id: 'u', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'USER' }] }]
  const run = async () => (await h.run('agent/pre-step', [{ agent, messages: original }], () => ({ kind: 'enter', messages: original }))).messages.flatMap(message => message.content.map(block => block.text))
  const record = async type => {
    const event = { type, seq: events.length + 1, data: {} }; events.push(event)
    await h.emit('session/event', agent.session, event)
  }
  assert.deepEqual(await run(), ['USER', 'BASELINE'])
  await record('assistant/message')
  assert.deepEqual(await run(), ['USER', 'BASELINE', 'B'])
  await record('compaction/end')
  assert.deepEqual(await run(), ['USER', 'BASELINE'])
  await record('assistant/message')
  assert.deepEqual(await run(), ['USER', 'BASELINE', 'B'])
  assert.equal(reads, 4)
  dispose()
  const claimed = { id: 'claimed', role: 'user', source: { kind: 'plugin', plugin: 'claimed' }, content: [{ type: 'text', text: 'CLAIMED' }] }
  const added = { id: 'added', role: 'user', source: { kind: 'plugin', plugin: 'added' }, content: [{ type: 'text', text: 'ADDED' }] }
  const releaseFilter = mountRuleSources(h.ctx, [{ moduleId: 'filter', rules: compileRules([{ id: 'filter', then: [{ id: 'keep', kind: 'pre-step-filter', keepKinds: ['user'] }] }]) }])
  const filtered = await h.run('agent/pre-step', [{ agent, messages: [claimed] }], () => ({ kind: 'enter', messages: [claimed, added, ...original] }))
  assert.deepEqual(filtered.messages, [claimed, ...original], '只保留真实claimed与明确允许kind，不能把下游增量误作claimed')
  releaseFilter()
})

test('统一规则：模型流与停止事件各自执行，子代理启动复用真实启动事实', async () => {
  const childReceived = []; const steered = []
  const main = { ...actor(), steer: message => steered.push(message) }
  main.session.id = 'main'
  const child = { ...actor(), inject: message => childReceived.push(message) }
  child.session = { ...child.session, id: 'child', header: { delegationDepth: 1, parentSession: 'main' } }
  const agents = new Map([['main', main], ['child', child]])
  const h = harness({ agents })
  const rules = compileRules([
    { id: 'main-events', if: { scope: { audience: 'main' } }, then: [
      { id: 'stream', kind: 'inject-text', config: { layer: 'llm-stream', text: 'STREAM', params: { mode: 'replace' } } },
      { id: 'stop', kind: 'inject-text', config: { layer: 'turn-stop', text: 'CONTINUE' } },
    ] },
    { id: 'child-events', if: { scope: { audience: 'subagent' } }, then: [
      { id: 'start', kind: 'inject-text', config: { layer: 'subagent-start', text: 'START' } },
    ] },
  ])
  const dispose = mountRuleSources(h.ctx, [{ moduleId: 'module', rules }])
  let nextCalls = 0
  const chunks = []
  for await (const chunk of h.run('llm/stream', [{ sessionId: 'main', model: 'deepseek-chat' }], () => { nextCalls++; return [] })) chunks.push(chunk)
  assert.deepEqual(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text), ['STREAM'])
  assert.equal(nextCalls, 0)
  await h.emit('agent/turn-stopping', { agent: main, turn: 1 })
  await h.emit('agent/turn-stopping', { agent: main, turn: 1 })
  assert.deepEqual(steered.map(message => message.content[0].text), ['CONTINUE'])
  await h.emit('subagent/start', { id: 'child', runId: 'run' })
  assert.deepEqual(childReceived.map(message => message.content[0].text), ['START'])
  dispose()
  assert.ok([...h.events.values()].every(list => list.length === 0))
})

test('统一规则：缺失真实会话的 not 保持未知，any 中已知 true 分支仍能执行', async () => {
  const unknown = [{ scope: { audience: 'main' } }, { phase: { promoted: false } }, { session: { type: 'user/message', present: true } }]
  for (const when of [...unknown.map(node => ({ not: node })), { notAny: unknown }, { any: [{ not: unknown[0] }, { scope: { modelScope: 'all' } }] }]) {
    const h = harness()
    const rules = compileRules([{ id: 'missing-context', if: when, then: [
      { id: 'stream', kind: 'inject-text', config: { layer: 'llm-stream', text: 'REPLACED', params: { mode: 'replace' } } },
      { id: 'end', kind: 'inject-text', config: { layer: 'subagent-end', text: 'OBSERVED' } },
    ] }])
    const dispose = mountRuleSources(h.ctx, [{ moduleId: 'module', rules }])
    let nextCalls = 0
    const result = h.run('llm/stream', [{ model: 'deepseek-chat' }], () => { nextCalls++; return [] })
    const chunks = []; for await (const chunk of result) chunks.push(chunk)
    const knownTrue = Object.hasOwn(when, 'any')
    assert.equal(nextCalls, knownTrue ? 0 : 1)
    assert.equal(chunks.some(chunk => chunk.text === 'REPLACED'), knownTrue)
    await h.emit('subagent/end', { id: 'absent-child', runId: 'unknown-run' })
    assert.equal(h.warnings.some(message => message.includes('observe only')), knownTrue)
    dispose()
  }
  const missingFacts = [
    { names: { allow: ['bash'] } },
    { not: { text: { subject: 'toolResult', keys: ['blocked'] } } },
    { not: { source: { kind: 'user' } } },
  ]
  for (const when of [...missingFacts, { any: [missingFacts[1], { scope: { modelScope: 'all' } }] }]) {
    const h = harness()
    const rule = compileRules([{ id: 'missing-facts', if: when, then: [{ id: 'request', kind: 'request-params', modelScope: 'all', patch: { maxTokens: 123 } }] }])[0]
    const dispose = mountRuleSources(h.ctx, [{ moduleId: 'facts', rules: [rule] }])
    const result = await h.run('agent/request', [{ agent: actor() }], () => ({ maxTokens: 77 }))
    assert.deepEqual(result, { maxTokens: Object.hasOwn(when, 'any') ? 123 : 77 }, '请求执行点缺name/text/source事实时不能经正向或not执行动作')
    dispose()
  }
  const matchingRule = when => compileRules([{ id: 'known-facts', if: when, then: [{ id: 'request', kind: 'request-params', patch: {} }] }])[0]
  assert.equal(ruleMatches(matchingRule(missingFacts[1]), ruleFrame('tools/post-execute', [{ agent: actor(), name: 'bash' }, { content: [] }])), true, '合法空工具结果是已知空文本，不是缺事实')
  assert.equal(ruleMatches(matchingRule({ not: { source: { plugin: 'blocked' } } }), ruleFrame('agent/inbox/inserted', [{ agent: actor(), message: { source: { kind: 'user' }, content: [] } }])), true, '已知source对象明确没有plugin可以判断')
})

test('统一规则：锚定资格由条件决定，确认与两轮兜底保留注入正文和来源说明', async () => {
  const h = harness()
  const rules = compileRules([{ id: 'anchor', if: { anchor: { keys: ['We'], fallbackAfter: 1 } }, then: [
    textAction('notice', 'NOTICE', { strategy: 'anchor-notice', params: { firstTurnWord: 'We' } }),
  ] }])
  const dispose = mountRuleSources(h.ctx, [{ moduleId: 'module', rules }])
  const events = []
  const agent = actor()
  agent.session.snapshotEvents = () => events
  const run = () => h.run('agent/pre-step', [{ agent }], () => ({ kind: 'enter', messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'USER' }] }] }))
  assert.equal((await run()).messages.length, 1)
  events.push({ type: 'assistant/message', data: { message: { content: [{ type: 'reasoning', text: 'We start.' }] } } })
  assert.match((await run()).messages[1].source.summary, /锚定确认后注入/)
  agent.session.id = 'fallback'
  events[0].data.message.content[0].text = 'Other reasoning'
  assert.equal((await run()).messages.length, 1)
  events.push({ type: 'assistant/message', data: { message: { content: [] } } })
  assert.match((await run()).messages[1].source.summary, /未确认,兜底注入/)
  dispose()
})

test('统一规则：新动作空种子不生成业务效果，未设模型条件的请求动作不偏好 Pro', async () => {
  const h = harness()
  const examples = getRuleEditorMeta().actions.map(({ kind, example }) => ({ ...example, id: kind }))
  const dispose = mountRuleSources(h.ctx, [{ moduleId: 'empty', rules: compileRules([{ id: 'empty', then: examples }]) }])
  const agent = actor()
  const messages = [{ id: 'u', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'USER' }] }]
  const baseline = { kind: 'enter', messages }
  assert.equal(await h.run('agent/pre-step', [{ agent, messages }], () => baseline), baseline)
  const request = { maxTokens: 32 }
  assert.equal(await h.run('agent/request', [{ agent }], () => request), request)
  assert.deepEqual(await h.run('tools/pre-execute', [{ agent, name: 'bash' }], () => ({ kind: 'allow' })), { kind: 'allow' })
  const assembly = { sections: [], contexts: [], tools: [] }
  assert.equal(await h.run('system-prompt/assemble', [assembly, { agent }], () => assembly), assembly)
  dispose()
  const release = mountRuleSources(h.ctx, [{ moduleId: 'all-models', rules: compileRules([{ id: 'request', then: [{ id: 'patch', kind: 'request-params', patch: { maxTokens: 64 } }] }]) }])
  for (const model of ['deepseek-pro', 'deepseek-flash']) {
    agent.options.model = model
    assert.deepEqual(await h.run('agent/request', [{ agent }], () => request), { maxTokens: 64 })
  }
  release()
})

// —— if/then/else 语法（2026-10-05 重构：外层与 do 层统一为分支结构）——

test('if/then/else：规则级分支展开为结构互斥的动作序列，then 在前 else 在后', () => {
  const rules = compileRules([{
    id: 'branch',
    if: { phase: { promoted: false } },
    then: [textAction('then-act', 'THEN')],
    else: [textAction('else-act', 'ELSE')],
  }])
  assert.deepEqual(rules[0].actions.map(action => action.id), ['then-act', 'else-act'], '展开顺序保持声明序：then 在前')
  assert.equal(rules[0].actions.length, 2, '两个分支各贡献自己的动作')
  assert.equal(typeof rules[0].when, 'function', '规则级 if 仍编译成规则条件')
})

test('if/then/else：无 if 即无条件；动作级分支与外层条件合取且可嵌套', () => {
  const plain = compileRules([{ id: 'plain', then: [textAction('t', 'T')] }])
  assert.equal(plain[0].when, undefined, '无 if 的规则不设条件')
  assert.deepEqual(plain[0].actions.map(action => action.id), ['t'])

  const nested = compileRules([{
    id: 'nested',
    if: { phase: { promoted: false } },
    then: [{
      if: { scope: { audience: 'subagent' } },
      then: [{ if: { session: { type: 'user/message', present: false } }, then: [textAction('deep', 'D')], else: [textAction('deep-else', 'DE')] }],
      else: [textAction('sub-else', 'SE')],
    }],
  }])
  assert.deepEqual(nested[0].actions.map(action => action.id), ['deep', 'deep-else', 'sub-else'], '两层分支按声明序深度优先展开')
})

test('if/then/else：条件命中执行 then、不命中执行 else', async () => {
  const rules = compileRules([{
    id: 'branch',
    if: { scope: { audience: 'subagent' } },
    then: [{ id: 'sub', kind: 'request-params', patch: { maxTokens: 11 } }],
    else: [{ id: 'main', kind: 'request-params', patch: { maxTokens: 22 } }],
  }])
  const h = harness()
  const dispose = mountRuleSources(h.ctx, [{ moduleId: 'branch-module', rules }])
  const agentAt = depth => ({ session: { id: 's', header: depth === 0 ? {} : { delegationDepth: depth }, snapshotEvents: () => [] }, options: { model: 'deepseek-chat' } })
  const call = agent => h.run('agent/request', [{ agent }], () => ({ maxTokens: 5 }))
  assert.deepEqual(await call(agentAt(1)), { maxTokens: 11 }, '子代理命中 then')
  assert.deepEqual(await call(agentAt(0)), { maxTokens: 22 }, '主会话走 else')
  dispose()
})

test('if/then/else：旧 when/do 不再是兼容输入，一律显式拒绝并指向新名', () => {
  assert.throws(() => compileRules([{ id: 'r', when: { phase: { promoted: false } }, then: [textAction('t', 'T')] }]), /"when" 已退役.*"if"/)
  assert.throws(() => compileRules([{ id: 'r', do: [textAction('t', 'T')] }]), /"do" 已退役.*"then"/)
  // 新名照常编译：拒绝的是旧名，不是这一层能力。
  const modern = compileRules([{ id: 'r', if: { phase: { promoted: false } }, then: [textAction('t', 'T')] }])
  assert.equal(typeof modern[0].when, 'function')
})

test('if/then/else：注册制层不接受动作级分支（该层没有逐轮求值时机）', () => {
  assert.throws(() => compileRules([{
    id: 'reg',
    then: [{
      if: { phase: { promoted: false } },
      then: [{ id: 's', kind: 'inject-text', config: { id: 's', layer: 'system-section', text: 'X' } }],
    }],
  }]), /system-section/)
  // 拒绝的是分支，不是这一层本身：同层不带分支照旧可用。
  const ok = compileRules([{ id: 'reg-ok', then: [{ id: 's', kind: 'inject-text', config: { id: 's', layer: 'system-section', text: 'X' } }] }])
  assert.equal(ok[0].actions.length, 1)
})

test('if/then/else：动作级 text 条件必须落在本执行点真实提供的 subject 上', () => {
  const branchOn = subject => ({
    if: { text: { keys: ['x'], ...(subject === undefined ? {} : { subject }) } },
    then: [{ id: 'inject', kind: 'inject-text', config: { id: 'inject', layer: 'subagent-start', strategy: 'static', text: 'X' } }],
  })
  // 主路径：subagent 两通道真实提供的文本只有 subagentInfo。
  assert.equal(compileRules([{ id: 'r', then: [branchOn('subagentInfo')] }])[0].actions.length, 1)
  // 关键拒绝：写别的 subject 时该动作永不执行，且挂载与运行期都不报错。
  assert.throws(() => compileRules([{ id: 'r', then: [branchOn('userMessage')] }]), /action inject: text subject "userMessage".*可用 subagentInfo/s)
  // 边界：省略 subject 的判定恒为「缺事实」，同样是死路。
  assert.throws(() => compileRules([{ id: 'r', then: [branchOn(undefined)] }]), /action inject: text needs an explicit subject/)
  // 规则级 if 不在此列：它在每个动作的执行点各自求值，缺事实即不执行是三值语义的设计意图。
  assert.equal(compileRules([{
    id: 'r',
    if: { text: { keys: ['x'], subject: 'toolResult' } },
    then: [{ id: 'request', kind: 'request-params', modelScope: 'all', patch: {} }],
  }]).length, 1)
})

test('统一规则：判定类别按通道上报，命中、条件为假与缺事实可区分', async () => {
  const h = harness()
  const reported = []
  const rules = compileRules([
    { id: 'hit', if: { text: { keys: ['目标'], subject: 'userMessage' } }, then: [textAction('a', 'A')] },
    { id: 'miss', if: { text: { keys: ['没有这句话'], subject: 'userMessage' } }, then: [textAction('b', 'B')] },
    { id: 'unavailable', if: { text: { keys: ['目标'], subject: 'toolResult' } }, then: [textAction('c', 'C')] },
  ])
  const dispose = mountRuleSources(h.ctx, [{ moduleId: 'module', rules }], { onOutcome: item => reported.push(item) })
  const agent = actor()
  const messages = [{ id: 'u', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '目标' }] }]
  await h.run('agent/pre-step', [{ agent, messages }], () => ({ kind: 'enter', messages }))
  assert.deepEqual(reported.filter(item => item.ruleId === 'hit'), [
    { moduleId: 'module', ruleId: 'hit', channel: 'agent/pre-step', outcome: 'hit' },
  ], JSON.stringify({ warnings: h.warnings }))
  assert.equal(reported.find(item => item.ruleId === 'miss')?.outcome, 'miss')
  // 缺事实（pre-step 载荷没有 toolResult 文本）与「条件为假」必须分开，前者才是「为什么没触发」。
  assert.equal(reported.find(item => item.ruleId === 'unavailable')?.outcome, 'unavailable')
  dispose()
})

test('动作级分支：五层 inject-text 与默认位置 pre-step-filter 的 else 恰好一支生效', async () => {
  const childReceived = []
  const steered = []
  const mainReceived = []
  const main = { ...actor(), inject: message => mainReceived.push(message) }
  main.session = { ...main.session, id: 'main-agent' }
  const makeAgent = (id, model) => {
    const agent = { ...actor(), inject: message => childReceived.push(message), steer: message => steered.push(message) }
    agent.session = { ...agent.session, id, header: { delegationDepth: 1, parentSession: 'main-agent' } }
    agent.options = { model }
    return agent
  }
  const flash = makeAgent('flash-agent', 'deepseek-flash')
  const pro = makeAgent('pro-agent', 'deepseek-pro')
  const agents = new Map([['main-agent', main], ['flash-agent', flash], ['pro-agent', pro]])
  const h2 = harness({ agents })
  const branch = (id, layer, thenConfig, elseConfig) => ({
    if: { scope: { modelScope: 'flash' } },
    then: [{ id: `${id}-then`, kind: 'inject-text', config: { layer, ...thenConfig } }],
    else: [{ id: `${id}-else`, kind: 'inject-text', config: { layer, ...elseConfig } }],
  })
  const rules = compileRules([{ id: 'action-branches', then: [
    branch('req', 'agent-request', { params: { patch: { maxTokens: 111 } } }, { params: { patch: { maxTokens: 222 } } }),
    branch('stream', 'llm-stream', { text: 'THEN', params: { mode: 'replace' } }, { text: 'ELSE', params: { mode: 'replace' } }),
    branch('stop', 'turn-stop', { text: 'THEN-STOP' }, { text: 'ELSE-STOP' }),
    branch('start', 'subagent-start', { text: 'THEN-START' }, { text: 'ELSE-START' }),
    branch('end', 'subagent-end', { text: 'THEN-END', params: { action: 'inject-main' } }, { text: 'ELSE-END', params: { action: 'inject-main' } }),
    { if: { scope: { modelScope: 'flash' } }, then: [
      { id: 'filter-then', kind: 'pre-step-filter', blockPlugins: ['A'] },
    ], else: [
      { id: 'filter-else', kind: 'pre-step-filter', blockPlugins: ['B'] },
    ] },
  ] }])
  const dispose = mountRuleSources(h2.ctx, [{ moduleId: 'module', rules }])
  // agent-request：flash 走 then，pro 走 else。
  const req = agent => h2.run('agent/request', [{ agent }], () => ({ maxTokens: 5 }))
  assert.equal((await req(flash)).maxTokens, 111)
  assert.equal((await req(pro)).maxTokens, 222)
  // llm-stream：流替换只出现命中分支的正文。
  const streamText = async model => {
    const chunks = []
    for await (const chunk of h2.run('llm/stream', [{ sessionId: 'flash-agent', model }], () => [])) chunks.push(chunk)
    return chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('')
  }
  assert.equal(await streamText('deepseek-flash'), 'THEN')
  assert.equal(await streamText('deepseek-pro'), 'ELSE')
  // turn-stop：steer 正文即方向；另用 actionMatches 直接对比判定结果。
  await h2.emit('agent/turn-stopping', { agent: flash, turn: 1 })
  assert.deepEqual(steered.map(message => message.content[0].text), ['THEN-STOP'])
  steered.length = 0
  await h2.emit('agent/turn-stopping', { agent: pro, turn: 2 })
  assert.deepEqual(steered.map(message => message.content[0].text), ['ELSE-STOP'])
  const stopActions = rules[0].actions.filter(action => action.execution.channel === 'agent/turn-stopping')
  const stopFrame = ruleFrame('agent/turn-stopping', [{ agent: flash, turn: 3 }], () => {})
  assert.equal(stopActions.filter(action => actionMatches({ rule: rules[0], actionWhen: action.actionWhen, bypassRuleWhen: action.bypassRuleWhen, id: action.id }, stopFrame)).length, 1, 'turn-stop 方向断言：恰好一支命中')
  // subagent-start：注入只出现命中分支的正文。
  await h2.emit('subagent/start', { id: 'flash-agent', runId: 'run-flash' })
  assert.deepEqual(childReceived.map(message => message.content[0].text), ['THEN-START'])
  childReceived.length = 0
  await h2.emit('subagent/start', { id: 'pro-agent', runId: 'run-pro' })
  assert.deepEqual(childReceived.map(message => message.content[0].text), ['ELSE-START'])
  // subagent-end：注入主会话只出现命中分支的正文。
  await h2.emit('subagent/end', { id: 'flash-agent', runId: 'end-flash' })
  assert.deepEqual(mainReceived.map(message => message.content[0].text), ['THEN-END'])
  await h2.emit('subagent/end', { id: 'pro-agent', runId: 'end-pro' })
  assert.deepEqual(mainReceived.map(message => message.content[0].text), ['THEN-END', 'ELSE-END'])
  // 默认位置 pre-step-filter：flash 屏蔽 A，pro 屏蔽 B。
  const messages = [
    { id: 'a', role: 'user', source: { kind: 'plugin', plugin: 'A' }, content: [{ type: 'text', text: 'A' }] },
    { id: 'b', role: 'user', source: { kind: 'plugin', plugin: 'B' }, content: [{ type: 'text', text: 'B' }] },
  ]
  const filtered = agent => h2.run('agent/pre-step', [{ agent, messages }], () => ({ kind: 'enter', messages }))
  assert.deepEqual((await filtered(flash)).messages.map(message => message.source.plugin), ['B'])
  assert.deepEqual((await filtered(pro)).messages.map(message => message.source.plugin), ['A'])
  dispose()
})

test('动作级分支关键拒绝：规则级 else 无 if 与 guard 矛盾组合编译期拒绝', () => {
  assert.throws(() => compileRules([{ id: 'else-no-if', then: [textAction('t', 'T')], else: [textAction('e', 'E')] }]), /else requires an if/)
  assert.throws(() => compileRules([{ id: 'else-null-if', if: null, then: [textAction('t', 'T')], else: [textAction('e', 'E')] }]), /else requires an if/)
  // guard 是注册期动作，与动作级分支条件（逐轮求值）自相矛盾。
  assert.throws(() => compileRules([{ id: 'guard-branch', then: [
    { if: { scope: { modelScope: 'flash' } }, then: [{ id: 'g', kind: 'guard', mask: { deny: ['bash'] } }] },
  ] }]), /no per-turn evaluation point/)
})

test('动作级分支边界：compaction/end 后分支回到初始支', async () => {
  const h = harness()
  const rules = compileRules([{ id: 'phase-branch', then: [{
    if: { phase: { promoted: true } },
    then: [{ id: 'then-req', kind: 'request-params', patch: { maxTokens: 111 } }],
    else: [{ id: 'else-req', kind: 'request-params', patch: { maxTokens: 222 } }],
  }] }])
  const dispose = mountRuleSources(h.ctx, [{ moduleId: 'module', rules }])
  const events = []
  const agent = actor()
  agent.session.snapshotEvents = () => events
  const call = () => h.run('agent/request', [{ agent }], () => ({ maxTokens: 5 }))
  assert.equal((await call()).maxTokens, 222, '初始未晋升走 else')
  const promote = { type: 'assistant/message', seq: 1, data: {} }
  events.push(promote)
  await h.emit('session/event', agent.session, promote)
  assert.equal((await call()).maxTokens, 111, '晋升后走 then')
  const compact = { type: 'compaction/end', seq: 2, data: {} }
  events.push(compact)
  await h.emit('session/event', agent.session, compact)
  assert.equal((await call()).maxTokens, 222, '压缩后回到初始 else')
  dispose()
})
