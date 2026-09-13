import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'

const home = mkdtempSync(join(tmpdir(), 'pt-preset-sync-'))
process.env.DSH_HOME = home
const { apply, writePluginState } = await import('../../lib/index.mjs')

const presetDir = join(home, '.agent-presets')
const preset = (id) => {
  mkdirSync(join(presetDir, id), { recursive: true })
  writeFileSync(join(presetDir, id, 'preset.yml'),
    `id: ${id}\nname: ${id}\nmodules: [prompt-config-engine]\n`, 'utf8')
}

function makeHarness(initial) {
  let promptState = { ...initial }
  let hostDefault = initial.presetTemplate
  let promptWatcher
  const listeners = new Map()
  const mutations = []

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
    get: (ns) => String(ns) === 'agent-presets' ? { default: hostDefault } : promptState,
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
    get: () => undefined,
  }
  const ctx = {
    logger: { warn: () => {} },
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
    getPromptState: () => promptState,
    setPresetRoot: (value) => settings.mutate('prompt-tool', [{ op: 'set', path: ['presetDir'], value }]),
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
  preset('creative')
  writePluginState({ seeded: true })
  const initial = {
    writeAgents: false,
    writePreset: false,
    presetTemplate: 'anchored',
    injectAgentsPrompt: false,
    skillOrder: [],
    skillsDirs: [],
    skillRankBase: 250,
    residentAgentsPath: join(home, 'AGENTS.md'),
    presetDir,
    presetOrder: 5,
    fallbackText: '',
  }
  const harness = makeHarness(initial)
  apply(harness.ctx, initial)
  assert.equal(harness.mutations.length, 0, '初始默认一致，不应产生同步写入')

  harness.emitOfficialDefault('creative')
  await Promise.resolve()

  const promptWrites = harness.mutations.filter((item) => item.ns === 'prompt-tool')
  assert.equal(promptWrites.length, 1, '官方默认切换应回写一次 prompt-tool settings')
  assert.deepEqual(promptWrites[0].ops,
    [{ op: 'set', path: ['presetTemplate'], value: 'creative' }])
  assert.equal(harness.getPromptState().presetTemplate, 'creative')
  assert.equal(harness.mutations.filter((item) => item.ns === 'agent-presets').length, 0,
    '反向同步后官方值已一致，不得再正向写回形成事件回环')

  harness.emitOfficialDefault('creative')
  await Promise.resolve()
  assert.equal(harness.mutations.filter((item) => item.ns === 'prompt-tool').length, 1,
    '相同官方默认值重复通知不得重复写入')
})


test('兼容快照已处理后，官方预设切换不会创建或复活 prompt-tool 目录', async () => {
  rmSync(presetDir, { recursive: true, force: true })
  preset('anchored')
  preset('creative')
  writePluginState({ seeded: true })
  const initial = {
    writeAgents: false,
    writePreset: true,
    presetTemplate: 'anchored',
    injectAgentsPrompt: false,
    skillOrder: [],
    skillsDirs: [],
    skillRankBase: 250,
    residentAgentsPath: join(home, 'AGENTS.md'),
    presetDir,
    presetOrder: 5,
    fallbackText: '',
  }
  const harness = makeHarness(initial)
  apply(harness.ctx, initial)
  assert.equal(existsSync(join(presetDir, 'prompt-tool')), false,
    '初始 rebuild 不得创建已处理的兼容快照')

  harness.emitOfficialDefault('creative')
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 20))

  assert.equal(harness.getPromptState().presetTemplate, 'creative')
  assert.equal(existsSync(join(presetDir, 'prompt-tool')), false,
    '切换预设后不得创建或复活 prompt-tool 兼容目录')
})
test('自定义预设根贯穿初始化、切换与同名预设换根，不污染默认根', async () => {
  const customRoot = mkdtempSync(join(home, 'custom-root-'))
  const otherRoot = mkdtempSync(join(home, 'other-root-'))
  for (const [root, id, usePtcMode, text] of [
    [presetDir, 'root-main', true, 'default'],
    [customRoot, 'root-main', false, 'custom-main'],
    [customRoot, 'root-next', true, 'custom-next'],
    [otherRoot, 'root-next', false, 'other-next'],
  ]) {
    mkdirSync(join(root, id), { recursive: true })
    writeFileSync(join(root, id, 'preset.yml'),
      `id: ${id}\nmodules: [code-presentation]\nparams:\n  usePtcMode: ${usePtcMode}\ncontent:\n  presetText: ${text}\n`, 'utf8')
  }
  const defaultFile = join(presetDir, 'root-main', 'preset.yml')
  const before = readFileSync(defaultFile, 'utf8')
  const initial = { writeAgents: false, writePreset: true, presetTemplate: 'root-main',
    injectAgentsPrompt: false, residentAgentsPath: join(home, 'AGENTS.md'),
    presetDir: customRoot, presetOrder: 5, fallbackText: '' }
  const harness = makeHarness(initial)
  apply(harness.ctx, initial)
  const ptc = (root, id) => parseYaml(readFileSync(join(root, id, 'agent.cordis.yml'), 'utf8'))
    .find(row => row.id === 'code-presentation').config.usePtcMode
  assert.equal(ptc(customRoot, 'root-main'), false)
  harness.emitOfficialDefault('root-next')
  await Promise.resolve()
  assert.equal(harness.getPromptState().presetTemplate, 'root-next')
  assert.equal(ptc(customRoot, 'root-next'), true)
  await harness.setPresetRoot(otherRoot)
  assert.equal(ptc(otherRoot, 'root-next'), false)
  assert.equal(readFileSync(join(otherRoot, 'root-next', 'preset.md'), 'utf8'), 'other-next')
  assert.equal(readFileSync(defaultFile, 'utf8'), before)
})

test.after(() => { rmSync(home, { recursive: true, force: true }) })
