import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { compileRules, getRuleEditorMeta, isFixedRegistration } from '../../engine/rule-spec.mjs'
import { INJECT_CONFIG_FIELDS, SESSION_VARIABLES_DISABLED } from '../../engine/schema.mjs'
import { prepareAction } from '../../engine/actions.mjs'
import { toolNameSet } from '../../engine/actions/shared.mjs'
import { ACTION_EXAMPLES } from '../../engine/actions/examples.mjs'
import { ACTION_KINDS } from '../../engine/actions/catalog.mjs'
import { mountRuleSources } from '../../engine/rule-runtime.mjs'
import { wireLayers } from '../../engine/layers.mjs'
import { WARN_ONCE_LIMIT, createWarnOnce } from '../../engine/shared.mjs'
import { setSessionVar } from '../../engine/session-vars.mjs'
import { ruleFrame, ruleMatches, actionMatches } from '../../engine/conditions/evaluation.mjs'
import { createNameListPredicate, subjectOf, FACT_PREDICATE_SUBJECTS, createAnchorPredicate, createCountPredicate, createSessionStatePredicate } from '../../engine/conditions/index.mjs'
import { UNAVAILABLE } from '../../engine/conditions/availability.mjs'
import { lastWorldBookDiagnostics, stChatMessages } from '../../engine/st-world-book.mjs'
import { currentEvents, viewRestricted } from '../../engine/history.mjs'

function harness(services = {}) {
  const events = new Map()
  const effects = []
  const warnings = []
  const infos = []
  const ctx = {
    get: name => services[name],
    logger: {
      warn(message) { warnings.push(message) },
      info(message) { infos.push(message) },
    },
    on(name, handler, options) {
      const list = events.get(name) ?? []; events.set(name, list)
      if (options?.prepend) list.unshift(handler); else list.push(handler)
      return () => { const at = list.indexOf(handler); if (at >= 0) list.splice(at, 1) }
    },
    effect(callback) { const dispose = callback(); if (typeof dispose === 'function') effects.push(dispose); return dispose },
  }
  return { ctx, events, effects, warnings, infos, async emit(name, ...args) {
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

test('T13：去重集合按消息累计且严格有界，到上限补一条抑制提示后静默', () => {
  const h = harness()
  const warnOnce = createWarnOnce(h.ctx, 'probe')
  // 64 条不同消息：全部记账。
  for (let index = 0; index < 64; index += 1) warnOnce(`probe: distinct ${index}`)
  assert.equal(h.warnings.length, WARN_ONCE_LIMIT, '上限内的 64 条不同消息都要记')
  // 第 65 条不同消息被抑制，且恰好补一条提示。
  warnOnce('probe: distinct 64')
  assert.equal(h.warnings.length, WARN_ONCE_LIMIT + 1, '不得超过 64 + 1 条')
  assert.match(h.warnings.at(-1), /后续告警已抑制/)
  // 上限之后：旧消息与新的不同消息都不再输出（提示只写一次）。
  warnOnce('probe: distinct 0')
  warnOnce('probe: distinct 65')
  warnOnce('probe: distinct 66')
  assert.equal(h.warnings.length, WARN_ONCE_LIMIT + 1, '抑制提示只写一次，此后静默')
  // logger 抛错不占名额：同一条消息在 logger 恢复后仍能记上。
  const failing = harness()
  const originalWarn = failing.ctx.logger.warn
  let broken = true
  failing.ctx.logger.warn = (message) => { if (broken) throw new Error('logger unavailable'); originalWarn(message) }
  const retry = createWarnOnce(failing.ctx, 'probe')
  retry('probe: transient')
  assert.equal(failing.warnings.length, 0)
  broken = false
  retry('probe: transient')
  assert.equal(failing.warnings.length, 1, '失败的告警不占名额')
})

test('T13：两个不同 when 异常各记一次，同一异常重复只记一次', async () => {
  const h = harness()
  const boom = (id, text) => {
    const rule = compileRules([{ id, then: [textAction(`${id}-text`, 'X')] }])[0]
    rule.when = () => { throw new Error(text) }
    return rule
  }
  const dispose = mountRuleSources(h.ctx, [{ moduleId: 'module', rules: [boom('a', 'first failure'), boom('b', 'second failure')] }])
  const agent = actor()
  const messages = [{ id: 'u', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'USER' }] }]
  const step = () => h.run('agent/pre-step', [{ agent, messages }], () => ({ kind: 'enter', messages }))
  await step()
  await step()
  assert.deepEqual(h.warnings.map(message => message.match(/condition failed: (.*)$/)?.[1]), ['first failure', 'second failure'],
    '两个不同异常各记一次，同一异常重复不再记')
  dispose()
})

test('T13：observe 命中之后 inject-main 失败仍记录（信息性提示不占告警名额）', async () => {
  const h = harness()
  // 只挂 observe：命中走 info，一条告警都不产生。
  const observeOnly = mountRuleSources(h.ctx, [{ moduleId: 'module', rules: compileRules([
    { id: 'observe-only', then: [{ id: 'observe', kind: 'inject-text', config: { id: 'observe', layer: 'subagent-end', text: 'OBSERVED' } }] },
  ]) }])
  await h.emit('subagent/end', { id: 'child', runId: 'run-1' })
  await h.emit('subagent/end', { id: 'child', runId: 'run-3' })
  assert.equal(h.infos.filter(message => message.includes('observe only')).length, 2, 'observe-only 逐次走 info 通道')
  assert.deepEqual(h.warnings, [], 'observe-only 不占用告警名额')
  observeOnly()
  // 同一挂载的后续故障（inject-main 无活跃主会话）照常告警。
  const dispose = mountRuleSources(h.ctx, [{ moduleId: 'module', rules: compileRules([
    { id: 'notify-main', then: [{ id: 'notify', kind: 'inject-text', config: { id: 'notify', layer: 'subagent-end', text: 'MAIN', params: { action: 'inject-main' } } }] },
  ]) }])
  await h.emit('subagent/end', { id: 'child', runId: 'run-2' })
  assert.equal(h.warnings.length, 1, '后续 inject-main 失败仍记录')
  assert.match(h.warnings[0], /no live main session/)
  dispose()
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

test('统一规则：同模块多条续跑动作共享一份预算，每轮只续跑一次且每会话合计 3 次', async () => {
  const steered = []
  const agent = { ...actor(), steer: message => steered.push(message.content[0].text) }
  const h = harness()
  const dispose = mountRuleSources(h.ctx, [{ moduleId: 'module', rules: compileRules([
    { id: 'continue-one', layer: 'turn-stop', then: [{ id: 'one', kind: 'append-context', mode: 'continue', text: 'ONE' }] },
    { id: 'continue-two', layer: 'turn-stop', then: [{ id: 'two', kind: 'append-context', mode: 'continue', text: 'TWO' }] },
    { id: 'continue-three', layer: 'turn-stop', then: [{ id: 'three', kind: 'append-context', mode: 'continue', text: 'THREE' }] },
  ]) }])
  const stop = turn => h.emit('agent/turn-stopping', { agent, turn })
  // 同一轮三条 continue 只允许一次续跑：预算按来源模块一份，不按动作各建一份。
  for (let turn = 1; turn <= 4; turn += 1) { await stop(turn); await stop(turn) }
  assert.deepEqual(steered, ['ONE', 'ONE', 'ONE'], '每轮 1 次、每会话 3 次（四条轮次里第 4 轮已到会话上限）')
  dispose()
})

test('统一规则：同模块两动作续跑一次，跨模块各保留一份预算且单动作路径不受影响', async () => {
  const steered = []
  const subject = () => ({ ...actor(), steer: message => steered.push(message.content[0].text) })
  const h = harness()
  const dispose = mountRuleSources(h.ctx, [{ moduleId: 'module', rules: compileRules([{ id: 'loop', layer: 'turn-stop', then: [
    { id: 'one', kind: 'append-context', mode: 'continue', text: 'ONE' },
    { id: 'two', kind: 'append-context', mode: 'continue', text: 'TWO' },
  ] }]) }])
  const single = subject()
  await h.emit('agent/turn-stopping', { agent: single, turn: 1 })
  await h.emit('agent/turn-stopping', { agent: single, turn: 1 })
  assert.deepEqual(steered, ['ONE'], '同一轮只续跑一次；第二条动作不再各占一份预算')
  dispose()

  // 另一模块（另一个 mount）自带一份预算，不互相消耗。
  const other = harness()
  const separate = subject()
  const disposeOther = mountRuleSources(other.ctx, [{ moduleId: 'other', rules: compileRules([
    { id: 'other-loop', layer: 'turn-stop', then: [{ id: 'other-one', kind: 'append-context', mode: 'continue', text: 'OTHER' }] },
  ]) }])
  await other.emit('agent/turn-stopping', { agent: separate, turn: 1 })
  assert.deepEqual(steered, ['ONE', 'OTHER'])
  disposeOther()
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
    // observe-only 命中走 info 通道（逐次记录），不再占用按消息去重的告警名额。
    assert.equal(h.infos.some(message => message.includes('observe only')), knownTrue)
    assert.equal(h.warnings.some(message => message.includes('observe only')), false)
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

test('T15：dedupe=session 慢路径命中后回填快路径，下一步不再整表扫描', async () => {
  const h = harness()
  const rules = compileRules([{ id: 'persisted', then: [
    textAction('persisted', 'PERSISTED', { dedupe: 'session', position: 'before-all' }),
    textAction('sibling', 'SIBLING', { dedupe: 'session', position: 'before-all' }),
  ] }])
  const dispose = mountRuleSources(h.ctx, [{ moduleId: 'module', rules }])
  const agent = actor()
  // 冷路径：宿主已把 `persisted` 那条持久化，memo 是空的（本次装配没走过 session/event）。
  const events = [{
    type: 'user/message',
    seq: 1,
    data: { message: { id: 'm1', role: 'user', source: { kind: 'plugin:persisted' }, content: [{ type: 'text', text: 'PERSISTED' }] } },
  }]
  let scans = 0
  agent.session.snapshotEvents = () => { scans += 1; return events }
  const step = async () => {
    const before = scans
    const decision = await h.run('agent/pre-step', [{ agent }], () => ({
      kind: 'enter', messages: [{ id: 'u', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'USER' }] }],
    }))
    return { texts: decision.messages.flatMap(message => message.content.map(block => block.text)), scans: scans - before }
  }
  const first = await step()
  assert.deepEqual(first.texts, ['SIBLING', 'USER'], '整表命中已投递的那条 → 不注入；同位置兄弟照常')
  const second = await step()
  assert.deepEqual(second.texts, first.texts, '第二步的注入层、次数与同位置兄弟都不变')
  // 慢路径按既有入口回填 memo 之后，该配置在第二步不再读一次事件快照（兄弟仍走慢路径）。
  assert.equal(second.scans, first.scans - 1, `回填后第二步少一次整表扫描（${first.scans} → ${second.scans}）`)
  dispose()
})

test('T15：turn-stop 未声明 match 时不重复读事件快照', async () => {
  const steered = []
  let scans = 0
  const h = harness()
  const agent = { ...actor(), steer: message => steered.push(message.content[0].text) }
  agent.session.snapshotEvents = () => { scans += 1; return [] }
  const dispose = mountRuleSources(h.ctx, [{ moduleId: 'module', rules: compileRules([
    { id: 'stop', layer: 'turn-stop', then: [{ id: 'stop', kind: 'inject-text', config: { layer: 'turn-stop', text: 'GO' } }] },
  ]) }])
  await h.emit('agent/turn-stopping', { agent, turn: 1 })
  assert.deepEqual(steered, ['GO'], '主路径：命中即续跑一次')
  // 唯一一次读是本帧的 assistantText；无 match 时 conditionHit 恒真，不再先读一次快照。
  assert.equal(scans, 1)
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
  // 关键拒绝（F26）：规则级 if 与嵌套分支同名 userMessage 时，嵌套分支仍按**自身执行点**校验。
  // 按 subject 名字跳过会让 tools/pre-execute 上的 userMessage 死条件编译通过——基线正是如此。
  assert.throws(() => compileRules([{
    id: 'r',
    if: { text: { keys: ['x'], subject: 'userMessage' } },
    then: [{
      if: { text: { keys: ['x'], subject: 'userMessage' } },
      then: [{ id: 'deny', kind: 'decision', phase: 'pre', decision: 'deny', reason: 'blocked' }],
    }],
  }]), /action deny: text subject "userMessage".*可用 toolArgs/)
  // 边界：省略 subject 的判定恒为「缺事实」，同样是死路。
  assert.throws(() => compileRules([{ id: 'r', then: [branchOn(undefined)] }]), /action inject: text needs an explicit subject/)
  // 规则级 if 不在此列：它在每个动作的执行点各自求值，缺事实即不执行是三值语义的设计意图。
  assert.equal(compileRules([{
    id: 'r',
    if: { text: { keys: ['x'], subject: 'toolResult' } },
    then: [{ id: 'request', kind: 'request-params', modelScope: 'all', patch: {} }],
  }]).length, 1)
  // 规则级 else 的动作自带 not(if)、按**对象身份**剔除（`branch.mjs#expandActions` 保留 outer
  // 元素引用）：request-params 落在 agent/request，那里没有任何文本 subject——剔除一旦失效
  // （如 outer 元素被复制），这条合法声明就会被误判成死条件、在编译期抛错。
  const elsewhere = compileRules([{
    id: 'r',
    if: { text: { keys: ['x'], subject: 'userMessage' } },
    then: [{ id: 'then-req', kind: 'request-params', modelScope: 'all', patch: { maxTokens: 111 } }],
    else: [{ id: 'else-req', kind: 'request-params', modelScope: 'all', patch: { maxTokens: 222 } }],
  }])
  assert.deepEqual(elsewhere[0].actions.map(action => action.id), ['then-req', 'else-req'], '规则级 else 的 not(if) 不是动作级死条件')
})

test('动作级 names / source 条件必须落在本执行点真实提供的事实上', () => {
  const branchOn = (condition, action) => ({ if: condition, then: [action] })
  const preDecision = { id: 'deny', kind: 'decision', phase: 'pre', decision: 'deny', reason: 'blocked' }
  const inboxPrepend = { id: 'ip', kind: 'inbox-prepend', target: 'next-turn', text: 'X' }
  // 主路径：工具执行点提供 name（exec.name），收件箱插入点提供 source（message.source）。
  assert.equal(compileRules([{ id: 'r', then: [branchOn({ names: { allow: ['bash'] } }, preDecision)] }])[0].actions.length, 1)
  assert.equal(compileRules([{ id: 'r', then: [branchOn({ source: { kind: 'plugin:x' } }, inboxPrepend)] }])[0].actions.length, 1)
  // 关键拒绝：pre-step 的载荷既没有 name 也没有 source，写上去的动作永不执行且挂载与运行期都不报错。
  assert.throws(() => compileRules([{ id: 'r', then: [branchOn({ names: { allow: ['bash'] } }, textAction('t', 'T'))] }]), /action t: names subject "name".*可用 （无）/)
  assert.throws(() => compileRules([{ id: 'r', then: [branchOn({ source: { kind: 'user' } }, textAction('t', 'T'))] }]), /action t: source subject "source".*可用 （无）/)
  // 边界：subagent 两层的 name = provider（表里标记为提供），因此 names 编译放行；
  // provider 真缺席是**运行期** UNAVAILABLE，不是编译期拒绝。
  assert.equal(compileRules([{
    id: 'r',
    then: [branchOn({ names: { allow: ['fork'] } }, { id: 's', kind: 'inject-text', config: { id: 's', layer: 'subagent-start', strategy: 'static', text: 'X' } })],
  }])[0].actions.length, 1)
  assert.equal(createNameListPredicate({ allow: ['fork'] })(subjectOf('subagent/start', [{ runId: 'r-1', id: 's-1', local: true }])), UNAVAILABLE)
})

test('动作级死条件：llm/stream 拒 names/source/text，依赖 agent 补挂的会话六族不拒', () => {
  const streamOn = condition => ({
    if: condition,
    then: [{ id: 'stream', kind: 'inject-text', config: { id: 'stream', layer: 'llm-stream', text: 'X', params: { mode: 'replace' } } }],
  })
  // 本通道载荷只有 provider/model/sessionId 等请求字段：既没有 name/source，也没有任何文本
  // subject（两个白名单函数对本通道都返回空），三类死条件照常拒绝。
  assert.throws(() => compileRules([{ id: 'r', then: [streamOn({ names: { allow: ['bash'] } })] }]), /action stream: names subject "name".*可用 （无）/)
  assert.throws(() => compileRules([{ id: 'r', then: [streamOn({ source: { kind: 'user' } })] }]), /action stream: source subject "source".*可用 （无）/)
  assert.throws(() => compileRules([{ id: 'r', then: [streamOn({ text: { keys: ['x'], subject: 'userMessage' } })] }]), /action stream: text subject "userMessage".*可用 （无）/)
  // 会话四族与 preset / scope.audience 的事实来自 layers.mjs 在判定**之前**用 sessionId → agents.get
  // 补挂的 agent，今天真能命中：编译期不拒（拒绝会误伤），只按运行期 fail-closed 处理。
  const live = compileRules([{ id: 'r', then: [streamOn({ all: [
    { phase: { promoted: false } },
    { session: { type: 'user/message', present: false } },
    { count: { of: 'tool-call', per: 'turn', min: 1 } },
    { anchor: { keys: ['We'], fallbackAfter: 1 } },
    { preset: { presetId: 'preset-id' } },
    { scope: { audience: 'main' } },
  ] })] }])
  assert.equal(typeof live[0].actions[0].actionWhen, 'function', '会话六族在 llm/stream 上不被拒绝：事实由运行期的 sessionId → agents 补挂提供')
})

test('事实谓词只有一处登记：rule-spec 的判据直接读谓词侧映射（漂移即红）', () => {
  const branchOn = (condition, action) => ({ if: condition, then: [action] })
  const preDecision = { id: 'deny', kind: 'decision', phase: 'pre', decision: 'deny', reason: 'blocked' }
  const compileNames = () => compileRules([{ id: 'r', then: [branchOn({ names: { allow: ['bash'] } }, preDecision)] }])
  assert.equal(compileNames()[0].actions.length, 1, '主路径：工具执行点提供 name')
  // 改共享映射 = 改谓词侧唯一登记处，校验面必须当场跟着变。若 rule-spec 另有一张手抄表，
  // 改映射不影响它的判据 → 下面这次拒绝不成立 → 红。
  FACT_PREDICATE_SUBJECTS.names = 'agent'
  try {
    assert.throws(compileNames, /names subject "agent" is unavailable/)
  } finally {
    FACT_PREDICATE_SUBJECTS.names = 'name'
  }
  assert.equal(compileNames()[0].actions.length, 1, '还原后照旧放行')
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

test('动作级分支上报：按「规则∧动作」的最终判定记账，每帧每动作一次', async () => {
  const h = harness()
  const reported = []
  const rules = compileRules([
    // 主路径：规则级 if 为真且动作级分支为真 → 该动作记 hit。
    { id: 'branch', if: { phase: { promoted: false } }, then: [
      { if: { scope: { modelScope: 'flash' } }, then: [textAction('then-inject', 'THEN')] },
    ] },
    // 关键拒绝（F09）：规则级 if 为真、动作级分支为假 → 记 miss，不得记规则级 hit。
    { id: 'gate-off', if: { phase: { promoted: false } }, then: [
      { if: { scope: { modelScope: 'pro' } }, then: [textAction('off-inject', 'OFF')] },
    ] },
    // 缺事实同样按动作级最终判定记账，与「条件为假」分开。
    { id: 'gate-unknown', if: { phase: { promoted: false } }, then: [
      { if: { preset: { presetId: 'target' } }, then: [textAction('unknown-inject', 'UNKNOWN')] },
    ] },
    // 边界：规则级 else 自带 not(if)；else 动作按动作级最终判定入账，then 动作照旧走规则级。
    { id: 'rule-else', if: { scope: { modelScope: 'flash' } }, then: [textAction('else-then', 'ET')], else: [textAction('else-else', 'EE')] },
  ])
  const dispose = mountRuleSources(h.ctx, [{ moduleId: 'module', rules }], { onOutcome: item => reported.push(item) })
  const agent = actor()
  agent.options = { model: 'deepseek-flash' }
  const messages = [{ id: 'u', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'USER' }] }]
  const texts = (await h.run('agent/pre-step', [{ agent, messages }], () => ({ kind: 'enter', messages })))
    .messages.flatMap(message => message.content.map(block => block.text))
  const outcomes = ruleId => reported.filter(item => item.ruleId === ruleId).map(item => item.outcome)
  assert.deepEqual(outcomes('branch'), ['hit'], '分支为真按动作级最终判定记 hit')
  assert.deepEqual(outcomes('gate-off'), ['miss'], '分支为假记 miss，不记规则级 hit')
  assert.deepEqual(outcomes('gate-unknown'), ['unavailable'], '动作级缺事实记 unavailable')
  assert.deepEqual(outcomes('rule-else'), ['hit', 'miss'], 'else 独占通道：then 走规则级 hit、else 走动作级 miss')
  assert.deepEqual(texts, ['USER', 'THEN', 'ET'], '只有命中分支注入正文')
  // 边界：同一帧内同一动作实例重复求值只记一次（去重按动作实例，判定仍按当次事实）。
  const branched = rules[1].actions[0]
  const entry = { rule: rules[1], actionWhen: branched.actionWhen, bypassRuleWhen: branched.bypassRuleWhen, id: branched.id }
  const direct = []
  const frame = ruleFrame('agent/pre-step', [{ agent, messages }], () => {}, undefined, (rule, channel, outcome) => direct.push({ ruleId: rule.id, channel, outcome }))
  assert.equal(actionMatches(entry, frame), false)
  assert.equal(actionMatches(entry, frame), false)
  assert.deepEqual(direct, [{ ruleId: 'gate-off', channel: 'agent/pre-step', outcome: 'miss' }], '同帧重复求值不重复记账')
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

test('动作级观察接线：规则级 phase + else 在 tool/call 事件后恰好一支执行', async () => {
  const h = harness()
  const rules = compileRules([{
    id: 'phase-rule',
    if: { phase: { promoted: true } },
    then: [textAction('phase-then', 'THEN', { position: 'after-user' })],
    else: [textAction('phase-else', 'ELSE', { position: 'after-user' })],
  }])
  const dispose = mountRuleSources(h.ctx, [{ moduleId: 'module', rules }])
  const agent = actor()
  // durable 日志全空：翻转只能来自 session/event 的增量喂入，冷扫不会替这条链路作答。
  agent.session.snapshotEvents = () => []
  const messages = [{ id: 'u', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'USER' }] }]
  const step = async () => (await h.run('agent/pre-step', [{ agent, messages }], () => ({ kind: 'enter', messages })))
    .messages.flatMap(message => message.content.map(block => block.text))
  // 首次判定建立会话态条目：observe 只喂已判定过的会话（phase / count 同一纪律）。
  assert.deepEqual(await step(), ['USER', 'ELSE'], '未晋升走规则级 else')
  await h.emit('session/event', agent.session, { type: 'tool/call', seq: 1, data: {} })
  assert.deepEqual(await step(), ['USER', 'THEN'], 'tool/call 晋升后 then 与 else 恰好一支')
  dispose()
})

test('动作级观察接线：嵌套 count{min:1} 分支在 tool/call 事件后翻转', async () => {
  const h = harness()
  const rules = compileRules([{ id: 'count-rule', then: [{
    if: { count: { of: 'tool-call', min: 1 } },
    then: [textAction('count-then', 'THEN', { position: 'after-user' })],
    else: [textAction('count-else', 'ELSE', { position: 'after-user' })],
  }] }])
  const dispose = mountRuleSources(h.ctx, [{ moduleId: 'module', rules }])
  const agent = actor()
  agent.session.snapshotEvents = () => []
  const messages = [{ id: 'u', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'USER' }] }]
  const step = async () => (await h.run('agent/pre-step', [{ agent, messages }], () => ({ kind: 'enter', messages })))
    .messages.flatMap(message => message.content.map(block => block.text))
  assert.deepEqual(await step(), ['USER', 'ELSE'], '计数 0 走 else')
  await h.emit('session/event', agent.session, { type: 'tool/call', seq: 1, data: {} })
  assert.deepEqual(await step(), ['USER', 'THEN'], '计数 1 后翻转，then 与 else 恰好一支')
  dispose()
})

test('动作级分支：非 pre-step 层嵌套 if 恰好一支生效', async () => {
  const h = harness()
  const rules = compileRules([{ id: 'nested', then: [{
    if: { scope: { modelScope: 'flash' } },
    then: [{
      if: { scope: { audience: 'subagent' } },
      then: [{ id: 'deep', kind: 'request-params', modelScope: 'all', patch: { maxTokens: 111 } }],
      else: [{ id: 'deep-else', kind: 'request-params', modelScope: 'all', patch: { maxTokens: 222 } }],
    }],
    else: [{ id: 'outer-else', kind: 'request-params', modelScope: 'all', patch: { maxTokens: 333 } }],
  }] }])
  const dispose = mountRuleSources(h.ctx, [{ moduleId: 'module', rules }])
  const make = (id, model, depth) => {
    const agent = actor()
    agent.session = { ...agent.session, id, header: depth === 0 ? {} : { delegationDepth: depth } }
    agent.options = { model }
    return agent
  }
  const flashSub = make('flash-sub', 'deepseek-flash', 1)
  const flashMain = make('flash-main', 'deepseek-flash', 0)
  const proSub = make('pro-sub', 'deepseek-pro', 1)
  const req = agent => h.run('agent/request', [{ agent }], () => ({ maxTokens: 5 }))
  assert.equal((await req(flashSub)).maxTokens, 111, 'flash+subagent 走最内层 then')
  assert.equal((await req(flashMain)).maxTokens, 222, 'flash+main 走内层 else')
  assert.equal((await req(proSub)).maxTokens, 333, 'pro 走外层 else')
  dispose()
})

test('挂载回滚：llm/stream 层路由与执行点不一致时错误上浮，agent/request 监听回到 0', () => {
  const h = harness()
  const rules = compileRules([{ id: 'p5', then: [
    { id: 'req', kind: 'request-params', patch: { maxTokens: 1 } },
    { id: 'stream', kind: 'inject-text', config: { layer: 'llm-stream', text: 'X', params: { mode: 'replace' } } },
  ] }])
  // 把 llm-stream 动作的层改成 agent-request：执行点仍是 llm/stream，但 wireLayers 按层路由到
  // agent/request，与 flushLayers 的通道判定不一致 → 抛错并回滚已注册的 agent/request 监听。
  rules[0].actions[1].compiledConfig.layer = 'agent-request'
  assert.throws(() => mountRuleSources(h.ctx, [{ moduleId: 'module', rules }]), /registered outside llm\/stream/)
  assert.equal((h.events.get('agent/request') ?? []).length, 0, '抛错后 agent/request 监听已回滚')
})

test('after-next 动作读取 next 之后的下游结果：unset 命中下游值才删键', async () => {
  const h = harness()
  const rules = compileRules([{ id: 'p6', then: [{ id: 'strip', kind: 'request-params', unset: { maxTokens: 64 } }] }])
  const dispose = mountRuleSources(h.ctx, [{ moduleId: 'module', rules }])
  const agent = actor()
  const result = await h.run('agent/request', [{ agent }], () => ({ maxTokens: 64, temperature: 0.5 }))
  assert.deepEqual(result, { temperature: 0.5 }, 'unset 命中下游 maxTokens=64，证明 after-next 读取的是 next() 的结果')
  const untouched = await h.run('agent/request', [{ agent }], () => ({ maxTokens: 32 }))
  assert.deepEqual(untouched, { maxTokens: 32 }, '下游值不等时不删键')
  dispose()
})

test('ST 世界书组互斥在整步成立：默认位置 filter 切开批次时同组两条只注入一条', async () => {
  const lore = (id, text) => ({ id, kind: 'inject-text', config: { id, layer: 'pre-step', strategy: 'world-book', position: 'after-all', text, params: { keys: ['KEY'], stWorldBook: { group: 'lore' } } } })
  const noopFilter = id => ({ id, kind: 'pre-step-filter', blockPlugins: ['nothing'] })
  // 真值源：两个同组成员分别在两个 flush 里（filter 切在两条之间），末批只有非世界书配置。
  const plan = split => compileRules([{ id: 'lore', then: split
    ? [lore('lore-a', 'A-LORE'), noopFilter('split-1'), lore('lore-b', 'B-LORE'), noopFilter('split-2'), textAction('tail', 'TAIL', { position: 'after-all' })]
    : [lore('lore-a', 'A-LORE'), lore('lore-b', 'B-LORE'), textAction('tail', 'TAIL', { position: 'after-all' })] }])
  const run = async (rules) => {
    const h = harness()
    const dispose = mountRuleSources(h.ctx, [{ moduleId: 'module', rules }])
    const agent = actor()
    const messages = [{ id: 'u', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'KEY 提示' }] }]
    const original = Math.random
    // 真值源（手算）：两条目 order 同为 0（排序稳定）且组内权重相等（各 100），掷点固定 0 → 声明序首位中标。
    Math.random = () => 0
    let result
    try {
      result = await h.run('agent/pre-step', [{ agent, messages }], () => ({ kind: 'enter', messages }))
    } finally { Math.random = original }
    const loreTexts = result.messages.flatMap(message => message.content.map(block => block.text)).filter(text => text.endsWith('-LORE'))
    dispose()
    return { loreTexts, records: lastWorldBookDiagnostics(agent.session).records }
  }
  const split = await run(plan(true))
  const whole = await run(plan(false))
  assert.deepEqual(split.loreTexts, ['A-LORE'], `同组两条在整步只允许声明序首位中标，切开也不换人（实际 ${split.loreTexts.join('/')}）`)
  assert.deepEqual(whole.loreTexts, ['A-LORE'], '同一批时同样只注入一条')
  // 末批无世界书（只有 tail）时，本步赢家与 loser 的诊断必须留在同一份快照里。
  assert.ok(split.records.some(record => record.stage === 'selected' && record.reason === 'group-winner'), '赢家 selected 记录保留')
  assert.ok(split.records.some(record => record.stage === 'rejected' && record.reason === 'group-lost'), '同组 loser 的拒绝原因保留')
  assert.ok(split.records.some(record => record.stage === 'committed'), 'commit 事实写回同一份快照')
})

test('世界书选择抛错按「本步跳过注入」降级：只告警一次、不抛进 waterfall', async () => {
  const rules = compileRules([{ id: 'lore', then: [
    textAction('plain', 'PLAIN', { position: 'after-all' }),
    { id: 'wb', kind: 'inject-text', config: { id: 'wb', layer: 'pre-step', strategy: 'world-book', position: 'after-all', text: 'LORE', params: { keys: ['KEY'], stWorldBook: { group: 'lore' } } } },
  ] }])
  // 键的宏求值在 selectStWorldBook 的 per-config try 之外：坏键只能降级本步，不能逸出。
  rules[0].actions.find(action => action.id === 'wb').compiledConfig.params.keys[0] = { toString() { throw new Error('key exploded') } }
  const h = harness()
  const dispose = mountRuleSources(h.ctx, [{ moduleId: 'module', rules }])
  const agent = actor()
  const messages = [{ id: 'u', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'KEY 提示' }] }]
  const result = await h.run('agent/pre-step', [{ agent, messages }], () => ({ kind: 'enter', messages }))
  assert.deepEqual(result.messages, messages, '批级判定失败 → 本步不注入，decision 原样返回')
  assert.equal(h.warnings.filter(message => String(message).includes('prompt config failed, skipping')).length, 1, '失败恰好告警一次')
  dispose()
})

test('pre-step 动作级分支：每步 actionWhen 恰好求值一次，命中分支注入一次', async () => {
  const rules = compileRules([{ id: 'branch', then: [
    { if: { scope: { modelScope: 'flash' } }, then: [textAction('flash-inject', 'FLASH', { position: 'after-user' })], else: [textAction('other-inject', 'OTHER', { position: 'after-user' })] },
    { id: 'split', kind: 'pre-step-filter', blockPlugins: ['nothing'] },
    textAction('tail', 'TAIL', { position: 'after-all' }),
  ] }])
  // 计数包装沿用 agent-assembly.test.mjs 的写法：替换判定函数并在命中路径上计数。
  const branch = rules[0].actions.find(action => action.id === 'flash-inject')
  const evaluate = branch.actionWhen
  let evaluations = 0
  branch.actionWhen = Object.assign(subject => { evaluations++; return evaluate(subject) }, evaluate)
  const h = harness()
  const dispose = mountRuleSources(h.ctx, [{ moduleId: 'module', rules }])
  const agent = actor()
  agent.options = { model: 'deepseek-flash' }
  const messages = [{ id: 'u', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'USER' }] }]
  const injected = (await h.run('agent/pre-step', [{ agent, messages }], () => ({ kind: 'enter', messages })))
    .messages.flatMap(message => message.content.map(block => block.text))
  assert.deepEqual(injected, ['USER', 'FLASH', 'TAIL'], '主路径命中分支注入一次，动作级 else 不注入')
  assert.equal(evaluations, 1, '每步只判定一次动作分支（filter 切开批次也不例外）')
  dispose()
})

test('variablesEnabled=false：声明变量引用按插值语法剥离，未声明键与内置引用原样保留', () => {
  const text = 'A {{foo}} B {{ foo }} C {{ bar }} D {{DSH_HOME}} E {{foo::x}}'
  const expected = 'A  B  C {{ bar }} D {{DSH_HOME}} E '
  const compile = variablesEnabled => compileRules([{ id: 'vars', then: [
    { id: 'text', kind: 'inject-text', config: { id: 'v-text', layer: 'pre-step', text } },
    { id: 'texts', kind: 'inject-text', config: { id: 'v-texts', layer: 'pre-step', texts: [text] } },
    { id: 'params', kind: 'inject-text', config: { id: 'v-params', layer: 'pre-step', params: { text } } },
  ] }], { variables: { foo: 'F' }, variablesEnabled })
  const disabled = Object.fromEntries(compile(false)[0].actions.map(action => [action.id, action.compiledConfig]))
  assert.equal(disabled.text.texts[0], expected, 'text 出口')
  assert.equal(disabled.texts.texts[0], expected, 'texts 出口')
  assert.equal(disabled.params.params.text, expected, 'params.text 出口')
  const enabled = Object.fromEntries(compile(undefined)[0].actions.map(action => [action.id, action.compiledConfig]))
  assert.equal(enabled.text.texts[0], text, '启用时正文原样保留')
  assert.equal(enabled.text.variables.foo, 'F', '启用时声明变量挂上配置')
  // 单一事实来源：标记键名与白名单取自同一常量——两处手写字面量时，改一处即静默变回未知键。
  assert.equal(disabled.text[SESSION_VARIABLES_DISABLED], true, '停用时编译产物带执行期标记')
  assert.equal(INJECT_CONFIG_FIELDS.has(SESSION_VARIABLES_DISABLED), false, '标记键不在作者可写的白名单里')
  assert.throws(() => compileRules([{ id: 'vars', then: [textAction('vars-text', 'X', { [SESSION_VARIABLES_DISABLED]: true })] }]),
    /unknown config key\(s\).*variablesDisabled/, '作者手写标记键按未知键拒绝（引擎内部字段不可写）')
  assert.equal(Object.hasOwn(enabled.text, SESSION_VARIABLES_DISABLED), false, '启用时不打标记')
})

test('variablesEnabled=false 执行期连会话变量一起停：内建与未声明引用不受影响，同批其他模块照常', async () => {
  // 真值源：同一份声明（owner=MODULE），只有顶层开关不同——两模块同批（各自来源）注入，
  // 差异只能来自开关：停用模块的会话值不注入、声明键已剥离，启用模块两者都生效。
  const module = variablesEnabled => compileRules([{ id: 'vars', then: [
    textAction('vars-text', 'owner={{owner}} other={{other}} home={{DSH_HOME}}', { position: 'after-all' }),
  ] }], { variables: { owner: 'MODULE' }, variablesEnabled })
  const h = harness()
  const dispose = mountRuleSources(h.ctx, [
    { moduleId: 'off-module', rules: module(false) },
    { moduleId: 'on-module', rules: module(true) },
  ])
  const agent = actor()
  setSessionVar(agent.session, 'owner', 'SESSION')
  setSessionVar(agent.session, 'other', 'OTHER')
  const messages = [{ id: 'u', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'USER' }] }]
  const texts = (await h.run('agent/pre-step', [{ agent, messages }], () => ({ kind: 'enter', messages })))
    .messages.flatMap(message => message.content.map(block => block.text))
  dispose()
  // 两个来源各自成批：不靠先后，按内容认领（同值 order 下批间顺序不是契约）。
  const ownerLines = texts.filter(text => text.startsWith('owner=')).sort()
  assert.equal(texts.includes('USER'), true, '用户消息原样保留')
  assert.equal(ownerLines.length, 2, '同会话两个模块都注入：停用不影响其他模块')
  assert.equal(texts.filter(text => text.includes('{{DSH_HOME}}')).length, 0, '内置事实两边都真的解析（不残留字面）')
  // 不写死 DSH_HOME 的真值：runner 注入的与宿主回退值都成立。
  assert.deepEqual(ownerLines.map(line => line.replace(/home=.*/, 'home=<resolved>')), [
    'owner= other={{other}} home=<resolved>',
    'owner=SESSION other=OTHER home=<resolved>',
  ], '停用模块连会话变量一起停，启用模块会话覆盖声明值')
})

test('variablesEnabled=false 在注册层同样停会话变量：官方变量不吃会话覆盖与并入', () => {
  const session = { id: 'vars-off-layer', header: {}, snapshotEvents: () => [] }
  setSessionVar(session, 'owner', 'SESSION')
  const registered = []
  const systemPrompt = {
    section: () => () => {},
    context: () => () => {},
    variable(name, read) { registered.push({ name, read }); return () => {} },
  }
  const ctx = { on: () => () => {}, get: (name) => (name === 'systemPrompt' ? systemPrompt : undefined), logger: { warn() {} } }
  const render = (variablesEnabled) => {
    registered.length = 0
    // 动作级 config.variables 在停用时仍保留（停的只是模块级合并），所以该名字照常注册。
    const rule = compileRules([{ id: 'sec', then: [{
      id: 'sec-text', kind: 'inject-text',
      config: { id: 'sec-text', layer: 'system-section', strategy: 'static', params: { sectionName: 'S' }, text: 'owner={{owner}}', variables: { owner: 'MODULE' } },
    }] }], { variablesEnabled })[0]
    wireLayers(ctx, [rule.actions[0].compiledConfig], () => {})
    return registered.map(item => item.read({ agent: { session } })).join('|')
  }
  // 注册出去的是该变量的值（文本插值由 section/context 那条路径做）。
  assert.equal(render(false), 'MODULE', '停用后官方变量不吃会话覆盖')
  assert.equal(render(true), 'SESSION', '启用时会话覆盖声明值')
})

test('动作声明白名单：未知键、对象形态 match 与带 kind 的分支节点编译期拒绝', () => {
  // 关键拒绝（fail-closed 反向）：decision 的 toolNames 拼错今天会静默变成「对所有工具生效」。
  assert.throws(() => compileRules([{ id: 'gate', then: [
    { id: 'deny', kind: 'decision', phase: 'pre', decision: 'deny', toolName: 'read' },
  ] }]), /action deny: unknown config key\(s\) toolName — allowed keys: .*toolNames/)
  // 关键拒绝：request-params 的动作级 when 今天被静默忽略（补丁无条件生效）。
  assert.throws(() => compileRules([{ id: 'req', then: [
    { id: 'patch', kind: 'request-params', patch: { maxTokens: 10 }, when: { scope: { modelScope: 'pro' } } },
  ] }]), /action patch: "when" 已退役，改用 "if"/)
  // 关键拒绝：request-params 的 patch / unset 子键拼错或值非法时补丁静默不生效（LlmCallConfig 键集）。
  assert.throws(() => compileRules([{ id: 'req', then: [
    { id: 'p', kind: 'request-params', patch: { maxToken: 10 } },
  ] }]), /action p\.patch\.maxToken is not a LlmCallConfig field/)
  assert.throws(() => compileRules([{ id: 'req', then: [
    { id: 'u', kind: 'request-params', unset: { temperture: 0.5 } },
  ] }]), /action u\.unset\.temperture is not a LlmCallConfig field/)
  assert.throws(() => compileRules([{ id: 'req', then: [
    { id: 'v', kind: 'request-params', patch: { maxTokens: 'ten' } },
  ] }]), /action v\.patch\.maxTokens has an invalid value/)
  // 关键拒绝：replace=true 会整体丢掉下游 provider/model，缺一即不可用（与 config 层同判据）。
  for (const patch of [{}, { model: 'deepseek-pro' }, { provider: 'deepseek' }]) {
    assert.throws(() => compileRules([{ id: 'req', then: [
      { id: 'r', kind: 'request-params', replace: true, patch },
    ] }]), /r\.patch requires provider and model when replace=true/)
  }
  // 边界：replace=true 且两者齐全时照常编译。
  assert.equal(compileRules([{ id: 'req', then: [
    { id: 'r', kind: 'request-params', replace: true, patch: { provider: 'deepseek', model: 'deepseek-pro' } },
  ] }]).length, 1)
  // 关键拒绝：replace 非布尔今天静默退化成「只合并 patch」（`=== true` 才整体替换，与 config 层对称）。
  for (const value of ['yes', 1, null]) {
    assert.throws(() => compileRules([{ id: 'req', then: [
      { id: 'r', kind: 'request-params', replace: value, patch: { maxTokens: 10 } },
    ] }]), /r\.replace must be a boolean \(省略 = false\)/)
  }
  // 同一份 `assertReplacePatch` 也服务 config 层：inject-text 的 agent-request 配置文案逐字不变。
  assert.throws(() => compileRules([{ id: 'cfg', then: [
    { id: 'a', kind: 'inject-text', config: { id: 'a', layer: 'agent-request', strategy: 'static', params: { replace: true, patch: {} } } },
  ] }]), /configs\[0\]\.params\.patch requires provider and model when replace=true/)
  // 关键拒绝：inject-text.config 的未知键（同一份提示词配置白名单）。
  assert.throws(() => compileRules([{ id: 'r', then: [textAction('a', 'A', { typoKey: 1 })] }]),
    /action a config: unknown config key\(s\) typoKey — allowed keys: .*text/)
  // 关键拒绝：prepend 是未文档化的注册后门，动作层与 config 层都取消且无等价替代。
  assert.throws(() => compileRules([{ id: 'r', then: [
    { id: 'a', kind: 'assembly', prepend: true, target: { tools: { deny: ['bash'] } } },
  ] }]), /`prepend` 已取消.*waterfallPosition: outermost/)
  assert.throws(() => compileRules([{ id: 'r', then: [textAction('a', 'A', { prepend: true })] }]),
    /`prepend` 已取消.*waterfallPosition: outermost/)
  // 关键拒绝：动作级 match 出现即拒——函数形态过不了 structuredClone（DataCloneError），
  // 对象/字符串形态恒命中，三种都指回规则级 `if`（声明路径写不了函数）。
  for (const value of [() => true, 'x', { keys: ['x'] }]) {
    assert.throws(() => compileRules([{ id: 'strip', then: [
      { id: 'a', kind: 'assembly', match: value, target: { tools: { deny: ['bash'] } } },
    ] }]), /action a\.match 已取消.*rule\.if/, `match=${typeof value} 也要拒绝并指回 rule.if`)
  }
  // 关键拒绝（F24）：动作级 enabled/group/exclusive 属于规则层，运行期会被逐条覆盖。
  for (const [field, value] of [['enabled', true], ['group', 'g'], ['exclusive', true]]) {
    assert.throws(() => compileRules([{ id: 'r', then: [textAction('a', 'A', { [field]: value })] }]), new RegExp(`rule\\.${field}`))
  }
  // 边界：互斥判据只在规则层——规则级 group/exclusive 照常编译。
  assert.equal(compileRules([{ id: 'r', group: 'g', exclusive: true, then: [textAction('a', 'A')] }]).length, 1)
  // G07：带 kind 的动作写分支键时 expandActions 只认无 kind 的分支节点，分支被静默丢掉。
  for (const key of ['if', 'then', 'else']) {
    const node = { id: 'a', kind: 'decision', phase: 'pre', decision: 'deny', [key]: key === 'if' ? { scope: { audience: 'main' } } : [] }
    assert.throws(() => compileRules([{ id: 'g', then: [node] }]), /action a 写了 .*分支必须写成无 `kind` 的节点/)
  }
})

test('T16：inject-text 在 tool-pipeline 层不可注入——规则路径与公开动作路径同一句拒绝', () => {
  const messageOf = (fn) => {
    try {
      fn()
      return undefined
    } catch (error) {
      return String(error?.message ?? error)
    }
  }
  const action = { id: 'tp', kind: 'inject-text', config: { id: 'tp', layer: 'tool-pipeline', strategy: 'static', text: 'X' } }
  // 规则路径此前只有声明路径（trigger-spec）的断言；这里同时锁住两条公开路径的文案同源：
  // 判据只有 `actionExecutionPoint` 一处（层清单派生自 schema 的 LAYER_DEFINITIONS）。
  const viaRules = messageOf(() => compileRules([{ id: 'rules-path', then: [action] }]))
  const viaAction = messageOf(() => prepareAction(action))
  assert.match(viaRules ?? '', /inject-text layer "tool-pipeline" has no single trigger channel — 该层在工具链上不可注入，请改用 decision \/ append-context 动作/)
  assert.equal(viaAction, viaRules, '两条公开路径共用 actionExecutionPoint 的同一句拒绝')
})

test('F27：complete / suppressRuntimeContext 只属于 system-section 层', () => {
  // 关键拒绝：其他层写这两个键既不注册成独占段，还会被独占计数误算——点名层（出现即拒，
  // 非布尔真值同样拒：`'yes'` / `1` 落不到任何注册期效果上）。
  for (const flag of ['complete', 'suppressRuntimeContext']) {
    for (const value of [true, 'yes', 1]) {
      assert.throws(() => compileRules([{ id: 'r', then: [
        { id: 'a', kind: 'inject-text', config: { id: 'a', layer: 'pre-step', text: 'X', params: { [flag]: value } } },
      ] }]), new RegExp(`action a: config\\.params\\.${flag} 只属于 layer system-section — 当前 layer 是 "pre-step"`))
    }
    assert.throws(() => compileRules([{ id: 'r', then: [
      { id: 'a', kind: 'inject-text', config: { id: 'a', layer: 'subagent-start', text: 'X', params: { [flag]: true } } },
    ] }]), /system-section — 当前 layer 是 "subagent-start"/)
  }
  // 判据是单一谓词：非 system-section 的同名键一律不是固定注册效果。
  assert.equal(isFixedRegistration({ layer: 'pre-step', params: { complete: true } }), false)
  assert.equal(isFixedRegistration({ layer: 'system-section', params: { complete: true } }), true)
  // 边界：system-section 的 complete 不受影响，仍是注册期效果。
  const fixed = compileRules([{ id: 'r', then: [
    { id: 'a', kind: 'inject-text', config: { id: 'a', layer: 'system-section', text: 'X', params: { complete: true } } },
  ] }])
  assert.equal(fixed[0].actions[0].execution.lifecycle, 'registration')
  // 边界：pre-step 的同名键（false）不计入独占计数，与合法独占卡并存不报冲突。
  assert.equal(compileRules([
    { id: 'pre', then: [{ id: 'a', kind: 'inject-text', config: { id: 'a', layer: 'pre-step', text: 'X', params: { complete: false } } }] },
    { id: 'sys', then: [{ id: 'b', kind: 'inject-text', config: { id: 'b', layer: 'system-section', text: 'Y', params: { complete: true } } }] },
  ]).length, 2)
  // 主路径不变：两个 system-section complete 仍然拒绝。
  assert.throws(() => compileRules([
    { id: 's1', then: [{ id: 'a', kind: 'inject-text', config: { id: 'a', layer: 'system-section', text: 'X', params: { complete: true } } }] },
    { id: 's2', then: [{ id: 'b', kind: 'inject-text', config: { id: 'b', layer: 'system-section', text: 'Y', params: { complete: true } } }] },
  ]), /multiple complete system sections/)
})

test('T31：规则卡的动作种子覆盖 catalog 声明的可编辑字段，且不替用户选业务值', () => {
  const meta = getRuleEditorMeta()
  for (const [kind, definition] of Object.entries(ACTION_KINDS)) {
    const keys = Object.keys(ACTION_EXAMPLES[kind])
    assert.deepEqual(keys.filter(key => !definition.fields.includes(key)), [], `${kind} 的种子不能有 catalog 未声明的键`)
    // 每条种子都能编译（工具裁决要求 phase/decision/action 落在引擎既有枚举里）。
    assert.doesNotThrow(() => compileRules([{ id: 'seed', then: [{ ...structuredClone(ACTION_EXAMPLES[kind]), id: 'a', kind }] }]), `${kind} 的种子不可编译`)
    assert.deepEqual(Object.keys(meta.actions.find(item => item.kind === kind).example).sort(),
      ['kind', ...keys].sort(), `${kind} 的下发种子就是 ACTION_EXAMPLES`)
    // `match` 三种形态都被 rule-spec 拒绝，种子是结构化值 → 它不在这张卡的可编辑面里。
    if (definition.fields.includes('match')) {
      assert.deepEqual(definition.fields.filter(field => !keys.includes(field)), ['match'], `${kind} 只允许 match 落在种子外`)
    }
  }
  // 用户追加面：decision / append-context 的工具链参数在卡里结构化可编辑。
  assert.deepEqual(ACTION_EXAMPLES.decision, { phase: 'pre', decision: 'allow', action: 'accept', reason: '', text: '', toolNames: '' })
  assert.deepEqual(ACTION_EXAMPLES['append-context'], { mode: 'context', text: '' })
  // 「匹配所有工具」的真实条件是**空串或空数组**（`names.size === 0` → `undefined`）——不是
  // 「数组会被解析成空」：`toolNameSet` 对数组直接交 `NAME_LIST.parse`，定向名单照样成立。
  assert.equal(toolNameSet('', 'probe', 'probe.toolNames'), undefined)
  assert.equal(toolNameSet([], 'probe', 'probe.toolNames'), undefined)
  assert.deepEqual(toolNameSet(['bash', 'run_code', 'bash'], 'probe', 'probe.toolNames'), new Set(['bash', 'run_code']))
})

/**
 * 会话桩：`log` 是 durable 真值源，`nodes` 是**模型可见**节点。
 * 两条与宿主同构的事实（真值源 `packages/core/session/src/surface.ts:50-56`）：只有消息类事件
 * 进得了 surface，非消息事件（`tool/call`、`turn/start`、`compaction/end`）永远不是节点；
 * 只有 replace 推进 `replaceGeneration`（`surface.ts:569-572`）。
 */
const visibleSession = (id, state) => ({
  id,
  header: {},
  snapshotEvents: () => state.log,
  surface: { get nodes() { return state.nodes }, get replaceGeneration() { return state.generation } },
})

test('T6a：anchor 只认当前可见的首条 assistant 推理，兜底轮数按 seq 去重', () => {
  const state = {
    log: [
      { type: 'assistant/message', seq: 0, data: { message: { content: [{ type: 'reasoning', text: 'We start.' }] } } },
      { type: 'compaction/end', seq: 1, data: {} },
      { type: 'assistant/message', seq: 2, data: { message: { content: [{ type: 'text', text: 'AFTER' }] } } },
    ],
    nodes: [0],
    generation: 0,
  }
  const predicate = createAnchorPredicate({ keys: ['We'], fallbackAfter: 1 })
  assert.equal(predicate(visibleSession('t6a-anchor-visible', state)), true, '可见的首条 assistant 推理带锚定词 → 确认')
  // 压缩把那条推理遮蔽掉：冷启动重建时可见首条 assistant 换成别的 → 不确认，兜底也只剩 1 轮。
  state.nodes = [2]
  assert.equal(predicate(visibleSession('t6a-anchor-compacted', state)), false, '锚定推理不在可见上下文里就不再确认（全量日志仍能数到它）')

  // 位置替换后同一 seq 可在 nodes 里占多个位置：按条数直数会把一轮算成两轮。
  const plain = {
    log: [
      { type: 'assistant/message', seq: 0, data: { message: { content: [] } } },
      { type: 'assistant/message', seq: 1, data: { message: { content: [] } } },
    ],
    nodes: [0, 0],
    generation: 1,
  }
  assert.equal(predicate(visibleSession('t6a-anchor-dup', plain)), false, '同一 seq 重复出现只算一轮（fallbackAfter=1 未满）')
  plain.nodes = [0, 1]
  assert.equal(predicate(visibleSession('t6a-anchor-two', plain)), true, '两条不同 seq 的可见 assistant 才凑满两轮')
})

test('T6a：session 谓词的 present 镜像是当前上下文，不是「本会话曾发生过」', () => {
  const state = {
    log: [
      { type: 'user/message', seq: 0, data: { message: {} } },
      { type: 'assistant/message', seq: 1, data: { message: {} } },
      { type: 'compaction/end', seq: 2, data: {} },
      // 宿主的压缩替身本身就是一条 user/message（`compaction-basic/src/region.ts:506`，带 replace surfaceOp）。
      { type: 'user/message', seq: 3, data: { message: {} } },
      { type: 'tool/call', seq: 4, data: {} },
    ],
    nodes: [0, 1],
    generation: 0,
  }
  const session = visibleSession('t6a-present', state)
  const present = createSessionStatePredicate({ type: 'assistant/message', present: true })
  const absent = createSessionStatePredicate({ type: 'assistant/message', present: false })
  assert.equal(present(session), true, '可见上下文里有 assistant 消息')
  assert.equal(absent(session), false)
  state.nodes = [2, 3]
  state.generation = 1
  assert.equal(present(session), false, '压缩遮蔽后 present:true 不再命中（全量日志仍看得到那条）')
  assert.equal(absent(session), true, 'present:false 镜像随之翻转')
  // 存量首轮守卫 `templates/67-inbox-prepend.yml` 的 `{type: user/message, present: false}` 不受影响：
  // 压缩替身是 user/message，可见上下文里仍然有该类型 → 压缩后**不**重放首轮。
  assert.equal(createSessionStatePredicate({ type: 'user/message', present: false })(session), false)
  // 非 surface 承载的类型永远不是 surface 节点：按当前上下文判会恒 false（present:true）/ 恒 true
  // （present:false），配置能编译能挂载却永不按意图命中 —— 这类类型按完整历史判。
  assert.equal(createSessionStatePredicate({ type: 'tool/call', present: true })(session), true, 'tool/call 不是 surface 节点，但本会话发生过 → 命中')
  assert.equal(createSessionStatePredicate({ type: 'tool/call', present: false })(session), false)
})

test('T6a：turn-stop 只匹配当前可见的最后一条 assistant 正文', async () => {
  const steered = []
  const h = harness()
  const agent = { ...actor(), steer: message => steered.push(message.content[0].text) }
  const state = {
    log: [
      { type: 'assistant/message', seq: 0, data: { message: { content: [{ type: 'text', text: 'EARLY' }] } } },
      { type: 'assistant/message', seq: 1, data: { message: { content: [{ type: 'text', text: 'LATE' }] } } },
    ],
    nodes: [0],
    generation: 1,
  }
  agent.session = visibleSession('t6a-turn-stop', state)
  const dispose = mountRuleSources(h.ctx, [{ moduleId: 'module', rules: compileRules([{
    id: 'stop',
    layer: 'turn-stop',
    if: { text: { subject: 'assistantText', keys: ['LATE'] } },
    then: [{ id: 'stop', kind: 'append-context', mode: 'continue', text: 'GO' }],
  }]) }])
  await h.emit('agent/turn-stopping', { agent, turn: 1 })
  assert.deepEqual(steered, [], '被移出可见节点的末条正文不再匹配')
  state.nodes = [0, 1]
  await h.emit('agent/turn-stopping', { agent, turn: 2 })
  assert.deepEqual(steered, ['GO'], '可见末条恢复后照常续跑')
  dispose()
})

test('T6a：count 消息类信号按当前上下文，log-only 信号按完整历史且两路径同结果', () => {
  const state = {
    log: [
      { type: 'user/message', seq: 0, data: { message: {} } },
      { type: 'tool/call', seq: 1, data: {} },
      { type: 'tool/result', seq: 2, data: { message: {} } },
      { type: 'tool/call', seq: 3, data: {} },
      { type: 'turn/start', seq: 4, data: { turn: 1 } },
      { type: 'user/message', seq: 5, data: { message: {} } },
      { type: 'tool/call', seq: 6, data: {} },
      { type: 'turn/start', seq: 7, data: { turn: 2 } },
    ],
    nodes: [0, 2, 5],
    generation: 0,
  }
  const session = visibleSession('t6a-count', state)
  const users = createCountPredicate({ of: 'user-message', min: 1 })
  const usersTwo = createCountPredicate({ of: 'user-message', min: 2 })
  const calls = createCountPredicate({ of: 'tool-call', min: 3 })
  const turns = createCountPredicate({ of: 'turn', min: 2 })
  assert.equal(users(session), true, '消息类：可见上下文里 2 条 user/message')
  assert.equal(usersTwo(session), true)
  assert.equal(calls(session), true, 'log-only：完整历史里 3 次 tool/call')
  assert.equal(turns(session), true, 'log-only：完整历史里 2 次 turn/start')

  // 成功压缩：替身 user/message 接替可见历史（宿主顺序：summary → 替身 append 成 replace → compaction/end）。
  state.log.push(
    { type: 'compaction/summary', seq: 8, data: {} },
    { type: 'user/message', seq: 9, data: { message: {} } },
    { type: 'compaction/end', seq: 10, data: {} },
  )
  state.nodes = [9]
  state.generation = 1
  for (const event of state.log.slice(8)) {
    for (const predicate of [users, usersTwo, calls, turns]) predicate.observe(session, event)
  }

  // 消息类：清条目后必须**走重建**（按当前上下文），不是「清空后从 0 继续累加」——
  // 替身那条 user/message 是清条目之前就喂进来的，从 0 起会漏掉它。
  assert.equal(users(session), true, '压缩清条目后重建：压缩后仍在可见上下文里的那条 user/message 计入')
  assert.equal(users(session), createCountPredicate({ of: 'user-message', min: 1 })(session), '与重启后重建同结果')
  assert.equal(usersTwo(session), false, '消息类按当前上下文：压缩遮蔽的 2 条不再计入（全量日志里仍有 3 条）')
  assert.equal(calls(session), true, 'log-only 不归零：清条目后按完整历史重建仍是 3 次 tool/call')
  assert.equal(turns(session), true, 'log-only 不归零：turn/start 仍数到 2 轮')
  assert.equal(createCountPredicate({ of: 'tool-call', min: 3 })(session), calls(session), '冷启动重建 == 增量累积')
  assert.equal(createCountPredicate({ of: 'turn', min: 2 })(session), turns(session), '冷启动重建 == 增量累积')

  // 位置替换（非压缩）只推进 surface 代次，没有 durable 事件可观察：代次变了同样按当前上下文重建。
  const replaced = {
    log: [
      { type: 'tool/result', seq: 0, data: { message: {} } },
      { type: 'tool/result', seq: 1, data: { message: {} } },
    ],
    nodes: [0, 1],
    generation: 0,
  }
  const replacedSession = visibleSession('t6a-count-replace', replaced)
  const results = createCountPredicate({ of: 'tool-result', min: 2 })
  assert.equal(results(replacedSession), true, '消息类：可见上下文里 2 条 tool/result')
  replaced.nodes = [1]
  replaced.generation = 1
  assert.equal(results(replacedSession), false, '代次推进后按当前上下文重算（1 < 2，全量日志里仍有 2 条）')

  // 位置替换后同一事件可在 `nodes` 里占多个位置：计数必须按 seq 去重，否则消息类信号虚高
  // （`every: N` 提前触发、`count <= max` 永不触发）；log-only 信号读完整历史，nodes 与它无关。
  const dup = {
    log: [
      { type: 'tool/result', seq: 0, data: { message: {} } },
      { type: 'tool/call', seq: 1, data: {} },
      { type: 'tool/call', seq: 2, data: {} },
    ],
    nodes: [0, 0],
    generation: 0,
  }
  const dupSession = visibleSession('t6a-count-dup', dup)
  assert.equal(createCountPredicate({ of: 'tool-result', min: 2 })(dupSession), false, '同一 seq 占两个位置也只算一条 tool/result')
  assert.equal(createCountPredicate({ of: 'tool-call', min: 2 })(dupSession), true, 'log-only 读完整历史：nodes 重复不改变 tool/call 计数')

  // 代次不可见（surface 只给 nodes）时，成功压缩那条 durable 事件是**唯一**复位信号：
  // 条目按即将被遮蔽的消息累加过，必须在它到达时作废、下次求值重建。
  const bareState = {
    log: [
      { type: 'user/message', seq: 0, data: { message: {} } },
      { type: 'user/message', seq: 1, data: { message: {} } },
    ],
    nodes: [0, 1],
  }
  const bareSession = {
    id: 't6a-count-bare',
    header: {},
    snapshotEvents: () => bareState.log,
    surface: { get nodes() { return bareState.nodes } },
  }
  const bareUsers = createCountPredicate({ of: 'user-message', min: 2 })
  assert.equal(bareUsers(bareSession), true, '建条目：可见 2 条 user/message')
  bareState.log.push(
    { type: 'compaction/summary', seq: 2, data: {} },
    { type: 'user/message', seq: 3, data: { message: {} } },
    { type: 'compaction/end', seq: 4, data: {} },
  )
  bareState.nodes = [3]
  for (const event of bareState.log.slice(2)) bareUsers.observe(bareSession, event)
  assert.equal(bareUsers(bareSession), false, '压缩事件清条目后重建：可见的只剩替身那 1 条')
})

test('T36①：压缩遮蔽原首条推理后，锚定记忆随之作废（同一会话改判，不再被旧值钉住）', () => {
  const state = {
    log: [
      { type: 'assistant/message', seq: 0, data: { message: { content: [{ type: 'reasoning', text: 'We start.' }] } } },
      { type: 'compaction/end', seq: 1, data: {} },
      { type: 'assistant/message', seq: 2, data: { message: { content: [{ type: 'text', text: 'AFTER' }] } } },
    ],
    nodes: [0],
  }
  // 会话对象只造一次：判定读的是它的 `surface.nodes` 现场快照，换对象就变成另一个会话、测不到缓存。
  const session = { id: 't36-anchor', header: {}, snapshotEvents: () => state.log, surface: { get nodes() { return state.nodes } } }
  const predicate = createAnchorPredicate({ keys: ['We'] })
  assert.equal(predicate(session), true, '可见首条 assistant 推理带锚定词 → 确认并入记忆')
  assert.equal(predicate(session), true, '记忆命中给出同一结论')
  // 成功压缩遮蔽那条推理：可见首条换成 seq 2 的正文，宿主在 session/event 上通知压缩结束。
  state.nodes = [2]
  predicate.observe(session, { type: 'compaction/end', seq: 3, data: {} })
  assert.equal(predicate(session), false, '压缩后记忆作废，按新的可见首条重判（全量日志仍能数到那条推理）')
})

test('T36②：消息类信号 + per:turn —— 增量 observe 与冷启动重建同结论', () => {
  const state = {
    log: [
      { type: 'assistant/message', seq: 0, data: { turn: 0, message: { content: [{ type: 'text', text: 'A' }] } } },
      { type: 'turn/start', seq: 1, data: { turn: 1 } },
    ],
    nodes: [0],
  }
  const cold = createCountPredicate({ of: 'assistant-message', per: 'turn', min: 1 })
  assert.equal(cold(visibleSession('t36-count-cold', state)), true, '冷启动重建：可见的当前轮只有 seq 0 那条')
  const incremental = createCountPredicate({ of: 'assistant-message', per: 'turn', min: 1 })
  const session = { id: 't36-count-incremental', header: {}, snapshotEvents: () => state.log, surface: { get nodes() { return state.nodes } } }
  assert.equal(incremental(session), true, '先冷启动建条目')
  incremental.observe(session, state.log[1])
  assert.equal(incremental(session), true, '`turn/start` 不是 surface 承载类型：增量不拿它推进当前轮，与重建同结论')
})

test('T36③：无 id 的消息在重复 seq 下只计一次（chat.length 不虚高）', () => {
  // 位置替换后同一事件占 `nodes` 里两个位置，又因为消息没有 `id` 而躲过既有的按 id 去重。
  const state = {
    log: [{ type: 'user/message', seq: 0, data: { message: { role: 'user', content: [{ type: 'text', text: 'HI' }] } } }],
    nodes: [0, 0],
  }
  const session = { id: 't36-chat', header: {}, snapshotEvents: () => state.log, surface: { get nodes() { return state.nodes } } }
  assert.equal(stChatMessages(session).length, 1, '同一 seq 占两个位置只算一条：它驱动 delay / sticky 窗口与概率 generation')
})

/**
 * A1①：锚定记忆的失效判据必须与它读的视图同源。非压缩的位置替换（区域编辑 / 手动裁剪 /
 * 插件重写）没有 `compaction/end` 可观察，只推进 surface 的 `replaceGeneration`——记忆若只看
 * 压缩事件，旧结论就被钉在一次已经不在眼前的上下文上。真值源：`visibleSession` 桩里
 * `nodes` / `replaceGeneration` 与宿主 `foldSurface` 同语义（只 replace 换节点、推代次）。
 */
test('A1①：非压缩的位置替换推进代次后，锚定记忆随之作废（兜底轮数按新上下文重数）', () => {
  const state = {
    log: [
      { type: 'assistant/message', seq: 0, data: { message: { content: [{ type: 'reasoning', text: 'We start.' }] } } },
      { type: 'assistant/message', seq: 1, data: { message: { content: [{ type: 'text', text: 'AFTER' }] } } },
    ],
    nodes: [0],
    generation: 0,
  }
  const session = visibleSession('a1-anchor-replace', state)
  const predicate = createAnchorPredicate({ keys: ['We'], fallbackAfter: 1 })
  assert.equal(predicate(session), true, '可见首条 assistant 推理带锚定词 → 确认并入记忆')
  // 位置替换把那条推理移出可见节点，代次 +1，**没有** compaction/end 事件。替代品只有一条
  // 可见 assistant 消息（fallbackAfter=1 → 要 2 条才兜底），所以正确结论是 false。
  state.nodes = [1]
  state.generation = 1
  assert.equal(predicate(session), false, '代次推进即失效：按新可见上下文重判，不被旧确认钉住')
  assert.equal(predicate(session), createAnchorPredicate({ keys: ['We'], fallbackAfter: 1 })(session), '与重构谓词同结果')
})

/**
 * A1②：`observe` 的过滤条件必须与 `currentEvents` 的降级判据同源。视图**没有**受限时
 * （缺 surface / `nodes` 非数组 / 节点越界）消息类信号读的也是完整历史，`turn/start` 看得见；
 * 再把它滤掉，增量路径的当前轮就停在旧值（T36② 的同一处破口，只是换到降级宿主上）。
 */
test('A1②：视图未受限时，消息类信号的增量不滤 log-only 事件（与冷启动同结论）', () => {
  const events = []
  // 建条目时日志还是空的：后续只能靠增量推进，重建路径帮不上忙（条目住在状态里、真相在事件流里）。
  // 陷阱：`observe` **只喂已建过条目的会话**，先 observe 后首次求值等于什么都没喂（首次求值冷扫重建），
  // 断言会假绿——所以下面一律「先求值建条目，再 observe」。
  const build = (session) => {
    const predicate = createCountPredicate({ of: 'assistant-message', per: 'turn', min: 1 })
    assert.equal(predicate(session), false, '建条目：当前轮还没有可见 assistant 消息')
    return predicate
  }
  const turnStart = { type: 'turn/start', seq: 0, data: { turn: 1 } }
  const previousTurn = { type: 'assistant/message', seq: 1, data: { turn: 0, message: { content: [{ type: 'text', text: 'A' }] } } }
  // 无 surface：视图退回完整历史，`turn/start` 必须照常把增量的当前轮推到 1。
  const noSurface = { id: 'a1-count-degraded', header: {}, snapshotEvents: () => events }
  const incremental = build(noSurface)
  events.push(turnStart, previousTurn)
  for (const event of events) incremental.observe(noSurface, event)
  assert.equal(incremental(noSurface), false, '增量拿 `turn/start` 推进到 turn 1，带 turn 0 的那条不算当前轮')
  assert.equal(incremental(noSurface), createCountPredicate({ of: 'assistant-message', per: 'turn', min: 1 })(noSurface), '降级视图下「冷启动 == 增量」不得再被破坏')

  // `nodes` 非数组同样是降级：过滤只服务于**真正受限**的视图，不是「有 surface 就滤」。
  const shape = { nodes: 'not-an-array' }
  const flatSession = { id: 'a1-count-flat-nodes', header: {}, snapshotEvents: () => events, surface: shape }
  const flat = build(flatSession)
  for (const event of events) flat.observe(flatSession, event)
  assert.equal(flat(flatSession), false, '`nodes` 非数组 = 退回完整历史，`turn/start` 照收')
})

/**
 * A1④：`viewRestricted` 的边界——空 `nodes` 是「当前上下文为空」，**不是**降级。`currentEvents`
 * 与 count 的过滤读同一份判据，所以两边的答案必须都是「受限」：消息类信号计数 0、视图为空数组。
 */
test('A1④：空 nodes 是受限的空上下文，不是降级（count 与 currentEvents 同判据）', () => {
  const events = [
    { type: 'tool/result', seq: 0, data: { message: {} } },
    { type: 'tool/result', seq: 1, data: { message: {} } },
  ]
  const session = { id: 'a1-count-empty-nodes', header: {}, snapshotEvents: () => events, surface: { nodes: [] } }
  assert.equal(viewRestricted(session), true, '空 nodes：surface 在场且没有越界节点 → 受限')
  assert.deepEqual(currentEvents(session), [], '受限的空上下文：不退回完整历史')
  assert.equal(createCountPredicate({ of: 'tool-result', min: 1 })(session), false, '消息类信号按当前上下文计 = 0（完整历史里那 2 条不算）')
})

/**
 * A1③：压缩复位只对**消息类**信号生效——log-only 信号的重建读 `historyEvents`，压缩不改变它，
 * 复位只会多制造一次「结果完全相同」的重建。真值源：`snapshotEvents` 的读次数（重建的唯一入口）。
 */
test('A1③：压缩复位不落在 log-only 信号上（重建读完整历史，压缩不改变它）', () => {
  let reads = 0
  const logReads = () => { reads += 1; return log }
  const log = [
    { type: 'tool/call', seq: 0, data: {} },
    { type: 'tool/call', seq: 1, data: {} },
  ]
  const session = { id: 'a1-count-log-only', header: {}, snapshotEvents: logReads }
  const calls = createCountPredicate({ of: 'tool-call', min: 2 })
  assert.equal(calls(session), true, '冷扫建条目：完整历史里 2 次 tool/call')
  reads = 0
  calls.observe(session, { type: 'compaction/end', seq: 2, data: {} })
  calls.observe(session, { type: 'tool/call', seq: 3, data: {} })
  assert.equal(calls(session), true, '计数不含压缩事件，仍按完整历史增量累积')
  // 陷阱：复位只在**下次求值**重建，读数必须放在求值**之后**——放在 observe 之后就永远读到 0，
  // 条目被压缩清掉也不红（这条断言初版正是这样假绿的）。
  assert.equal(reads, 0, 'log-only 信号：压缩不复位、增量照收 → 一次快照都不读')
})

test('T36④：从种子出发把 decision 改成 deny，空串 reason 回退引擎缺省原因', async () => {
  const h = harness()
  const seed = structuredClone(ACTION_EXAMPLES.decision)
  assert.equal(seed.reason, '', '种子里的中性值就是空串（T31 的「不替用户选业务值」）')
  const rules = compileRules([{ id: 'deny', then: [{ ...seed, id: 'denied', kind: 'decision', decision: 'deny' }] }])
  const dispose = mountRuleSources(h.ctx, [{ moduleId: 'module', rules }])
  const outcome = await h.run('tools/pre-execute', [{ agent: actor(), name: 'bash' }], () => ({ kind: 'allow' }))
  assert.equal(outcome.kind, 'deny')
  assert.equal(outcome.reason, 'denied: denied by action', '空串是「取引擎缺省」，不是「抑制默认原因」')
  dispose()
})
