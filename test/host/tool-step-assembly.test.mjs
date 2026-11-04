import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createScope, scopeTarget } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import * as native from '@deepseek-ai/dsh-tool-executor-native'
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
    session: { id: 'step-agent', header: {}, snapshotEvents: () => [] } }
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
