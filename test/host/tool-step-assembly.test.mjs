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
import { isolatedHome } from '../fixtures/host-harness.mjs'

const { moduleRoot } = isolatedHome('pt-tool-step-')
const { createAgentAssembly } = await import('../../src/runtime/agent-assembly.ts')

async function harness(t, rules = [{ id: 'narrow', then: [{ id: 'allow', kind: 'tool-visibility', allow: ['keep'] }] }]) {
  const root = new Context()
  await root.plugin(SystemPrompt)
  await root.plugin(Tools)
  await root.plugin(native)
  const rawTools = root.get('tools')
  root.provide('llm', {})
  const agents = []
  root.provide('agents', { list: () => agents })
  const id = 'step-surface'
  mkdirSync(join(moduleRoot, id), { recursive: true })
  const write = (modules = ['rule-engine']) => writeFileSync(join(moduleRoot, id, 'module.yml'), JSON.stringify({ id, name: id, modules, rules }))
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
    allow: ['keep', 'preset', 'own', 'probe'], deny: ['hidden', 'own'], requireMatch: true }] }])
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
