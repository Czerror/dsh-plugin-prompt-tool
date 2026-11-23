import SessionProjections from '@deepseek-ai/dsh-session-projection'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { createScope, scopeTarget } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Agents from '@deepseek-ai/dsh-agent'
import Loop from '@deepseek-ai/dsh-agent-loop'
import Llm, { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import Tools from '@deepseek-ai/dsh-tools'
import * as native from '@deepseek-ai/dsh-tool-executor-native'
import * as ptc from '@deepseek-ai/dsh-tool-executor-ptc'
import { createDiscoveryRegistry } from '../../engine/discovery.mjs'
import { isolatedHome } from '../fixtures/host-harness.mjs'

const { home, moduleRoot } = isolatedHome('pt-tool-step-')
const { createAgentAssembly } = await import('../../src/runtime/agent-assembly.ts')
const { installPreStepCoordinator } = await import('../../src/runtime/pre-step-coordinator.ts')

async function harness(t, rules = [{ id: 'narrow', then: [{ id: 'allow', kind: 'tool-visibility', allow: ['keep'] }] }], modules = ['rule-engine']) {
  const root = new Context()
  await root.plugin(SessionProjections)
  await root.plugin(SystemPrompt)
  await root.plugin(Tools)
  await root.plugin(native)
  installPreStepCoordinator(root)
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
  await agent.ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(ctx) { services = { tools: ctx.tools, get prompt() { return ctx.systemPrompt } } } })
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

test('官方会话提交的身份、PTC 声明及工具目录使用同一步已接受的投影', async t => {
  const require = createRequire(import.meta.url)
  const peer = createRequire(require.resolve('@deepseek-ai/dsh-agent-loop'))
  const { default: Sessions } = await import(pathToFileURL(peer.resolve('@deepseek-ai/dsh-session')).href)
  const id = 'step-projection'
  mkdirSync(join(moduleRoot, id), { recursive: true })
  writeFileSync(join(moduleRoot, id, 'module.yml'), JSON.stringify({ id, modules: ['rule-engine'], rules: [
    { id: 'strip', then: [{ id: 'identity', kind: 'persona', stripDefaultIdentity: 'harness' }] },
    { id: 'tools', then: [
      { id: 'narrow', kind: 'tool-visibility', allow: ['fixture_keep', 'fixture_absent'] },
      { id: 'catalog', kind: 'inject-text', config: { layer: 'runtime-context', strategy: 'placeholder',
        fill: 'tool-catalog', params: { action: 'narrow' }, text: 'CATALOG {{RESIDENT_TOOLS}}' } },
    ] },
  ] }))
  const root = new Context()
  let runtime, handle
  t.after(async () => { await runtime?.dispose(); await handle?.dispose(); await root.fiber.dispose() })
  for (const plugin of [Llm, Sessions, SessionProjections, SystemPrompt, Tools, Agents]) await root.plugin(plugin)
  root.provide('ptcRuntime', { language: 'typescript' })
  await root.plugin(ptc)
  await root.plugin(Loop, { agents: [] })
  root.provide('workingDirectory', { get: () => home, ensure: async () => home, set: async () => home })
  const requests = []
  class Model extends LlmAdapter {
    async resolveModel(provider, id) { return { provider, id, name: id } }
    async *stream(request) {
      requests.push(request)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  root.llm.registerAdapter(['fixture'], new Model())
  let whenCalls = 0
  for (const name of ['fixture_keep', 'fixture_hidden']) root.tools.register({ name, description: name,
    parameters: { type: 'object', properties: {} }, output: { schema: { type: 'object' }, render: () => [] }, execute: () => ({}),
  }, { when: () => { whenCalls++; return true } })
  runtime = createAgentAssembly(root, { moduleRoot, enabledModules: () => [id] })
  handle = await root.agents.create({ sessionId: id, agentOptions: { provider: 'fixture', model: 'fixture' }, meta: { cwd: home } })
  handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Present tools.' }], source: { kind: 'user' } }))
  await handle.agent.whenIdle()
  assert.equal(requests.length, 1)
  const text = messages => messages.flatMap(message => message.content.filter(block => block.type === 'text').map(block => block.text)).join('\n')
  const committed = handle.agent.session.snapshotEvents().filter(event => event.type === 'system/message').map(event => event.data.message)
  for (const system of [text(committed), text(requests[0].messages.filter(message => message.role === 'system'))]) {
    assert.match(system, /fixture_keep/)
    assert.doesNotMatch(system, /fixture_hidden|You are an AI agent powered by DeepSeek Harness\./)
  }
  assert.match(text(requests[0].messages), /CATALOG fixture_keep\n/)
  assert.deepEqual(requests[0].tools.map(tool => tool.name), ['run_code'])
  assert.equal(whenCalls, 2)
})

test('pre-step 工具条件遵守封存后的工具面，只读裁剪保留真实用户问句', async t => {
  const rules = [
    { id: 'surface', then: [{ id: 'allow', kind: 'tool-visibility', allow: ['keep', 'hidden'] }] },
    { id: 'notice', if: { all: [{ tool: { name: 'keep' } }, { tool: { name: 'hidden' } }] },
      then: [{ id: 'inject', kind: 'inject-text', config: { layer: 'pre-step', position: 'before-all', text: 'WRITE NOTICE' } }] },
  ]
  const h = await harness(t, rules)
  const question = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '只读说明当前状态。' }] }
  const inject = async () => {
    const toolSet = await h.services.tools.resolve(h.context)
    try {
      await h.services.prompt.assemble({ ...h.context, toolSet })
      return await h.root.waterfall(scopeTarget(h.agent, h.agent), 'agent/pre-step', { ...h.context, toolSet },
        async () => ({ kind: 'continue', messages: [question] }))
    } finally { toolSet.dispose() }
  }
  const writable = await inject()
  assert.deepEqual(writable.messages.map(message => message.content[0].text), ['WRITE NOTICE', question.content[0].text])
  rules[0].then[0].allow = []
  h.write()
  h.runtime.schedule('step-surface')
  assert.deepEqual(await inject(), { kind: 'continue', messages: [question] })
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
  const scope = {}
  const marker = Symbol('fixture extension')
  createScope(h.agent.ctx, scope)
  const presented = []
  const off = h.root.on('system-prompt/assemble', async (_assembly, context, next) => {
    presented.push(context)
    return next()
  }, { global: true })
  const wrappedAssemble = h.services.prompt.assemble
  let wrappers = 0, decoratedSignal
  Object.defineProperty(h.services.prompt, 'assemble', { configurable: true, async value(context) {
    wrappers++
    decoratedSignal = AbortSignal.any([context.signal])
    let timer
    try {
      const assembled = await Promise.race([
        wrappedAssemble({ ...context, scope, toolSet: context.toolSet === undefined ? undefined : original, signal: decoratedSignal, [marker]: 'decorated' }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('装配包装等待超时')), 1000) }),
      ])
      return { ...assembled, sections: [...assembled.sections, { name: 'fixture.decorated', text: 'preserved' }] }
    } finally { clearTimeout(timer) }
  } })
  const [first, concurrent] = await Promise.all([
    h.services.prompt.assemble({ ...h.context, toolSet }),
    h.services.prompt.assemble({ ...h.context, toolSet: original }),
  ])
  assert.equal(concurrent, first)
  assert.equal(wrappers, 1)
  assert.deepEqual(first.sections.at(-1), { name: 'fixture.decorated', text: 'preserved' })
  assert.equal(presented[0].scope, scope)
  assert.equal(presented[0].signal, decoratedSignal)
  assert.equal(presented[0][marker], 'decorated')
  assert.equal(presented[0].toolSet, toolSet)
  h.context.modelSelection.model = 'deepseek-flash'
  assert.equal(await h.services.prompt.assemble({ ...h.context, toolSet: original }), first)
  assert.equal(presented.length, 1)
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
  assert.deepEqual((await h.services.prompt.assemble(h.context)).sections.at(-1), { name: 'fixture.decorated', text: 'preserved' })
  assert.equal(presented[1].scope, scope)
  assert.equal(presented[1].signal, decoratedSignal)
  assert.equal(presented.length, 2)
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
