import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { parse } from 'yaml'
import { Context } from '@deepseek-ai/cordis'
import { isolatedHome } from '../fixtures/host-harness.mjs'

const { home } = isolatedHome('pt-startup-dependencies-')
const { installPersonaRegistration } = await import('../../src/runtime/persona-registration.ts')
const require = createRequire(import.meta.url)
const dependencies = createRequire(require.resolve('@deepseek-ai/dsh-agent-preset-registry'))
const load = name => import(pathToFileURL(dependencies.resolve(name)).href)
const { default: Loader } = await load('@deepseek-ai/cordis-plugin-loader')
const { default: Include } = await load('@deepseek-ai/cordis-plugin-include')
const core = Object.fromEntries(await Promise.all([
  ['system-prompt', '@deepseek-ai/dsh-system-prompt'], ['tools', '@deepseek-ai/dsh-tools'],
  ['llm', '@deepseek-ai/dsh-llm'], ['agents', '@deepseek-ai/dsh-agent'],
  ['sessions', '@deepseek-ai/dsh-session'], ['projections', '@deepseek-ai/dsh-session-projection'],
  ['fs', '@deepseek-ai/dsh-fs'], ['working-directory', '@deepseek-ai/dsh-working-directory'],
  ['subagent', '@deepseek-ai/dsh-subagent'],
].map(async ([id, name]) => [id, await load(name)])))

test('包补丁不阻塞官方启动，迟到依赖收敛且卸载插件后官方服务存活', { timeout: 10000 }, async t => {
  const root = new Context()
  const firstStarted = Promise.withResolvers(), firstReleased = Promise.withResolvers()
  const secondStarted = Promise.withResolvers(), secondReleased = Promise.withResolvers()
  t.after(async () => { firstReleased.resolve(); secondReleased.resolve(); await root.fiber.dispose() })
  await root.plugin(Loader)
  Object.assign(root.loader.builtins, core, {
    include: Include,
    // 只替换会启动工作台的宿主外壳；官方服务、补丁与主入口的人设注册均走实际实现。
    owner: { name: 'startup-prompt-tool-owner', inject: ['subagents'], apply(ctx) { installPersonaRegistration(ctx) } },
    required: { name: 'startup-agent-loop-consumer', inject: ['tools', 'systemPrompt'], apply() {} },
    first: { name: 'startup-first-provider', async* apply(ctx) {
      yield ctx.provide('startupFirst', {})
      firstStarted.resolve()
      await firstReleased.promise
    } },
    second: { name: 'startup-second-provider', inject: ['startupFirst'], async* apply(ctx) {
      yield ctx.provide('startupSecond', {})
      secondStarted.resolve()
      await secondReleased.promise
    } },
  })
  const patches = parse(readFileSync(new URL('../../cordis.patch.yml', import.meta.url), 'utf8'))
  const aliases = { 'dsh-plugin-prompt-tool': 'cordis:owner' }
  for (const patch of patches) for (const entry of patch.insert ?? []) entry.name = aliases[entry.name] ?? entry.name
  const entries = [
    ...Object.keys(core).map(id => ({ id, name: `cordis:${id}` })),
    { id: 'agent-loop', name: 'cordis:required' },
    { id: 'first', name: 'cordis:first' },
    { id: 'second', name: 'cordis:second' },
  ]
  await root.loader.root.update([{ id: 'profile', name: 'cordis:include', config: {
    path: pathToFileURL(join(home, 'cordis.json')).href, initial: entries, patches,
  } }])
  await firstStarted.promise
  await new Promise(resolve => setImmediate(resolve))
  firstReleased.resolve()
  await secondStarted.promise
  await new Promise(resolve => setImmediate(resolve))
  secondReleased.resolve()
  await root.loader.await()

  const pending = () => [...root.loader.entries()].filter(entry => entry.fiber?.state !== 2).map(entry => entry.id)
  assert.deepEqual(pending(), [], '官方启动审计不能留下 pending/failed 入口')
  const serviceNames = ['systemPrompt', 'tools', 'workingDirectory', 'subagents']
  for (const name of serviceNames) assert.ok(root.get(name), `${name} 必须完成激活`)
  const prompt = await root.get('systemPrompt').assemble()
  assert.ok(prompt.sections.some(section => section.name === 'harness:identity'))

  await root.loader.resolve('profile:prompt-tool').fiber.dispose()
  await root.loader.await()
  for (const name of serviceNames) assert.ok(root.get(name), `插件卸载不能撤销官方 ${name}`)
  for (const id of ['system-prompt', 'tools', 'working-directory', 'subagent', 'agent-loop']) {
    assert.equal(root.loader.resolve(`profile:${id}`).fiber.state, 2)
  }
  assert.deepEqual(await root.get('systemPrompt').assemble(), prompt, '卸载不改变官方装配')
})
