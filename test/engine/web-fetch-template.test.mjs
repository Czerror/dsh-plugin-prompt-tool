import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { compileCustomTool } from '../../src/host/custom-tools.ts'
import { apply } from '../../engine/tool-config-engine.mjs'

test('核心 HTTP GET 工具：关闭不注册，开启调用原始响应，disposer 撤回', async (t) => {
  const definition = compileCustomTool(parseYaml(readFileSync(new URL('../../modules/limit-breaker/module.yml', import.meta.url), 'utf8')).customTools.find(tool => tool.id === 'http-fetch'))
  const root = new Context()
  t.after(() => root.fiber.dispose())
  await root.plugin(SystemPrompt)
  await root.plugin(ToolRuntime)
  await root.plugin(NativeExecutor)
  const agent = { id: 'http-agent', session: { id: 'http-session', header: { cwd: process.cwd() } } }
  agent.ctx = createScope(root, agent).ctx
  const context = { agent, signal: new AbortController().signal }
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push([url, options.method])
    return new Response('raw <b>page</b>', { status: 200 })
  })
  const mount = async (enabled, requireApproval = []) => {
    let owner
    await agent.ctx.plugin({ inject: ['tools'], apply(ctx) {
      owner = ctx.fiber
      apply(ctx, { tools: [{ ...definition, enabled }], requireApproval })
    } })
    return owner
  }
  const resolve = async () => {
    const set = await root.tools.resolve(context)
    t.after(() => set.dispose())
    return set
  }
  const execute = async (toolSet, args, signal = context.signal) => (await root.tools.execute({ ...context, signal, toolSet,
    calls: [{ type: 'tool_call', id: 'http-call', name: 'http_fetch', arguments: JSON.stringify(args) }],
  })).results[0].result
  const disabled = await mount(definition.enabled)
  assert.equal((await resolve()).view(agent).has('http_fetch'), false)
  await disabled.dispose()
  const enabled = await mount(true)
  const set = await resolve()
  assert.deepEqual(set.view(agent).get('http_fetch').parameters, definition.parameters)
  assert.equal((await execute(set, {})).isError, true)
  assert.deepEqual(calls, [])
  const result = await execute(set, { url: 'http://127.0.0.1/test' })
  assert.equal(result.isError, false, JSON.stringify(result))
  assert.deepEqual(result.value, {
    status: 200, ok: true, body: 'raw <b>page</b>',
  })
  assert.deepEqual(calls, [['http://127.0.0.1/test', 'GET']])
  await enabled.dispose()
  await mount(false)
  assert.equal((await resolve()).view(agent).has('http_fetch'), false)
  const guarded = await mount(true, ['http'])
  const guardedSet = await resolve()
  assert.deepEqual((await execute(guardedSet, { url: 'http://127.0.0.1/test' })).value, {
    ok: false, error: 'tool http_fetch (http) requires approval, but no approval channel is available',
  })
  assert.equal(calls.length, 1, '缺审批服务拒绝，不发请求')
  const cancelled = new AbortController()
  cancelled.abort(new Error('caller cancelled'))
  const stopped = await execute(guardedSet, { url: 'http://127.0.0.1/test' }, cancelled.signal)
  assert.equal(stopped.isError, true)
  assert.equal(stopped.error.message, 'tool call aborted before dispatch')
  assert.equal(calls.length, 1, '调用方取消不发请求')
  await guarded.dispose()
})
