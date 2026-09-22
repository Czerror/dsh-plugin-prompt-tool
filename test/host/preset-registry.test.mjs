import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import AgentPresets, { livePresetMounts } from '@deepseek-ai/dsh-agent-preset-registry'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'

// 从已安装 registry 的依赖闭包加载官方 Loader，无额外依赖或宿主源码。
const requireRegistry = createRequire(import.meta.resolve('@deepseek-ai/dsh-agent-preset-registry'))
const { default: Loader } = await import(pathToFileURL(requireRegistry.resolve('@deepseek-ai/cordis-plugin-loader')).href)
const { default: SessionProjections } = await import(pathToFileURL(requireRegistry.resolve('@deepseek-ai/dsh-session-projection')).href)
const home = mkdtempSync(join(process.cwd(), 'pt-registry-'))
process.env.DSH_HOME = home
const { createPresetRegistrySync } = await import('../../src/host/preset-registry.ts')
const { listPresets } = await import('../../src/host/manifest.ts')
test.after(() => { rmSync(home, { recursive: true, force: true }); delete process.env.DSH_HOME })

test('注册清单保留兼容快照、可选名称和顶层排序，UI仍隐藏兼容快照', async () => {
  const root = join(home, 'metadata')
  for (const [id, definition] of [
    ['alpha', 'id: alpha\nmodules: []\norder: -7\nmeta: { order: 99 }\n'],
    ['prompt-tool', 'id: prompt-tool\nmodules: []\nname: Legacy\n'],
  ]) {
    const directory = join(root, id)
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'preset.yml'), definition)
    writeFileSync(join(directory, 'agent.cordis.yml'), '[]\n')
  }
  const definitions = new Map()
  const registry = {
    register: async (definition) => {
      definitions.set(definition.id, definition)
      return async () => { definitions.delete(definition.id) }
    },
    resolve: async (id) => definitions.get(id),
  }
  const sync = createPresetRegistrySync({ extend: () => ({ agentPresets: registry }) }, root)
  try {
    await sync.refresh()
    assert.deepEqual([...definitions.keys()].sort(), ['alpha', 'prompt-tool'])
    assert.equal(definitions.get('alpha').name, undefined, '名称未设置仍可注册')
    assert.equal(definitions.get('alpha').order, -7, '使用顶层 order，不误读 meta.order')
    assert.deepEqual(listPresets(root).map((preset) => preset.id), ['alpha'], '兼容快照不进入普通选择列表')
  } finally { await sync.dispose() }
})

const pluginSource = `export const inject = ['tools']
export function apply(ctx, config) {
  ctx.effect(() => ctx.tools.register({ name: config.tool, description: config.tool,
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: async () => '' }))
}
`

test('官方 registry：相对路径、候选失败、刷新与释放保留现有 revision', async () => {
  const root = join(home, 'presets')
  const write = (id, tool) => {
    const dir = join(root, id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'preset.yml'), `id: ${id}\nname: ${id}\nmodules: []\n`)
    writeFileSync(join(dir, 'local.mjs'), pluginSource)
    writeFileSync(join(dir, 'agent.cordis.yml'), `- name: ./local.mjs\n  disabled: !!js false\n  config:\n    tool: !!js "'${tool}'"\n- name: ./missing-disabled.mjs\n  disabled: !!js true\n`)
  }
  write('alpha', 'alpha_v1')
  write('beta', 'beta_v1')
  const ctx = new Context()
  const scopes = []
  const leases = []
  let sync
  try {
    ctx.baseUrl = pathToFileURL(join(home, 'host.cordis.yml')).href
    await ctx.plugin(Loader)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjections)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentPresets, { default: 'alpha' })
    const foreign = await ctx.agentPresets.register({ id: 'foreign', plugins: [] })
    sync = createPresetRegistrySync(ctx, root)
    const lease = async (id) => {
      const value = await ctx.agentPresets.acquireScope(id)
      leases.push(value)
      return value
    }
    const names = (key) => ctx.tools.schemas(key).map((tool) => tool.name)
    await sync.refresh()
    const old = await lease('alpha')
    assert.deepEqual(names(old.key), ['alpha_v1'])
    assert.deepEqual(names((await lease('beta')).key), ['beta_v1'], '各预设独立解析相对路径')
    await sync.refresh()
    assert.equal((await lease('alpha')).key, old.key, '未变定义不重挂')

    const parent = createScope(ctx, {})
    scopes.push(parent)
    await ctx.agentPresets.mount(parent.ctx, 'alpha')
    write('alpha', 'alpha_v2')
    await sync.refresh()
    const current = await lease('alpha')
    assert.notEqual(current.key, old.key)
    assert.deepEqual(names(current.key), ['alpha_v2'])
    assert.deepEqual(names(old.key), ['alpha_v1'])
    const child = createScope(ctx, {})
    scopes.push(child)
    assert.equal(ctx.agentPresets.composeFrom(child.ctx, parent.ctx), 'alpha')
    assert.deepEqual(names(scopeOf(child.ctx)), ['alpha_v1'])

    for (const source of ['- name: [\n', '- name: ./missing.mjs\n']) {
      writeFileSync(join(root, 'alpha', 'agent.cordis.yml'), source)
      await assert.rejects(sync.refresh(), /注册刷新失败/)
      assert.equal((await lease('alpha')).key, current.key, '坏候选不能替换旧注册')
      assert.deepEqual((await ctx.agentPresets.list()).map((preset) => preset.id).sort(), ['alpha', 'beta', 'foreign'])
    }
    writeFileSync(join(root, 'alpha', 'preset.yml'), 'id: [\n')
    await sync.refresh()
    assert.equal((await lease('alpha')).key, current.key, '清单读取失败不能误判为删除')
    write('alpha', 'alpha_v2')
    await sync.refresh(['alpha'])
    const refreshed = await lease('alpha')
    assert.notEqual(refreshed.key, current.key, '正文重建即使组合行不变也更新代际')
    assert.deepEqual(names(refreshed.key), ['alpha_v2'])

    rmSync(join(root, 'beta'), { recursive: true })
    await sync.refresh()
    assert.deepEqual((await ctx.agentPresets.list()).map((preset) => preset.id).sort(), ['alpha', 'foreign'])
    await sync.dispose()
    await sync.refresh()
    assert.deepEqual((await ctx.agentPresets.list()).map((preset) => preset.id), ['foreign'], '只释放本插件注册且不复活')
    assert.deepEqual(names(old.key), ['alpha_v1'], '卸载后旧引用继续可用')
    assert.deepEqual(names(refreshed.key), ['alpha_v2'])
    for (const scope of scopes.splice(0)) await scope.dispose()
    for (const value of leases.splice(0)) await value[Symbol.asyncDispose]()
    assert.equal(livePresetMounts(ctx.fiber).length, 1, '最后引用释放后旧代际全部回收')
    await foreign()
    assert.equal(livePresetMounts(ctx.fiber).length, 0)
  } finally {
    await sync?.dispose()
    for (const scope of scopes) await scope.dispose()
    for (const value of leases) await value[Symbol.asyncDispose]()
    await ctx.fiber.dispose()
  }
})

test('注册刷新排队期间卸载：待执行任务不得重新注册', async () => {
  let registrations = 0
  const sync = createPresetRegistrySync({ extend() { registrations++; throw new Error('不得重新注册') } }, join(home, 'presets'))
  const refresh = sync.refresh()
  await sync.dispose()
  await refresh
  await sync.refresh()
  assert.equal(registrations, 0)
})

test('候选通过但正式注册失败时恢复旧定义，后续刷新仍可重试', async () => {
  const root = join(home, 'rollback')
  const dir = join(root, 'alpha')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'preset.yml'), 'id: alpha\nname: alpha\nmodules: []\n')
  writeFileSync(join(dir, 'agent.cordis.yml'), '- name: old\n')
  const definitions = new Map()
  let fail = true
  const registry = {
    register: async (definition) => {
      if (definition.id === 'alpha' && definition.plugins[0].name === 'new' && fail) {
        fail = false
        throw new Error('formal registration failed')
      }
      assert.equal(definitions.has(definition.id), false)
      definitions.set(definition.id, definition)
      return async () => { definitions.delete(definition.id) }
    },
    resolve: async (id) => ({ id }),
  }
  const sync = createPresetRegistrySync({ extend: () => ({ agentPresets: registry }) }, root)
  try {
    await sync.refresh()
    const original = definitions.get('alpha')
    writeFileSync(join(dir, 'agent.cordis.yml'), '- name: new\n')
    await assert.rejects(sync.refresh(), /注册刷新失败/)
    assert.equal(definitions.get('alpha'), original)
    assert.equal(definitions.size, 1, '候选注册必须清理')
    await sync.refresh()
    assert.equal(definitions.get('alpha').plugins[0].name, 'new')
  } finally { await sync.dispose() }
  assert.equal(definitions.size, 0)
})
