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

async function harness(t, beforeEcho) {
  const root = new Context()
  await root.plugin(SystemPrompt)
  await root.plugin(Tools)
  t.after(() => root.fiber.dispose())
  let calls = 0
  root.tools.register({
    name: 'echo', description: 'echo', parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'object' }, render: value => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: async () => { calls++; await beforeEcho?.(calls); return { answer: 42 } },
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
  const execute = (value, name = 'echo', args = {}, batch = {}) => root.tools.execute({
    agent: value, signal: new AbortController().signal,
    calls: [{ type: 'tool_call', id: 'call-1', name, arguments: JSON.stringify(args) }],
    ...batch,
  })
  return { root, agent, mount, execute, calls: () => calls }
}

test('present-as native 卸载失败关闭，已接受批次排空并显式重挂恢复', { timeout: 5000 }, async t => {
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  t.after(() => release.resolve())
  const h = await harness(t, async count => {
    if (count === 1) { entered.resolve(); await release.promise }
  })
  await assert.rejects(h.execute(h.agent('without-executor')), { code: 'TOOL_EXECUTOR_UNAVAILABLE' })
  await h.root.plugin(native)
  const agent = h.agent('native-main')
  const child = h.agent('native-child', 1)
  const mounted = await h.mount(agent, { enabled: true, mode: 'native' })
  await h.mount(child, { enabled: true, mode: 'native' })
  const assembled = await h.root.systemPrompt.assemble({ agent, scope: agent })
  assert.deepEqual(assembled.tools.map(tool => tool.name), ['echo'])
  const accepted = h.execute(agent, 'echo', {}, { maxParallelToolCalls: 1, calls: [
    { type: 'tool_call', id: 'accepted-1', name: 'echo', arguments: '{}' },
    { type: 'tool_call', id: 'accepted-2', name: 'echo', arguments: '{}' },
  ] })
  await entered.promise
  await mounted.dispose()
  await mounted.dispose()
  await assert.rejects(h.execute(agent), { code: 'TOOL_EXECUTOR_UNAVAILABLE' })
  assert.equal(h.calls(), 1, '卸载后不回退部署 native，也不提前执行排队调用')
  assert.deepEqual((await h.execute(child)).results[0].result.value, { answer: 42 })
  release.resolve()
  const batch = await accepted
  assert.deepEqual(batch.results.map(result => [result.callId, result.result.value]), [
    ['accepted-1', { answer: 42 }], ['accepted-2', { answer: 42 }],
  ])
  assert.equal(h.calls(), 3, '已接受的两项调用各完成一次，子 Agent 一次')
  const replacement = await h.mount(agent, { enabled: true, mode: 'native' })
  await mounted.dispose()
  assert.deepEqual((await h.execute(agent)).results[0].result.value, { answer: 42 })
  assert.equal(h.calls(), 4, '旧 disposer 不撤销重挂实例，也不重复执行')
  await replacement.dispose()
  await assert.rejects(h.execute(agent), { code: 'TOOL_EXECUTOR_UNAVAILABLE' })
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

test('present-as 主子模式独立，PTC runtime 晚到、撤回排空与恢复均走官方绑定', { timeout: 5000 }, async t => {
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  t.after(() => release.resolve())
  const h = await harness(t, async count => {
    if (count === 3) { entered.resolve(); await release.promise }
  })
  h.root.provide('workingDirectory', { ensure: async () => process.cwd() })
  const main = h.agent('main-ptc')
  const child = h.agent('child-native', 1)
  const config = { enabled: true, mode: 'native', mainMode: 'ptc', subagentMode: 'native' }
  await h.mount(main, config)
  await h.mount(child, config)
  await assert.rejects(h.execute(main), { code: 'TOOL_EXECUTOR_UNAVAILABLE' })
  assert.deepEqual((await h.execute(child)).results[0].result.value, { answer: 42 })
  const runtime = await h.root.plugin(ProgramRuntime)
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
  const accepted = h.execute(main, 'run_code', { code: 'return await tools.echo({})', description: 'Finish the accepted program' })
  await entered.promise
  await runtime.dispose()
  await runtime.dispose()
  await assert.rejects(h.execute(main, 'run_code', { code: 'return await tools.echo({})', description: 'Read after runtime withdrawal' }), { code: 'TOOL_EXECUTOR_UNAVAILABLE' })
  const resumed = h.agent('new-without-runtime')
  await h.mount(resumed, { enabled: true, mode: 'ptc' })
  await assert.rejects(h.execute(resumed), { code: 'TOOL_EXECUTOR_UNAVAILABLE' })
  assert.equal(h.calls(), 3, 'runtime 撤回后不启动新程序')
  assert.deepEqual((await h.execute(child)).results[0].result.value, { answer: 42 })
  release.resolve()
  assert.deepEqual((await accepted).results[0].result.value, { logs: [], result: { answer: 42 } })
  assert.equal(h.calls(), 4, '已接受程序仍返回原绑定的真实结果，子 Agent 不受撤回影响')
  await h.root.plugin(ProgramRuntime)
  for (const fiber of h.root.registry.get(executor)?.fibers ?? []) await fiber
  assert.deepEqual((await h.execute(main, 'run_code', { code: 'return await tools.echo({})', description: 'Read after runtime recovery' })).results[0].result.value, { logs: [], result: { answer: 42 } })
  assert.deepEqual((await h.execute(resumed, 'run_code', { code: 'return await tools.echo({})', description: 'Read in the new session' })).results[0].result.value, { logs: [], result: { answer: 42 } })
  assert.equal(h.calls(), 6, '新会话与旧会话都只在有效执行器恢复后各执行一次')
})
