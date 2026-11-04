import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import * as native from '@deepseek-ai/dsh-tool-executor-native'
import * as presentAs from '../../engine/present-as.mjs'

const executorRequire = createRequire(import.meta.resolve('@deepseek-ai/dsh-tool-executor-ptc'))
const { default: PtcRuntime } = await import(pathToFileURL(executorRequire.resolve('@deepseek-ai/dsh-ptc-runtime')).href)
const { Session } = await import(pathToFileURL(executorRequire.resolve('@deepseek-ai/dsh-session')).href)

// 运行真正的 async 程序与官方工具 bindings；不模拟执行器或预置返回值。
class ProgramRuntime extends PtcRuntime {
  get language() { return 'typescript' }
  get programFormat() { return 'function-body' }
  resolve(request) { return { ...request, cwd: request.cwd ?? process.cwd(), timeoutMs: null } }
  async release() {}
  async run(spec) {
    const AsyncFunction = (async () => {}).constructor
    const run = new AsyncFunction(...spec.bindings.map(binding => binding.global), spec.program)
    return { logs: [], value: await run(...spec.bindings.map(binding => binding.functions)) }
  }
}

async function harness(t) {
  const root = new Context()
  await root.plugin(SystemPrompt)
  await root.plugin(Tools)
  t.after(() => root.fiber.dispose())
  let calls = 0
  root.tools.register({
    name: 'echo', description: 'echo', parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'object' }, render: value => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: async () => { calls++; return { answer: 42 } },
  })
  const agent = (id, depth = 0) => {
    const session = Session.create(id, [], { id, version: 4, createdAt: Date.now(), isSeeded: false, delegationDepth: depth })
    const value = { id, options: {}, session }
    value.ctx = createScope(root, value).ctx
    return value
  }
  const mount = (value, config) => value.ctx.plugin({
    inject: presentAs.inject, apply: ctx => presentAs.apply(ctx, config, { agent: value }),
  })
  const execute = (value, name = 'echo', args = {}) => root.tools.execute({
    agent: value, signal: new AbortController().signal,
    calls: [{ type: 'tool_call', id: 'call-1', name, arguments: JSON.stringify(args) }],
  })
  return { root, agent, mount, execute, calls: () => calls }
}

test('present-as native 等待官方执行器挂载后可真实调用，不依赖 PTC runtime', async t => {
  const h = await harness(t)
  const agent = h.agent('native-main')
  await h.mount(agent, { enabled: true, mode: 'native' })
  const assembled = await h.root.systemPrompt.assemble({ agent, scope: agent })
  assert.deepEqual(assembled.tools.map(tool => tool.name), ['echo'])
  const batch = await h.execute(agent)
  assert.deepEqual(batch.results[0].result.value, { answer: 42 })
  assert.equal(h.calls(), 1)
})

test('未启用 present-as 保留宿主执行器，同 scope 冲突由官方拒绝', async t => {
  const h = await harness(t)
  const agent = h.agent('host-owned')
  await agent.ctx.plugin(native)
  await h.mount(agent, { enabled: false, mode: 'ptc' })
  assert.deepEqual((await h.execute(agent)).results[0].result.value, { answer: 42 })
  await assert.rejects(async () => { await h.mount(agent, { enabled: true, mode: 'native' }) }, /Only one tool executor/)
  assert.deepEqual((await h.execute(agent)).results[0].result.value, { answer: 42 })
  assert.equal(h.calls(), 2)
})

test('present-as 主子模式独立，PTC runtime 晚到后真实调用绑定，直呼工具被拒绝', async t => {
  const h = await harness(t)
  h.root.provide('workingDirectory', { ensure: async () => process.cwd() })
  const main = h.agent('main-ptc')
  const child = h.agent('child-native', 1)
  const config = { enabled: true, mode: 'native', mainMode: 'ptc', subagentMode: 'native' }
  await h.mount(main, config)
  await h.mount(child, config)
  await assert.rejects(h.execute(main), { code: 'TOOL_EXECUTOR_UNAVAILABLE' })
  assert.deepEqual((await h.execute(child)).results[0].result.value, { answer: 42 })
  await h.root.plugin(ProgramRuntime)
  // 动态注入后等公开 fiber 就绪，不以延时猜测初始化已完成。
  const executor = await import('@deepseek-ai/dsh-tool-executor-ptc')
  for (const fiber of h.root.registry.get(executor)?.fibers ?? []) await fiber
  const mainPrompt = await h.root.systemPrompt.assemble({ agent: main, scope: main })
  const childPrompt = await h.root.systemPrompt.assemble({ agent: child, scope: child })
  assert.deepEqual(mainPrompt.tools.map(tool => tool.name), ['run_code'])
  assert.deepEqual(childPrompt.tools.map(tool => tool.name), ['echo'])
  const denied = await h.execute(main)
  assert.equal(denied.results[0].result.error.info.code, 'UNKNOWN_TOOL')
  assert.equal(h.calls(), 1)
  const batch = await h.execute(main, 'run_code', { code: 'return await tools.echo({})', description: 'Read the known answer' })
  assert.deepEqual(batch.results[0].result.value, { logs: [], result: { answer: 42 } })
  assert.equal(h.calls(), 2)
})
