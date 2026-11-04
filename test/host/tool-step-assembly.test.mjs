import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createScope, scopeTarget } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import * as native from '@deepseek-ai/dsh-tool-executor-native'
import * as ptc from '@deepseek-ai/dsh-tool-executor-ptc'
import { apply as applyCustomTools } from '../../engine/tool-config-engine.mjs'
import { sdkToolNames } from '../../engine/sdk-strip.mjs'
import { compileRules } from '../../engine/rule-spec.mjs'
import { mountRuleSources } from '../../engine/rule-runtime.mjs'
import { createDiscoveryRegistry } from '../../engine/discovery.mjs'
import { isolatedHome } from '../fixtures/host-harness.mjs'

const { moduleRoot } = isolatedHome('pt-tool-step-')
const { createAgentAssembly } = await import('../../src/runtime/agent-assembly.ts')

async function harness(t, rules = [{ id: 'narrow', then: [{ id: 'allow', kind: 'tool-visibility', allow: ['keep'] }] }], modules = ['rule-engine']) {
  const root = new Context()
  await root.plugin(SystemPrompt)
  await root.plugin(Tools)
  await root.plugin(native)
  const rawTools = root.get('tools')
  root.provide('llm', {})
  root.provide('promptToolDiscovery', createDiscoveryRegistry())
  const agents = []
  root.provide('agents', { list: () => agents })
  const id = 'step-surface'
  mkdirSync(join(moduleRoot, id), { recursive: true })
  const write = (rows = modules) => writeFileSync(join(moduleRoot, id, 'module.yml'), JSON.stringify({ id, name: id, modules: rows, rules }))
  write()
  const warnings = []
  const runtime = createAgentAssembly(root, { moduleRoot, enabledModules: () => [id], warn: error => warnings.push(String(error)) })
  t.after(async () => { await runtime.dispose(); await root.fiber.dispose() })
  const agent = { id: 'step-agent', options: { model: 'next' }, model: { current: () => ({ model: 'next' }) },
    session: { id: 'step-agent', header: {}, snapshotEvents: () => [], append() {} } }
  agent.ctx = createScope(root, agent).ctx
  agents.push(agent)
  await root.serial(scopeTarget(agent, agent), 'agent/created', { agent, source: 'startup' })
  let calls = 0, conditions = 0
  const registrations = new Map()
  for (const name of ['keep', 'hidden', 'unavailable']) registrations.set(name, root.tools.register({ name, description: name,
    parameters: { type: 'object', properties: {} }, output: { schema: { type: 'object' }, render: () => [] },
    execute: () => { calls++; return { name } },
  }, { when: () => { conditions++; return name !== 'unavailable' } }))
  let services
  await agent.ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(ctx) { services = { tools: ctx.tools, prompt: ctx.systemPrompt } } })
  const signal = new AbortController().signal
  const context = { agent, scope: agent, signal, modelSelection: { model: 'deepseek-pro' } }
  const execute = (toolSet, name = 'keep', tools = services.tools) => tools.execute({ agent, signal, toolSet,
    calls: [{ type: 'tool-call', id: 'call', name, arguments: '{}' }],
  })
  return { root, rawTools, runtime, agent, services, context, execute, write, warnings, registrations, counts: () => ({ calls, conditions }) }
}

test('公开 resolve/assemble 后置收窄最终声明与实际执行，官方 when 只算一次', async t => {
  const h = await harness(t)
  h.root.provide('pt-module-rule-tools', { mount: ctx => ctx.tools.register({ name: 'fresh', description: 'fresh',
    parameters: { type: 'object', properties: {} }, output: { schema: { type: 'object' }, render: () => [] }, execute: () => ({}),
  }) })
  h.write(['rule-engine', 'module-rule-tools'])
  h.runtime.schedule('step-surface')
  const toolSet = await h.services.tools.resolve(h.context)
  assert.equal(toolSet.view(h.agent).has('fresh'), true, `ensureFresh 在原 resolve 前挂载新增定义: ${h.warnings}`)
  const result = await h.services.prompt.assemble({ ...h.context, toolSet })
  assert.deepEqual(result.tools.map(tool => tool.name), ['keep'])
  assert.deepEqual((await h.execute(toolSet)).results[0].result.value, { name: 'keep' })
  assert.equal((await h.execute(toolSet, 'hidden')).results[0].result.isError, true)
  assert.equal((await h.execute(toolSet, 'unavailable')).results[0].result.isError, true)
  assert.deepEqual(h.counts(), { calls: 1, conditions: 3 })
  const off = h.root.tools.register({ name: 'replacement', description: 'replacement', parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'object' }, render: () => [] }, execute: () => ({}),
  })
  assert.equal(toolSet.view(h.agent).has('replacement'), false, '封存不添加新注册')
  off()
  h.registrations.get('keep')()
  assert.equal(toolSet.view(h.agent).has('keep'), false, '原集合移除始终是封存准入的上限')
  assert.equal((await h.execute(toolSet)).results[0].result.isError, true)
  assert.equal(h.counts().calls, 1)
  toolSet.dispose()
})

test('pending 拒绝公开批次和原服务 guard，失败或取消关闭一次，重试复用封存快照', async t => {
  const h = await harness(t)
  const resolve = h.rawTools.resolve
  let released = 0, original
  t.mock.method(h.rawTools, 'resolve', async function (context) {
    const selected = await resolve.call(this, context)
    original = { view: scope => selected.view(scope), dispose: () => { released++; selected.dispose() } }
    return original
  })
  const toolSet = await h.services.tools.resolve(h.context)
  assert.deepEqual(Object.keys(toolSet).sort(), ['dispose', 'view'])
  assert.deepEqual([...toolSet.view(h.agent).keys()].sort(), ['hidden', 'keep'])
  await assert.rejects(h.execute(toolSet), { code: 'TOOL_STEP_UNAVAILABLE' })
  assert.equal((await h.execute(original, 'keep', h.rawTools)).results[0].result.isError, true)
  assert.equal(h.counts().calls, 0)
  let presentations = 0
  const off = h.root.on('system-prompt/assemble', async (_assembly, _context, next) => { presentations++; return next() })
  const first = await h.services.prompt.assemble({ ...h.context, toolSet })
  h.context.modelSelection.model = 'deepseek-flash'
  assert.equal(await h.services.prompt.assemble({ ...h.context, toolSet: original }), first)
  assert.equal(presentations, 1)
  assert.deepEqual((await h.execute(toolSet)).results[0].result.value, { name: 'keep' })
  const outsider = { id: 'outsider', session: { header: {} } }
  outsider.ctx = createScope(h.root, outsider).ctx
  await assert.rejects(h.services.tools.execute({ agent: outsider, toolSet, signal: h.context.signal,
    calls: [{ type: 'tool-call', id: 'foreign', name: 'keep', arguments: '{}' }],
  }), { code: 'TOOL_STEP_UNAVAILABLE' })
  assert.equal((await h.rawTools.execute({ agent: outsider, toolSet: original, signal: h.context.signal,
    calls: [{ type: 'tool-call', id: 'foreign-raw', name: 'keep', arguments: '{}' }],
  })).results[0].result.isError, true)
  assert.equal(h.counts().calls, 1)
  toolSet.dispose(); toolSet.dispose()
  assert.equal(released, 1)
  await assert.rejects(h.services.prompt.assemble({ ...h.context, toolSet }), { code: 'TOOL_STEP_UNAVAILABLE' })
  off()
  const failed = await h.services.tools.resolve(h.context)
  const fail = h.root.on('system-prompt/assemble', () => { throw new Error('assembly failed') })
  await assert.rejects(h.services.prompt.assemble({ ...h.context, toolSet: failed }), /assembly failed/)
  failed.dispose()
  assert.equal(released, 2)
  assert.equal(failed.view(h.agent).size, 0)
  await assert.rejects(h.execute(failed), { code: 'TOOL_STEP_UNAVAILABLE' })
  fail()
  const cancelled = await h.services.tools.resolve(h.context)
  const abort = new AbortController()
  const cancel = h.root.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembled = await next()
    abort.abort()
    return assembled
  })
  await assert.rejects(h.services.prompt.assemble({ ...h.context, signal: abort.signal, toolSet: cancelled }), { name: 'AbortError' })
  cancelled.dispose()
  assert.equal(released, 3)
  cancel()
  const closing = await h.services.tools.resolve(h.context)
  const closeDuringAssembly = h.root.on('system-prompt/assemble', async (_assembly, _context, next) => {
    closing.dispose()
    return next()
  })
  await assert.rejects(h.services.prompt.assemble({ ...h.context, toolSet: closing }), { code: 'TOOL_STEP_UNAVAILABLE' })
  closing.dispose()
  assert.equal(released, 4)
  closeDuringAssembly()
  const originalResolve = h.rawTools.resolve
  const same = await h.services.tools.resolve(h.context)
  t.mock.method(h.rawTools, 'resolve', async () => same)
  assert.equal(await h.services.tools.resolve(h.context), same, '重复包装保持同一集合身份')
  t.mock.method(h.rawTools, 'resolve', originalResolve)
  same.dispose()
  assert.equal(released, 5)
})

test('PTC 原服务持有原或包装集合时，pending、失败和卸载均不启动程序，重挂恢复', async t => {
  const h = await harness(t)
  let runs = 0, original
  h.root.provide('workingDirectory', { ensure: async () => process.cwd() })
  h.root.provide('ptcRuntime', { language: 'typescript', resolve: spec => spec, release() {}, run: async spec => {
    runs++
    const Program = Object.getPrototypeOf(async function () {}).constructor
    return { logs: [], value: await new Program('tools', spec.program)(spec.bindings[0].functions) }
  } })
  await h.agent.ctx.plugin(ptc)
  const resolve = h.rawTools.resolve
  t.mock.method(h.rawTools, 'resolve', async function (context) {
    original = await resolve.call(this, context)
    return original
  })
  const run = async toolSet => (await h.rawTools.execute({ ...h.context, toolSet, calls: [{
    type: 'tool-call', id: 'lifecycle', name: 'run_code', arguments: JSON.stringify({ code: 'return 42', description: 'lifecycle' }),
  }] })).results[0].result
  const rejected = async (toolSet, source, expectedRuns) => {
    const results = [await run(toolSet), await run(source)]
    assert.equal(runs, expectedRuns, `拒绝步骤不能启动 PTC 程序: ${JSON.stringify(results.map(result => result.value))}`)
    assert.deepEqual(results.map(result => result.isError), [true, true])
  }
  const toolSet = await h.services.tools.resolve(h.context)
  const source = original
  await rejected(toolSet, source, 0)
  await h.services.prompt.assemble({ ...h.context, toolSet })
  assert.deepEqual((await run(toolSet)).value, { logs: [], result: 42 })
  assert.equal(runs, 1)
  const failed = await h.services.tools.resolve(h.context)
  const failedSource = original
  const fail = h.root.on('system-prompt/assemble', () => { throw new Error('assembly failed') })
  await assert.rejects(h.services.prompt.assemble({ ...h.context, toolSet: failed }), /assembly failed/)
  fail()
  await rejected(failed, failedSource, 1)
  await h.runtime.dispose()
  await h.runtime.dispose()
  assert.equal(toolSet.view(h.agent).size, 0)
  await rejected(toolSet, source, 1)
  const release = mountRuleSources(h.root, [{ moduleId: 'remount', rules: compileRules([
    { id: 'narrow', then: [{ id: 'allow', kind: 'tool-visibility', allow: ['keep'] }] },
  ]) }])
  let services
  await h.agent.ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(ctx) { services = { tools: ctx.tools, prompt: ctx.systemPrompt } } })
  const restored = await services.tools.resolve(h.context)
  await services.prompt.assemble({ ...h.context, toolSet: restored })
  assert.deepEqual((await run(restored)).value, { logs: [], result: 42 })
  assert.equal(runs, 2)
  release(); release()
  await rejected(restored, original, 2)
  await h.root.fiber.dispose()
  assert.equal(h.rawTools.checkGuards({ ...h.context, toolSet, name: 'run_code' }), undefined, 'root 释放会撤销步骤拒绝闸')
})

test('捕获模型贯穿原与包装集合的真实工具规则，裸装配不猜步骤', async t => {
  const h = await harness(t, [
    { id: 'narrow', then: [{ id: 'allow', kind: 'tool-visibility', allow: ['keep'] }] },
    { id: 'pro-gate', if: { scope: { modelScope: 'pro' } }, then: [{ id: 'deny', kind: 'tool-gate', reason: 'captured pro', decision: 'deny' }] },
  ])
  const toolSet = await h.services.tools.resolve(h.context)
  h.context.modelSelection.model = 'deepseek-flash'
  await h.services.prompt.assemble({ ...h.context, toolSet })
  assert.match((await h.execute(toolSet)).results[0].result.error.message, /captured pro/)
  assert.equal(h.counts().calls, 0)
  assert.deepEqual((await h.services.prompt.assemble({ agent: h.agent, scope: h.agent })).tools.map(tool => tool.name), ['keep'])
  const foreign = { dispose() {}, view() { return new Map() } }
  await assert.rejects(h.services.prompt.assemble({ ...h.context, toolSet: foreign }), /adapted resolve/)
  toolSet.dispose()
})

test('独立规则入口在官方返回后组合多个来源，官方准入始终是工具面的上限', async t => {
  const root = new Context()
  await root.plugin(SystemPrompt)
  await root.plugin(Tools)
  await root.plugin(native)
  root.provide('llm', {})
  t.after(() => root.fiber.dispose())
  const agent = { id: 'standalone', session: { id: 'standalone', header: {}, snapshotEvents: () => [] } }
  const preset = {}
  const presetScope = createScope(root, preset)
  agent.ctx = createScope(root, agent, { parent: preset }).ctx
  const calls = [], conditions = []
  const register = (ctx, name, accepted = true) => ctx.tools.register({ name, description: name,
    parameters: { type: 'object', properties: {} }, output: { schema: { type: 'string' }, render: () => [] },
    execute: () => { calls.push(name); return name },
  }, { when: () => { conditions.push(name); return accepted } })
  register(root, 'ancestor')
  await presetScope.ctx.plugin({ inject: ['tools'], apply(ctx) { register(ctx, 'preset') } })
  await agent.ctx.plugin({ inject: ['tools'], apply(ctx) { register(ctx, 'own'); register(ctx, 'offline', false) } })
  const releases = []
  for (const action of [
    { id: 'allow', kind: 'tool-visibility', allow: ['ancestor', 'preset', 'own', 'offline', 'missing'], requireMatch: true },
    { id: 'deny', kind: 'tool-visibility', deny: ['preset'] },
  ]) releases.push(mountRuleSources(root, [{ moduleId: action.id, rules: compileRules([{ id: action.id, then: [action] }]) }]))
  t.after(() => releases.forEach(release => release()))
  let services
  await agent.ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(ctx) { services = { tools: ctx.tools, prompt: ctx.systemPrompt } } })
  const signal = new AbortController().signal
  const toolSet = await services.tools.resolve({ agent, scope: agent, signal })
  const assembly = await services.prompt.assemble({ agent, scope: agent, signal, toolSet })
  assert.deepEqual(assembly.tools.map(tool => tool.name).sort(), ['ancestor', 'own'])
  assert.deepEqual([...toolSet.view(agent).keys()].sort(), ['ancestor', 'own'])
  assert.deepEqual(services.tools.schemas(agent).map(tool => tool.name).sort(), ['ancestor', 'offline', 'own', 'preset'], '发现候选不受插件 deny restriction 破坏')
  for (const name of ['ancestor', 'own', 'preset', 'offline']) {
    const result = (await services.tools.execute({ agent, signal, toolSet, calls: [{ type: 'tool-call', id: name, name, arguments: '{}' }] })).results[0].result
    assert.equal(result.isError, !['ancestor', 'own'].includes(name), name)
  }
  assert.deepEqual(calls, ['ancestor', 'own'])
  assert.deepEqual(conditions.sort(), ['ancestor', 'offline', 'own', 'preset'])
  releases.splice(0).forEach(release => release())
  assert.equal(toolSet.view(agent).size, 0, '最后一个适配 owner 释放会关闭已封存集合')
  assert.equal((await root.tools.execute({ agent, signal, toolSet, calls: [{ type: 'tool-call', id: 'disposed', name: 'ancestor', arguments: '{}' }] })).results[0].result.isError, true)
  toolSet.dispose()
})

test('同一步骤在官方 PTC 绑定与 delegate 管线按同一多层名单执行，正文不决定权限', async t => {
  const h = await harness(t, [{ id: 'multi', then: [{ id: 'allow', kind: 'tool-visibility',
    allow: ['keep', 'preset', 'own', 'probe'], deny: ['hidden', 'own'], requireMatch: true },
  { id: 'catalog', kind: 'inject-text', config: { layer: 'runtime-context', strategy: 'placeholder', fill: 'tool-catalog', text: '{{RESIDENT_TOOLS}}', params: { action: 'allow' } } }] }])
  const bodies = [], bindings = []
  h.root.provide('workingDirectory', { ensure: async () => process.cwd() })
  h.root.provide('ptcRuntime', { language: 'typescript', resolve: spec => spec, run: async spec => {
    const functions = spec.bindings[0].functions
    bindings.push(Object.keys(functions).sort())
    if (functions[spec.program] === undefined) return { logs: [], error: { kind: 'program', message: `no binding ${spec.program}` } }
    try { return { logs: [], value: await functions[spec.program]({}) } }
    catch (error) { return { logs: [], error: { kind: 'tool', message: String(error.message) } } }
  } })
  await h.agent.ctx.plugin(ptc)
  await h.agent.ctx.plugin({ inject: ['tools'], apply(ctx) {
    ctx.tools.register({ name: 'own', description: 'own', parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'string' }, render: () => [] }, execute: () => { bodies.push('own'); return 'own' } })
    applyCustomTools(ctx, { tools: [{ id: 'probe', name: 'probe', description: 'delegates hidden', parameters: { type: 'object', properties: {} }, output: { schema: { type: 'object' } }, execute: { kind: 'delegate', tool: 'hidden' } }] })
  } })
  const toolSet = await h.services.tools.resolve(h.context)
  const assembly = await h.services.prompt.assemble({ ...h.context, toolSet })
  assert.deepEqual(assembly.tools.map(tool => tool.name), ['run_code'])
  assert.deepEqual(sdkToolNames(assembly.sections.find(section => section.name === 'tools:sdk').text).sort(), ['keep', 'probe'])
  assert.equal(assembly.contexts[0].text, 'keep, probe')
  const bare = await h.services.prompt.assemble({ agent: h.agent, scope: h.agent, signal: h.context.signal })
  assert.equal(bare.contexts[0].text, 'keep, probe', '裸 PTC 装配按最终 SDK 展示信息回填，不据此生成步骤权限')
  assert.equal(h.services.prompt.refreshContext(assembly, { agent: h.agent, scope: h.agent }).contexts[0].text, 'keep, probe')
  assert.deepEqual([...toolSet.view(h.agent).keys()].sort(), ['keep', 'probe'])
  const run = async code => (await h.services.tools.execute({ ...h.context, toolSet, calls: [{ type: 'tool-call', id: code, name: 'run_code', arguments: JSON.stringify({ code, description: code }) }] })).results[0].result
  assert.deepEqual((await run('keep')).value, { logs: [], result: { name: 'keep' } })
  assert.equal((await run('own')).isError, true, '拒绝工具无法建立 PTC 绑定')
  const delegated = await run('probe')
  assert.equal(delegated.value.result.ok, false, '已允许的 delegate 也不能调用被拒工具')
  assert.match(delegated.value.result.error, /outside the sealed step/)
  assert.deepEqual(bindings, [['keep', 'probe'], ['keep', 'probe'], ['keep', 'probe']])
  assert.deepEqual(bodies, [])
  assert.equal(h.counts().calls, 1, '被拒的 hidden body 没执行')
  toolSet.dispose()
})

test('requireMatch 全缺只放宽插件 allow，deny 与官方 when 在实际调用中继续拒绝', async t => {
  const h = await harness(t, [{ id: 'missing', then: [{ id: 'allow', kind: 'tool-visibility',
    allow: ['absent'], deny: ['hidden'], requireMatch: true }] }])
  const toolSet = await h.services.tools.resolve(h.context)
  const final = await h.services.prompt.assemble({ ...h.context, toolSet })
  assert.deepEqual(final.tools.map(tool => tool.name), ['keep'])
  assert.deepEqual([...toolSet.view(h.agent).keys()], ['keep'])
  assert.deepEqual((await h.execute(toolSet)).results[0].result.value, { name: 'keep' })
  for (const name of ['hidden', 'unavailable']) assert.equal((await h.execute(toolSet, name)).results[0].result.isError, true)
  assert.deepEqual(h.counts(), { calls: 1, conditions: 3 })
  toolSet.dispose()
})

test('最终目录指引与发现候选分离，真实搜索解锁仅改变下一集合及其正文', async t => {
  const notice = layer => ({ id: layer, kind: 'inject-text', config: { layer, ...(layer === 'pre-step' ? { position: 'after-all' } : {}), strategy: 'placeholder', fill: 'tool-catalog',
    text: 'resident={{RESIDENT_TOOLS}}; search={{DISCOVERY_TOOL}}', params: { action: 'allow' } } })
  const h = await harness(t, [
    { id: 'resident', then: [{ id: 'allow', kind: 'tool-visibility', allow: ['keep', 'hidden'], discovery: { kind: 'tools' } }, notice('runtime-context'), notice('pre-step')] },
    { id: 'deny', then: [{ id: 'deny', kind: 'tool-visibility', deny: ['hidden'] }] },
  ], ['rule-engine', 'tool-search'])
  const events = []
  h.agent.session.snapshotEvents = () => events
  const off = h.root.tools.register({ name: 'gamma', description: 'locked gamma', parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: () => [] }, execute: () => 'gamma' })
  t.after(off)
  const first = await h.services.tools.resolve(h.context)
  const accepted = await h.services.prompt.assemble({ ...h.context, toolSet: first })
  assert.equal(accepted.contexts[0].text, 'resident=keep; search=tool_search', JSON.stringify({ accepted, warnings: h.warnings }))
  const preStep = await h.root.waterfall(scopeTarget(h.agent, h.agent), 'agent/pre-step', { ...h.context, step: 1, turn: 1 }, async () => ({ kind: 'enter', messages: [] }))
  assert.equal(preStep.messages[0].content[0].text, 'resident=keep; search=tool_search')
  const args = JSON.stringify({ query: 'gamma', toolNames: ['gamma', 'hidden'] })
  const found = (await h.services.tools.execute({ ...h.context, toolSet: first, calls: [{ type: 'tool-call', id: 'search', name: 'tool_search', arguments: args }] })).results[0].result
  assert.equal(found.isError, false)
  assert.match(found.value.text, /gamma \(exact\)/)
  events.push({ type: 'tool/call', seq: 1, data: { name: 'tool_search', arguments: args } })
  assert.equal((await h.execute(first, 'gamma')).results[0].result.isError, true)
  const nextContext = { ...h.context, modelSelection: { model: 'deepseek-flash' } }
  const second = await h.services.tools.resolve(nextContext)
  const next = await h.services.prompt.assemble({ ...nextContext, toolSet: second })
  assert.deepEqual(next.tools.map(tool => tool.name).sort(), ['gamma', 'keep', 'tool_search'])
  assert.equal((await h.execute(second, 'gamma')).results[0].result.value, 'gamma')
  assert.equal((await h.execute(second, 'hidden')).results[0].result.isError, true)
  assert.equal(await h.services.prompt.assemble({ ...h.context, toolSet: first }), accepted)
  assert.equal(h.services.prompt.refreshContext(accepted, h.context).contexts[0].text, 'resident=keep; search=tool_search')
  first.dispose(); second.dispose()
})

test('同 Agent 交错装配及 refresh 按集合隔离正文，pre-step 读取捕获选择且歧义拒绝', async t => {
  const resident = (id, modelScope, tool) => ({ id, if: { scope: { modelScope } }, then: [
    { id: 'allow', kind: 'tool-visibility', allow: [tool] },
    ...['runtime-context', 'pre-step'].map(layer => ({ id: layer, kind: 'inject-text', config: { layer, ...(layer === 'pre-step' ? { position: 'after-all' } : {}), strategy: 'placeholder', fill: 'tool-catalog', text: '{{RESIDENT_TOOLS}}', params: { action: 'allow' } } })),
  ] })
  const rules = [resident('pro', 'pro', 'keep'), resident('flash', 'flash', 'hidden')]
  const h = await harness(t, rules)
  await h.runtime.dispose()
  const release = mountRuleSources(h.root, [{ moduleId: 'concurrent', rules: compileRules(rules) }])
  t.after(release)
  await h.agent.ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(ctx) { h.services = { tools: ctx.tools, prompt: ctx.systemPrompt } } })
  const pro = { ...h.context, modelSelection: { model: 'deepseek-pro' } }
  const flash = { ...h.context, modelSelection: { model: 'deepseek-flash' } }
  const first = await h.services.tools.resolve(pro)
  const second = await h.services.tools.resolve(flash)
  let entered, resume
  const waiting = new Promise(resolve => { entered = resolve })
  const gate = new Promise(resolve => { resume = resolve })
  const off = h.root.on('system-prompt/assemble', async (_assembly, context, next) => {
    const result = await next()
    if (context.toolSet === first) { entered(); await gate }
    return result
  })
  const a = h.services.prompt.assemble({ ...pro, toolSet: first })
  await waiting
  const b = await h.services.prompt.assemble({ ...flash, toolSet: second })
  resume()
  const accepted = await a
  off()
  const text = assembly => assembly.contexts.map(context => context.text).filter(Boolean)
  assert.deepEqual(text(accepted), ['keep'])
  assert.deepEqual(text(b), ['hidden'])
  assert.deepEqual(text(h.services.prompt.refreshContext(accepted, { agent: h.agent, scope: h.agent, signal: h.context.signal })), ['keep'])
  assert.deepEqual(text(h.services.prompt.refreshContext(b, { agent: h.agent, scope: h.agent, signal: h.context.signal })), ['hidden'])
  const child = { id: 'child', session: { id: 'child', header: { delegationDepth: 1 }, snapshotEvents: () => [] } }
  child.ctx = createScope(h.root, child, { parent: h.agent }).ctx
  const childContext = { ...pro, agent: child, scope: child }
  const childSet = await h.services.tools.resolve(childContext)
  const childAssembly = await h.services.prompt.assemble({ ...childContext, toolSet: childSet })
  assert.deepEqual(text(childAssembly), ['keep'])
  assert.equal((await h.services.tools.execute({ ...childContext, toolSet: childSet, calls: [{ type: 'tool-call', id: 'child-denied', name: 'hidden', arguments: '{}' }] })).results[0].result.isError, true)
  assert.throws(() => h.services.prompt.refreshContext(accepted, childContext), { code: 'TOOL_STEP_UNAVAILABLE' })
  pro.modelSelection.model = 'deepseek-flash'
  const step = context => h.root.waterfall(scopeTarget(h.agent, h.agent), 'agent/pre-step', { ...context, step: 1, turn: 1 }, async () => ({ kind: 'enter', messages: [] }))
  assert.equal((await step(pro)).messages[0].content[0].text, 'keep')
  const duplicate = await h.services.tools.resolve(pro)
  assert.deepEqual((await step(pro)).messages, [], '同选择关联多个集合不猜最新一步')
  first.dispose(); second.dispose(); duplicate.dispose(); childSet.dispose()
  assert.throws(() => h.services.prompt.refreshContext(accepted, pro), { code: 'TOOL_STEP_UNAVAILABLE' })
  assert.deepEqual((await step(pro)).messages, [], 'closed/歧义选择不恢复成另一步')
})
