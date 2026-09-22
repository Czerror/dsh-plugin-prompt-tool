import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Document } from 'yaml'

const home = mkdtempSync(join(tmpdir(), 'pt-preset-sync-'))
process.env.DSH_HOME = home
const { apply: applyPlugin, writePluginState } = await import('../../src/index.ts')
const apply = (ctx) => applyPlugin(ctx, ctx.config)
const cleanup = []

const presetDir = join(home, '.agent-presets')
const preset = (id, layerSettings = {}) => {
  mkdirSync(join(presetDir, id), { recursive: true })
  writeFileSync(join(presetDir, id, 'preset.yml'),
    new Document({ id, name: id, modules: ['prompt-config-engine'], layerSettings }).toString(), 'utf8')
}

function makeHarness(initial, options = {}) {
  let promptState = { ...initial }
  let hostDefault = options.hostDefault ?? initial.presetTemplate
  const listeners = new Map()
  const mutations = []
  const warnings = []
  const registrations = new Map()
  const effects = []
  const effect = (factory) => {
    const dispose = factory()
    if (typeof dispose === 'function') effects.push(dispose)
    return typeof dispose === 'function' ? dispose : () => {}
  }
  const dispose = async () => { for (const release of effects.splice(0).reverse()) await release() }
  cleanup.push(dispose)
  const registry = {
    get defaultId() { return options.serviceDefaultId ?? hostDefault },
    register: async (definition) => {
      assert.equal(registrations.has(definition.id), false)
      registrations.set(definition.id, definition)
      return async () => { if (registrations.get(definition.id) === definition) registrations.delete(definition.id) }
    },
    resolve: async (id) => ({ id }),
  }
  const hostDocument = () => ({
    ...options.omitSelectedDefault ? {} : { selectedDefault: hostDefault },
    ...options.modeSelectionEnabled === undefined ? {} : { modeSelectionEnabled: options.modeSelectionEnabled },
  })

  const settings = {
    describe: () => [
      { ns: 'prompt-tool', value: promptState },
      { ns: 'agent-preset-registry', value: hostDocument() },
    ],
    configure: () => () => {},
    update: async (ns, patch) => {
      mutations.push({ ns: String(ns), patch })
      if (String(ns) === 'prompt-tool') {
        promptState = { ...promptState, ...patch }
      } else if (String(ns) === 'agent-preset-registry') {
        hostDefault = patch.selectedDefault
      }
      for (const callback of listeners.get('settings/document-updated') ?? []) callback(ns, 1)
    },
  }
  const sctx = {
    settings,
    webServer: { register: () => () => {} },
    commands: { register: () => () => {} },
    tools: { register: () => () => {} },
    effect,
    extend: () => ({ agentPresets: registry }),
    on: (event, callback) => {
      const entries = listeners.get(event) ?? []
      entries.push(callback)
      listeners.set(event, entries)
      return () => { listeners.set(event, (listeners.get(event) ?? []).filter((item) => item !== callback)) }
    },
    // 官方 agent-presets 服务面：把策略关掉后，生效默认值只有它能给出。
    get: (name) => name === 'agentPresets' ? registry : undefined,
  }
  const ctx = {
    config: Object.fromEntries(Object.keys(initial).map((key) => [key, { get: () => promptState[key] }])),
    logger: { warn: (message) => { warnings.push(String(message)) } },
    effect,
    // 真实 cordis Context 提供事件订阅；插件用它订阅 provider 拓扑变化失效模型目录。
    on: () => () => {},
    skills: { registerProvider: (factory) => {
      const controller = new AbortController()
      factory({ signal: controller.signal, invalidate: () => {} })
      return () => controller.abort()
    } },
    get: (name) => name === 'webServer' ? {} : name === 'agentDefaultModel' ? options.defaultModel : undefined,
    provide: () => () => {},
    baseUrl: 'http://localhost:3000',
    inject: (deps, callback) => {
      if (!deps.includes('agentPresets') || options.serviceDefaultId !== undefined || options.enableRegistry) callback(sctx)
      return () => {}
    },
  }
  return {
    ctx,
    mutations,
    warnings,
    registrations,
    dispose,
    getPromptState: () => promptState,
    getHostDefault: () => hostDefault,
    /** 模拟工作台里切换预设：写入本插件 settings 并触发 onChange → applyState → 正向同步。 */
    switchPreset: (id) => {
      promptState = { ...promptState, presetTemplate: id }
      for (const callback of listeners.get('settings/document-updated') ?? []) callback('prompt-tool', 1)
    },
    emitOfficialDefault: (value) => {
      hostDefault = value
      for (const callback of listeners.get('settings/document-updated') ?? []) {
        callback('agent-preset-registry', 1)
      }
    },
  }
}

test('预设模型参数只归当前预设，启动与切换不回写宿主全局默认模型', async () => {
  preset('route-a', { 'agent-request': { modelProvider: 'provider-a', modelName: 'model-a', modelReasoningEffort: 'high' } })
  preset('route-b')
  writePluginState({ seeded: true })
  const globalSelection = { provider: 'host-provider', model: 'host-model' }
  const writes = []
  const initial = { writePreset: true, presetTemplate: 'route-a', presetOrder: 5, fallbackText: '' }
  const harness = makeHarness(initial, { defaultModel: {
    currentSelection: () => globalSelection,
    saveSelection: async selection => { writes.push(selection) },
  } })
  apply(harness.ctx, initial)
  await Promise.resolve()
  assert.deepEqual(writes, [], '加载 A 的预设模型不能影响全局默认')
  harness.switchPreset('route-b')
  await Promise.resolve()
  assert.deepEqual(writes, [], '切换到未配置模型的 B 不应继承 A 回写的全局值')
})

test('官方 selectedDefault 变化反向同步 prompt-tool.presetTemplate 且不回环', async () => {
  preset('anchored')
  preset('demo-preset')
  writePluginState({ seeded: true })
  const initial = {
    writePreset: false,
    presetTemplate: 'anchored',
    skillOrder: [],
    skillsDirs: [],
    skillRankBase: 250,
    presetOrder: 5,
    fallbackText: '',
  }
  const harness = makeHarness(initial)
  apply(harness.ctx, initial)
  assert.equal(harness.mutations.length, 0, '初始默认一致，不应产生同步写入')

  harness.emitOfficialDefault('demo-preset')
  await Promise.resolve()

  const promptWrites = harness.mutations.filter((item) => item.ns === 'prompt-tool')
  assert.equal(promptWrites.length, 1, '官方默认切换应回写一次 prompt-tool settings')
  assert.deepEqual(promptWrites[0].patch, { presetTemplate: 'demo-preset' })
  assert.equal(harness.getPromptState().presetTemplate, 'demo-preset')
  assert.equal(harness.mutations.filter((item) => item.ns === 'agent-preset-registry').length, 0,
    '反向同步后官方值已一致，不得再正向写回形成事件回环')

  harness.emitOfficialDefault('demo-preset')
  await Promise.resolve()
  assert.equal(harness.mutations.filter((item) => item.ns === 'prompt-tool').length, 1,
    '相同官方默认值重复通知不得重复写入')
})


test('宿主关闭模式选择时：不假装同步，跟随服务生效默认值并只告警一次', async () => {
  rmSync(presetDir, { recursive: true, force: true })
  preset('anchored')
  preset('demo-preset')
  preset('minimal')
  writePluginState({ seeded: true })
  const initial = {
    writePreset: false,
    presetTemplate: 'anchored',
    skillOrder: [],
    skillsDirs: [],
    skillRankBase: 250,
    presetOrder: 5,
    fallbackText: '',
  }
  // 宿主关掉模式选择：存储值仍是 anchored，但生效默认值由 config.default 决定（demo-preset）。
  const harness = makeHarness(initial, { modeSelectionEnabled: false, serviceDefaultId: 'demo-preset' })
  apply(harness.ctx, initial)
  await Promise.resolve()

  assert.equal(harness.getPromptState().presetTemplate, 'demo-preset',
    '关闭策略后应跟随服务生效默认值，而不是存储值')
  assert.equal(harness.mutations.filter((item) => item.ns === 'agent-preset-registry').length, 0,
    '策略关闭时不得写入 default')

  // 工作台切换：写入被忽略，因此必须告警且不产生 agent-presets 写入。
  harness.switchPreset('minimal')
  await Promise.resolve()
  assert.equal(harness.mutations.filter((item) => item.ns === 'agent-preset-registry').length, 0,
    '策略关闭时正向同步不得落盘')
  harness.switchPreset('anchored')
  await Promise.resolve()
  const policyWarnings = harness.warnings.filter((message) => message.includes('modeSelectionEnabled=false'))
  assert.equal(policyWarnings.length, 1, '同一进程只告警一次')
})

test('宿主未声明策略时：正向写入 selectedDefault，反向跟随存储值', async () => {
  rmSync(presetDir, { recursive: true, force: true })
  preset('anchored')
  preset('demo-preset')
  writePluginState({ seeded: true })
  const initial = {
    writePreset: false,
    presetTemplate: 'anchored',
    skillOrder: [],
    skillsDirs: [],
    skillRankBase: 250,
    presetOrder: 5,
    fallbackText: '',
  }
  const harness = makeHarness(initial)
  apply(harness.ctx, initial)
  await Promise.resolve()
  assert.equal(harness.getPromptState().presetTemplate, 'anchored', '缺省策略下初始值不变')
  assert.equal(harness.mutations.length, 0, '初始一致不写入')

  harness.switchPreset('demo-preset')
  await Promise.resolve()
  const writes = harness.mutations.filter((item) => item.ns === 'agent-preset-registry')
  assert.equal(writes.length, 1, '缺省策略下切换仍需写入宿主 default')
  assert.deepEqual(writes[0].patch, { selectedDefault: 'demo-preset' })
  assert.equal(harness.warnings.filter((message) => message.includes('modeSelectionEnabled')).length, 0,
    '未声明策略时不得误报')
})

test('兼容快照已处理后，官方预设切换不会创建或复活 prompt-tool 目录', async () => {
  rmSync(presetDir, { recursive: true, force: true })
  preset('anchored')
  preset('demo-preset')
  writePluginState({ seeded: true })
  const initial = {
    writePreset: true,
    presetTemplate: 'anchored',
    skillOrder: [],
    skillsDirs: [],
    skillRankBase: 250,
    presetOrder: 5,
    fallbackText: '',
  }
  const harness = makeHarness(initial)
  apply(harness.ctx, initial)
  assert.equal(existsSync(join(presetDir, 'prompt-tool')), false,
    '初始 rebuild 不得创建已处理的兼容快照')

  harness.emitOfficialDefault('demo-preset')
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 20))

  assert.equal(harness.getPromptState().presetTemplate, 'demo-preset')
  assert.equal(existsSync(join(presetDir, 'prompt-tool')), false,
    '切换预设后不得创建或复活 prompt-tool 兼容目录')
})
test('启动时插件选 pt-standard 而宿主指向官方 standard：同步实际用户预设且幂等', async () => {
  preset('pt-standard')
  const initial = { writePreset: true, presetTemplate: 'pt-standard', presetOrder: 5, fallbackText: '' }
  const harness = makeHarness(initial, { hostDefault: 'standard' })
  apply(harness.ctx, initial)
  await Promise.resolve()
  assert.equal(harness.getHostDefault(), 'pt-standard')
  assert.equal(harness.getPromptState().presetTemplate, 'pt-standard')
  assert.equal(harness.mutations.filter((entry) => entry.ns === 'agent-preset-registry').length, 1)
  harness.emitOfficialDefault('pt-standard')
  await Promise.resolve()
  assert.equal(harness.mutations.filter((entry) => entry.ns === 'agent-preset-registry').length, 1)
})

test('selectedDefault 未设置时跟随服务的部署默认；启动、重建与卸载接线到 registry', async () => {
  rmSync(presetDir, { recursive: true, force: true })
  preset('wire-a')
  preset('wire-b')
  writePluginState({ seeded: true })
  const initial = { writePreset: false, presetTemplate: 'wire-a', presetOrder: 5, fallbackText: '' }
  const harness = makeHarness(initial, { omitSelectedDefault: true, serviceDefaultId: 'wire-b' })
  apply(harness.ctx, initial)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(harness.getPromptState().presetTemplate, 'wire-b')
  assert.equal(harness.registrations.has('wire-a'), true)
  assert.equal(harness.registrations.has('wire-b'), true)
  assert.ok([...harness.registrations.values()].every((definition) => definition.plugins.length === 0), '关闭写入时注册可用空组合')
  const old = harness.registrations.get('wire-a')
  harness.switchPreset('wire-a')
  await new Promise((resolve) => setImmediate(resolve))
  assert.notEqual(harness.registrations.get('wire-a'), old, '重建必须刷新注册代际')
  await harness.dispose()
  assert.equal(harness.registrations.size, 0, '卸载必须撤销所属注册')
})

test.after(async () => {
  try { for (const dispose of cleanup) await dispose() }
  finally { rmSync(home, { recursive: true, force: true }) }
})
