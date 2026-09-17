import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'pt-preset-sync-'))
process.env.DSH_HOME = home
const { apply, writePluginState } = await import('../../lib/index.mjs')

const presetDir = join(home, '.agent-presets')
const preset = (id) => {
  mkdirSync(join(presetDir, id), { recursive: true })
  writeFileSync(join(presetDir, id, 'preset.yml'),
    `id: ${id}\nname: ${id}\nmodules: [prompt-config-engine]\n`, 'utf8')
}

function makeHarness(initial, options = {}) {
  let promptState = { ...initial }
  let hostDefault = initial.presetTemplate
  let promptWatcher
  const listeners = new Map()
  const mutations = []
  const warnings = []
  const hostDocument = () => ({
    default: hostDefault,
    ...options.modeSelectionEnabled === undefined ? {} : { modeSelectionEnabled: options.modeSelectionEnabled },
  })

  const settings = {
    describe: () => [],
    register: () => ({
      get: () => promptState,
      watch: (callback) => { promptWatcher = callback; return () => { promptWatcher = undefined } },
    }),
    installSection: (_owner, _ns, _schema, _entry, hooks) => {
      hooks.setSource(() => promptState)
      hooks.onChange()
      promptWatcher = (next, _previous) => {
        promptState = next
        hooks.setSource(() => promptState)
        hooks.onChange()
      }
    },
    get: (ns) => String(ns) === 'agent-presets' ? hostDocument() : promptState,
    mutate: async (ns, ops) => {
      mutations.push({ ns: String(ns), ops })
      if (String(ns) === 'prompt-tool') {
        const previous = promptState
        const next = { ...promptState }
        for (const op of ops) {
          if (op.op === 'set' && op.path.length === 1) next[op.path[0]] = op.value
        }
        promptState = next
        promptWatcher?.(next, previous)
      } else if (String(ns) === 'agent-presets') {
        for (const op of ops) {
          if (op.op === 'set' && op.path[0] === 'default') hostDefault = op.value
        }
      }
    },
  }
  const sctx = {
    settings,
    webServer: { register: () => () => {} },
    commands: { register: () => () => {} },
    tools: { register: () => () => {} },
    effect: (factory) => { const dispose = factory(); return typeof dispose === 'function' ? dispose : () => {} },
    on: (event, callback) => {
      const entries = listeners.get(event) ?? []
      entries.push(callback)
      listeners.set(event, entries)
      return () => { listeners.set(event, (listeners.get(event) ?? []).filter((item) => item !== callback)) }
    },
    // 官方 agent-presets 服务面：把策略关掉后，生效默认值只有它能给出。
    get: (name) => name === 'agentPresets' && options.serviceDefaultId !== undefined
      ? { get defaultId() { return options.serviceDefaultId } }
      : undefined,
  }
  const ctx = {
    logger: { warn: (message) => { warnings.push(String(message)) } },
    effect: (factory) => { const dispose = factory(); return typeof dispose === 'function' ? dispose : () => {} },
    // 真实 cordis Context 提供事件订阅；插件用它订阅 provider 拓扑变化失效模型目录。
    on: () => () => {},
    skills: { registerProvider: () => {} },
    get: (name) => name === 'webServer' ? {} : undefined,
    provide: () => () => {},
    baseUrl: 'http://localhost:3000',
    inject: (_deps, callback) => { callback(sctx); return () => {} },
  }
  return {
    ctx,
    mutations,
    warnings,
    getPromptState: () => promptState,
    /** 模拟工作台里切换预设：写入本插件 settings 并触发 onChange → applyState → 正向同步。 */
    switchPreset: (id) => {
      const previous = promptState
      promptState = { ...promptState, presetTemplate: id }
      promptWatcher?.(promptState, previous)
    },
    emitOfficialDefault: (value) => {
      hostDefault = value
      for (const callback of listeners.get('settings/updated') ?? []) {
        callback('agent-presets', { default: value }, { default: initial.presetTemplate }, 'user')
      }
    },
  }
}

test('官方 agent-presets.default 变化反向同步 prompt-tool.presetTemplate 且不回环', async () => {
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
  assert.deepEqual(promptWrites[0].ops,
    [{ op: 'set', path: ['presetTemplate'], value: 'demo-preset' }])
  assert.equal(harness.getPromptState().presetTemplate, 'demo-preset')
  assert.equal(harness.mutations.filter((item) => item.ns === 'agent-presets').length, 0,
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
  assert.equal(harness.mutations.filter((item) => item.ns === 'agent-presets').length, 0,
    '策略关闭时不得写入 default')

  // 工作台切换：写入被忽略，因此必须告警且不产生 agent-presets 写入。
  harness.switchPreset('minimal')
  await Promise.resolve()
  assert.equal(harness.mutations.filter((item) => item.ns === 'agent-presets').length, 0,
    '策略关闭时正向同步不得落盘')
  harness.switchPreset('anchored')
  await Promise.resolve()
  const policyWarnings = harness.warnings.filter((message) => message.includes('modeSelectionEnabled=false'))
  assert.equal(policyWarnings.length, 1, '同一进程只告警一次')
})

test('宿主未声明策略时保持原行为：正向写入 default，反向跟随存储值', async () => {
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
  const writes = harness.mutations.filter((item) => item.ns === 'agent-presets')
  assert.equal(writes.length, 1, '缺省策略下切换仍需写入宿主 default')
  assert.deepEqual(writes[0].ops, [{ op: 'set', path: ['default'], value: 'demo-preset' }])
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
test.after(() => { rmSync(home, { recursive: true, force: true }) })
