import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  const sync = createPresetRegistrySync({ agentPresets: registry }, root)
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

    // 反例：同一份组合若不换算，相对说明符会从**宿主锚点**解析而失败——这正是装配期换算
    // 存在的理由（旧实现靠改写 baseUrl 才让这一行可解析，代价是包名行整份注册被拒）。
    const raw = await ctx.agentPresets.register({ id: 'raw-relative', plugins: [{ id: 'local', name: './local.mjs' }] })
    try {
      assert.notEqual((await ctx.agentPresets.resolve('raw-relative')).broken, undefined, '未换算的相对行必须失败')
    } finally { await raw() }

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

test('装配期换算：相对说明符绝对化，configsDir 与 !!js 保持原样', async () => {
  const root = join(home, 'absolutize')
  const dir = join(root, 'gamma')
  mkdirSync(join(dir, 'prompt-configs'), { recursive: true })
  writeFileSync(join(dir, 'preset.yml'), 'id: gamma\nname: Gamma\nmodules: []\n')
  writeFileSync(join(dir, 'local.mjs'), pluginSource)
  writeFileSync(join(dir, 'agent.cordis.yml'), [
    '- id: engine',
    '  name: ./local.mjs',
    '  config:',
    '    configsDir: ../gamma/prompt-configs',
    "    tool: !!js \"'gamma_tool'\"",
    '- id: group',
    '  name: cordis:group',
    '  group: true',
    '  config:',
    '    - id: nested',
    '      name: ./local.mjs',
    "      config: { tool: !!js \"'nested_tool'\" }",
    '- id: pkg',
    "  name: '@deepseek-ai/dsh-tool-pwsh'",
    '',
  ].join('\n'))
  const definitions = new Map()
  const registry = {
    register: async (definition) => {
      definitions.set(definition.id, definition)
      return async () => { definitions.delete(definition.id) }
    },
    resolve: async (id) => definitions.get(id),
  }
  const sync = createPresetRegistrySync({ agentPresets: registry }, root)
  try {
    await sync.refresh()
    const [engine, group, pkg] = definitions.get('gamma').plugins
    assert.equal(engine.name, pathToFileURL(join(dir, 'local.mjs')).href, '相对说明符换成绝对 file URL')
    assert.equal(engine.config.configsDir, '../gamma/prompt-configs', '引擎自解析键必须保持相对')
    assert.deepEqual(engine.config.tool, { __jsExpr: "'gamma_tool'" }, '!!js 表达式保持延迟节点')
    assert.equal(group.config[0].name, pathToFileURL(join(dir, 'local.mjs')).href, 'group 子行同样换算')
    assert.equal(pkg.name, '@deepseek-ai/dsh-tool-pwsh', '包名说明符不改写')
    assert.equal(readFileSync(join(dir, 'agent.cordis.yml'), 'utf8').includes('file://'), false, '正本不得写回绝对路径')
  } finally { await sync.dispose() }
})

test('装配期换算：引擎行识别、受管字段绝对化与 presetRoot 注入', async () => {
  const root = join(home, 'engine-rows')
  const dir = join(root, 'pt-eng')
  mkdirSync(join(dir, 'prompt-configs'), { recursive: true })
  writeFileSync(join(dir, 'preset.yml'), 'id: pt-eng\nname: Eng\nmodules: []\n')
  writeFileSync(join(dir, 'agent.cordis.yml'), [
    '- id: prompt-config-engine',
    '  name: dsh-plugin-prompt-tool/engine/prompt-config-engine.mjs',
    '  config:',
    '    configsDir: ../pt-eng/prompt-configs',
    '- id: legacy-engine',
    '  name: ../.engine/character-tools.mjs',
    '  config:',
    '    configsDir: ../pt-eng/prompt-configs',
    '',
    '- id: declared-triggers',
    '  name: dsh-plugin-prompt-tool/engine/declared-triggers.mjs',
    '  config:',
    '    triggersFile: ../pt-eng/triggers.yml',
  ].join('\n'))
  const definitions = new Map()
  const registry = {
    register: async (definition) => {
      definitions.set(definition.id, definition)
      return async () => { definitions.delete(definition.id) }
    },
    resolve: async (id) => definitions.get(id),
  }
  const sync = createPresetRegistrySync({ agentPresets: registry }, root)
  try {
    await sync.refresh()
    const [engine, legacy, triggers] = definitions.get('pt-eng').plugins
    assert.equal(engine.name, 'dsh-plugin-prompt-tool/engine/prompt-config-engine.mjs', '包名说明符不改写')
    assert.equal(
      engine.config.configsDir,
      pathToFileURL(join(root, 'pt-eng', 'prompt-configs')).href,
      '受管字段按历史语义（相对 <预设根>/.engine/）换算为绝对 file URL',
    )
    assert.equal(engine.config.presetRoot, `${pathToFileURL(root).href}/`, '引擎行必须注入预设根基准')
    // 不兼容旧布局：`../.engine/x.mjs` 不再是引擎行，按普通本地说明符换算到已不再物化的目录。
    assert.equal(legacy.name, pathToFileURL(join(root, '.engine', 'character-tools.mjs')).href)
    assert.equal(legacy.config.configsDir, '../pt-eng/prompt-configs', '非引擎行的字段不参与受管换算')
    assert.equal(legacy.config.presetRoot, undefined, '非引擎行不得注入 presetRoot（否则触发未知键报错）')
    assert.equal(triggers.name, 'dsh-plugin-prompt-tool/engine/declared-triggers.mjs')
    assert.equal(triggers.config.triggersFile, pathToFileURL(join(dir, 'triggers.yml')).href)
    assert.equal(triggers.config.presetRoot, `${pathToFileURL(root).href}/`)
    assert.equal(existsSync(join(root, '.engine')), false, '声明挂载不需要物化引擎目录')
    mkdirSync(join(dir, 'assets'))
    writeFileSync(join(dir, 'assets', 'notice.txt'), 'PACKAGE ENGINE DATA')
    writeFileSync(join(dir, 'triggers.yml'), JSON.stringify([{ id: 'notice', channel: 'agent/pre-step', do: { kind: 'inject-text', config: { id: 'notice', layer: 'pre-step', templateFile: './assets/notice.txt' } } }]))
    const events = new Map(), disposers = []
    const recorder = { get: () => undefined, on: (event, fn) => { events.set(event, fn); return () => events.delete(event) }, effect: fn => { disposers.push(fn()) } }
    const { apply } = await import('../../engine/declared-triggers.mjs')
    await apply(recorder, triggers.config)
    const user = { id: 'u', role: 'user', content: [{ type: 'text', text: 'USER' }], source: { kind: 'user' } }
    const result = await events.get('agent/pre-step')({ agent: { session: { id: 'registered', header: {}, snapshotEvents: () => [] }, options: { model: 'deepseek-chat' } }, messages: [user] }, () => ({ kind: 'enter', messages: [user] }))
    assert.equal(result.messages[1].content[0].text, 'PACKAGE ENGINE DATA')
    for (const dispose of disposers.reverse()) dispose?.()
  } finally { await sync.dispose() }
})

test('注册刷新排队期间卸载：待执行任务不得重新注册', async () => {
  let registrations = 0
  const sync = createPresetRegistrySync({ get agentPresets() { registrations++; throw new Error('不得重新注册') } }, join(home, 'presets'))
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
  const sync = createPresetRegistrySync({ agentPresets: registry }, root)
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
