import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import { compileRules, getRuleEditorMeta } from '../../engine/rule-spec.mjs'
import { registerAction } from '../../engine/actions/index.mjs'
import { createRuleRuntime, mountRuleSources } from '../../engine/rule-runtime.mjs'
import { ruleFrame, ruleMatches } from '../../engine/conditions/evaluation.mjs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const systemPromptRequire = createRequire(require.resolve('@deepseek-ai/dsh-system-prompt'))
const hostPlugin = async name => (await import(pathToFileURL(systemPromptRequire.resolve(name)).href)).default

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
  assert.doesNotThrow(() => compileRules([{ ...a, groupScope: 'cross-module' }, { ...b, groupScope: 'cross-module' }]))
  assert.throws(() => compileRules([{ ...a, groupScope: 'invalid' }]), /groupScope/)
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
  await root.plugin(await hostPlugin('@deepseek-ai/dsh-session'))
  await root.plugin(SessionProjections)
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

test('章节按画布跨档排序，同名贡献独立投递且规则按原名匹配', async t => {
  const root = new Context()
  await root.plugin(await hostPlugin('@deepseek-ai/dsh-session'))
  await root.plugin(SessionProjections)
  await root.plugin(SystemPrompt, { includeHarnessIdentity: false })
  t.after(() => root.fiber.dispose())
  const outside = [{ name: 'external', order: 10, text: 'EXTERNAL' },
    { name: 'same', order: 20, text: 'ORIGINAL' }, { name: 'remove-me', order: 30, text: 'OLD' }]
  for (const section of outside) root.systemPrompt.section(section)
  const inject = (id, order) => ({ id, kind: 'inject-text', config: { layer: 'system-section', order, text: id } })
  const assembly = (id, sections) => ({ id, kind: 'assembly', target: { sections } })
  const rules = (duplicates, order = { late: 0, early: 10, add: 20, edit: 30 }) => compileRules([
    { id: 'late', then: [inject('LATE', 30)] },
    { id: 'early', then: [inject('EARLY', 0)] },
    { id: 'add', then: [assembly('add', { remove: ['remove-me'], add: [...duplicates, { name: 'remove-me', text: 'NEW', id: 'replacement' }] })] },
    { id: 'edit', then: [assembly('edit', { replace: [{ name: 'same', text: 'REPLACED' }], add: [{ name: 'same', text: 'SECOND' }], append: [{ name: 'same', text: 'APPENDED' }] })] },
  ], { configOrder: order })
  const runtime = createRuleRuntime(root)
  t.after(() => runtime.dispose())
  const first = { name: 'same', text: 'FIRST' }, automatic = { name: 'same', text: 'AUTO' }
  runtime.replace([{ moduleId: 'sections', rules: rules([first, automatic]) }])
  const { sections } = await root.systemPrompt.assemble({})
  assert.deepEqual(sections.filter(section => section.text).map(section => section.text),
    ['LATE', 'EXTERNAL', 'REPLACED\nAPPENDED', 'EARLY', 'FIRST', 'AUTO', 'NEW', 'SECOND'])
  assert.equal(sections.find(section => section.text.includes('REPLACED')).name, 'same')
  assert.equal(new Set(sections.map(section => section.name)).size, sections.length)
  assert.deepEqual(outside.map(section => section.order), [10, 20, 30])
  const nameOf = (list, text) => list.find(section => section.text === text).name
  runtime.replace([{ moduleId: 'sections', rules: rules([automatic, { ...first, text: 'UPDATED' }], { early: 0, late: 10, add: 20, edit: 30 }) }])
  const updated = (await root.systemPrompt.assemble({})).sections
  assert.equal(nameOf(updated, 'AUTO'), nameOf(sections, 'AUTO'))
  assert.equal(nameOf(updated, 'UPDATED'), nameOf(sections, 'FIRST'))
  assert.equal(nameOf(updated, 'LATE'), nameOf(sections, 'LATE'), '画布移位保留投递身份')
  runtime.replace([{ moduleId: 'sections', rules: rules([automatic]) }])
  assert.equal(nameOf((await root.systemPrompt.assemble({})).sections, 'AUTO'), nameOf(sections, 'AUTO'))
  const taken = nameOf(sections, 'NEW')
  const release = root.systemPrompt.section({ name: taken, text: 'THIRD-PARTY', order: 0 })
  const collision = (await root.systemPrompt.assemble({})).sections
  assert.equal(nameOf(collision, 'THIRD-PARTY'), taken)
  assert.notEqual(nameOf(collision, 'NEW'), taken)
  release()
  assert.equal(nameOf((await root.systemPrompt.assemble({})).sections, 'NEW'), nameOf(collision, 'NEW'))
  assert.throws(() => rules([{ ...first, id: 'duplicate' }, { ...automatic, id: 'duplicate' }]), /duplicate assembly.sections.add id/)
})

test('独立装配动作按原名组合并在解除后撤回', async t => {
  const root = new Context()
  await root.plugin(SessionProjections)
  await root.plugin(SystemPrompt, { includeHarnessIdentity: false })
  t.after(() => root.fiber.dispose())
  const { Session } = await import(pathToFileURL(systemPromptRequire.resolve('@deepseek-ai/dsh-session')).href)
  const session = Session.create('standalone-sections')
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  registerAction(root, { kind: 'assembly', id: 'append', target: { sections: { append: [{ name: 'brief', text: 'APPEND' }] } } })
  const off = registerAction(root, { kind: 'assembly', id: 'add', target: { sections: { add: [{ name: 'brief', text: 'BODY' }] } } })
  const assembly = await root.systemPrompt.assemble({ session })
  const section = assembly.sections.find(entry => entry.text.startsWith('BODY'))
  assert.equal(section.text, 'BODY\nAPPEND')
  for (const { message, intent } of assembly.systemUpdates(false)) session.append('system/message', { turn: 1, step: 1, message }, intent)
  off()
  const closed = await root.systemPrompt.assemble({ session })
  assert.ok(closed.systemUpdates(false).some(({ message }) => message.source.sections.some(entry => entry.name === section.name)))
  for (const [removed, actionId] of [['ONE', undefined], ['TWO', undefined], ['ONE', 'same-action'], ['TWO', 'same-action']]) {
    const target = Session.create((actionId ?? 'anonymous') + '-' + removed)
    target.append('turn/start', { turn: 1 })
    target.append('step/start', { turn: 1, step: 1 })
    const offs = new Map(['ONE', 'TWO'].map(text => [text, registerAction(root,
      { kind: 'assembly', id: actionId, target: { sections: { add: [{ name: 'same', text, id: 'local' }] } } })]))
    const assemble = () => root.systemPrompt.assemble({ session: target })
    const first = await assemble()
    const names = new Map(first.sections.filter(entry => offs.has(entry.text)).map(entry => [entry.text, entry.name]))
    assert.equal(new Set(names.values()).size, 2)
    for (const { message, intent } of first.systemUpdates(false)) target.append('system/message', { turn: 1, step: 1, message }, intent)
    for (let round = 0; round < 3; round++) assert.deepEqual((await assemble()).systemUpdates(false), [])
    offs.get(removed)()
    const survivor = removed === 'ONE' ? 'TWO' : 'ONE'
    const next = await assemble()
    assert.equal(next.sections.find(entry => entry.text === survivor).name, names.get(survivor))
    assert.ok(next.systemUpdates(false).some(({ message }) => message.source.sections.some(entry =>
      entry.name === names.get(removed) && message.content[entry.contentIndex].text === '')))
    offs.get(survivor)()
  }
  for (const standaloneAdds of [true, false]) {
    const compiled = createRuleRuntime(root)
    const add = { id: 'mix-add', kind: 'assembly', target: { sections: { add: [{ name: 'mixed', text: 'MIXED' }] } } }
    const append = { id: 'mix-tail', kind: 'assembly', target: { sections: { append: [{ name: 'mixed', text: 'TAIL' }] } } }
    compiled.replace([{ moduleId: 'mixed', rules: compileRules([{ id: 'mixed', then: [standaloneAdds ? { ...append, waterfallPosition: 'outermost' } : add] }]) }])
    const release = registerAction(root, standaloneAdds ? add : append, { prepend: !standaloneAdds })
    try { assert.ok((await root.systemPrompt.assemble({})).sections.some(entry => entry.text === 'MIXED\nTAIL')) }
    finally { release(); compiled.dispose() }
  }
})

test('冷恢复以原声明识别经宿主插值的同名章节', async t => {
  const previousHome = process.env.DSH_HOME
  const home = mkdtempSync(join(tmpdir(), 'pt-section-'))
  process.env.DSH_HOME = home
  t.after(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  })
  const runtime = async () => {
    const root = new Context()
    await root.plugin(await hostPlugin('@deepseek-ai/dsh-session'))
    await root.plugin(SessionProjections)
    await root.plugin(SystemPrompt, { includeHarnessIdentity: false })
    const rules = createRuleRuntime(root)
    t.after(async () => { rules.dispose(); await root.fiber.dispose() })
    return { root, rules }
  }
  const source = texts => [{ moduleId: 'authored', rules: compileRules([{ id: 'added', then: [
    { kind: 'assembly', id: 'add', target: { sections: { add: texts.map(text => ({ name: 'brief', text })) } } },
    { kind: 'assembly', id: 'append', target: { sections: { append: [{ name: 'brief', text: 'APPEND' }] } } },
  ] }]) }]
  const first = await runtime()
  const session = first.root.sessions.create('cold-sections')
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  first.root.systemPrompt.variable('model', () => 'FIRST')
  first.rules.replace(source(['A {{model}}', 'B {{model}}']))
  const admitted = await first.root.systemPrompt.assemble({ session })
  const original = admitted.sections.find(entry => entry.text.startsWith('B ')).name
  const directory = join(home, '.prompt-tool', 'section-admissions')
  const updates = admitted.systemUpdates(false)
  assert.equal(existsSync(directory), false, '未提交的装配不写身份映射')
  for (const { message, intent } of updates) session.append('system/message', { turn: 1, step: 1, message }, intent)
  assert.equal(readdirSync(directory).length, 1)
  assert.deepEqual((await first.root.systemPrompt.assemble({ session })).systemUpdates(false), [])
  assert.equal(readdirSync(directory).length, 1)
  const second = await runtime()
  second.root.systemPrompt.variable('model', () => 'SECOND')
  second.rules.replace(source(['B {{model}}']))
  const { Session } = await import(pathToFileURL(systemPromptRequire.resolve('@deepseek-ai/dsh-session')).href)
  const restored = Session.create(session.id, session.snapshotEvents(), session.header, session.inheritedEventCount)
  const assembled = await second.root.systemPrompt.assemble({ session: restored })
  assert.equal(assembled.sections.find(entry => entry.text.startsWith('B ')).name, original)
  const fork = first.root.sessions.fork(session.id, undefined, 'cold-fork')
  const forked = await second.root.systemPrompt.assemble({ session: fork })
  assert.equal(forked.sections.find(entry => entry.text.startsWith('B ')).name, original)
})

test('统一规则：缺失真实会话的 not 保持未知，any 中已知 true 分支仍能执行', async () => {
  const unknown = [{ scope: { audience: 'main' } }, { phase: { promoted: false } }, { session: { type: 'user/message', present: true } }]
  for (const when of [...unknown.map(node => ({ not: node })), { notAny: unknown }, { any: [{ not: unknown[0] }, { scope: { modelScope: 'all' } }] }]) {
    const h = harness()
    const rules = compileRules([{ id: 'missing-context', if: when, then: [
      { id: 'stream', kind: 'stream-output', text: 'REPLACED', mode: 'replace' },
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

test('T15：dedupe=session 从已投递历史恢复，后续请求仍保持去重', async () => {
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
  agent.session.snapshotEvents = () => events
  const step = async () => {
    const decision = await h.run('agent/pre-step', [{ agent }], () => ({
      kind: 'enter', messages: [{ id: 'u', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'USER' }] }],
    }))
    return { texts: decision.messages.flatMap(message => message.content.map(block => block.text)) }
  }
  const first = await step()
  assert.deepEqual(first.texts, ['SIBLING', 'USER'], '整表命中已投递的那条 → 不注入；同位置兄弟照常')
  const second = await step()
  assert.deepEqual(second.texts, first.texts, '第二步的注入层、次数与同位置兄弟都不变')
  dispose()
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

test('规则来源挂载失败携带模块身份，并撤回此前的段、变量和订阅', () => {
  const registrations = new Set()
  const rejection = new Error('宿主拒绝第二个规则段')
  let sections = 0
  const register = (name) => { registrations.add(name); return () => registrations.delete(name) }
  const h = harness({ systemPrompt: {
    variable: name => register(name),
    section: ({ name }) => { if (++sections === 2) throw rejection; return register(name) },
  } })
  const sources = ['a-healthy', 'z-broken'].map(moduleId => ({ moduleId, rules: compileRules([
    { id: `${moduleId}-rule`, then: [textAction(`${moduleId}-text`, 'BODY', { layer: 'system-section' })] },
  ], { moduleId }) }))
  assert.throws(() => mountRuleSources(h.ctx, sources), error => {
    assert.equal(error.sourceModuleId, 'z-broken')
    assert.equal(error.message, rejection.message)
    assert.equal(error.cause, rejection)
    return true
  })
  assert.equal(registrations.size, 0, '已取得的官方段和占位变量全部撤回')
  assert.ok([...h.events.values()].every(list => list.length === 0), '自建晋升池和规则订阅全部撤回')

  const shared = harness()
  const on = shared.ctx.on
  let subscriptions = 0
  shared.ctx.on = (...args) => {
    if (args[0] === 'session/event' && ++subscriptions === 2) throw rejection
    return on(...args)
  }
  const observed = compileRules([{ id: 'count', if: { count: { of: 'tool-call', min: 1 } }, then: [textAction('count-text', 'BODY')] }])
  assert.throws(() => mountRuleSources(shared.ctx, [{ moduleId: 'observed', rules: observed }]), error => {
    assert.equal(error, rejection, '公共观察订阅失败保留原错误，不猜测某个模块')
    assert.equal(error.sourceModuleId, undefined)
    return true
  })
  assert.ok([...shared.events.values()].every(list => list.length === 0), '观察订阅失败也撤回此前自建池的订阅')
})

test('variablesEnabled=false 停止读取持久变量：内建与空占位保留，同批其他模块照常', async () => {
  // 真值源：同一份声明（owner=MODULE），只有顶层开关不同——两模块同批（各自来源）注入，
  // 差异只能来自开关：停用模块不读取持久快照，启用模块读取当前值。
  const module = variablesEnabled => compileRules([{ id: 'vars', then: [
    textAction('vars-text', 'owner={{owner}} other={{other}} home={{DSH_HOME}}', { position: 'after-all' }),
  ] }], { variables: { owner: 'MODULE' }, variablesEnabled })
  const h = harness()
  const dispose = mountRuleSources(h.ctx, [
    { moduleId: 'off-module', rules: module(false) },
    { moduleId: 'on-module', rules: module(true) },
  ], { variableStore: { read: () => ({ module: { owner: 'CURRENT' }, global: { other: 'OTHER' }, effective: { owner: 'CURRENT', other: 'OTHER' } }) } })
  const agent = actor()
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
    'owner=CURRENT other=OTHER home=<resolved>',
  ], '停用模块不读取变量，启用模块使用 adapter 的当前快照')
})

test('动作声明白名单：未知键、对象形态 match 与带 kind 的分支节点编译期拒绝', () => {
  // 拼错字段在编译期拒绝，不能静默扩大工具裁决范围。
  assert.throws(() => compileRules([{ id: 'gate', then: [
    { id: 'deny', kind: 'tool-gate', decision: 'deny', toolName: 'read' },
  ] }]), /action deny: unknown config key\(s\) toolName — allowed keys: .*reason/)
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
  // 关键拒绝：inject-text.config 的未知键（同一份提示词配置白名单）。
  assert.throws(() => compileRules([{ id: 'r', then: [textAction('a', 'A', { typoKey: 1 })] }]),
    /action a config: unknown config key\(s\) typoKey — allowed keys: .*text/)
  // 关键拒绝：prepend 是未文档化的注册后门，动作层与 config 层都取消且无等价替代。
  assert.throws(() => compileRules([{ id: 'r', then: [
    { id: 'a', kind: 'assembly', prepend: true, target: { sections: { remove: ['x'] } } },
  ] }]), /`prepend` 已取消.*waterfallPosition: outermost/)
  assert.throws(() => compileRules([{ id: 'r', then: [textAction('a', 'A', { prepend: true })] }]),
    /`prepend` 已取消.*waterfallPosition: outermost/)
  // 关键拒绝：动作级 match 出现即拒——函数形态过不了 structuredClone（DataCloneError），
  // 对象/字符串形态恒命中，三种都指回规则级 `if`（声明路径写不了函数）。
  for (const value of [() => true, 'x', { keys: ['x'] }]) {
    assert.throws(() => compileRules([{ id: 'strip', then: [
      { id: 'a', kind: 'assembly', match: value, target: { sections: { remove: ['x'] } } },
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
    const node = { id: 'a', kind: 'tool-gate', decision: 'deny', [key]: key === 'if' ? { scope: { audience: 'main' } } : [] }
    assert.throws(() => compileRules([{ id: 'g', then: [node] }]), /action a 写了 .*分支必须写成无 `kind` 的节点/)
  }
})
