import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 隔离 DSH_HOME：paths.ts 模块级常量在 import 时求值，必须先设 env 再动态 import lib。
const home = mkdtempSync(join(tmpdir(), 'pt-wp-off-'))
process.env.DSH_HOME = home
const { apply, writePluginState } = await import('../../lib/index.mjs')

function makeCtx(settingsValue) {
  const makeSctx = () => ({
    settings: {
      describe: () => [],
      register: (_ns, _schema, opts) => {
        try { opts.base() } catch { /* mock 环境无宿主上下文 */ }
        return { get: () => settingsValue, watch: (cb) => cb(settingsValue) }
      },
      mutate: async () => {},
    },
    webServer: { register: () => () => {} },
    commands: { register: () => () => {} },
    tools: { register: () => () => {} },
    effect: (fn) => { fn(); return () => {} },
    get: () => undefined,
  })
  return {
    logger: { warn: () => {} },
    effect: (fn) => { fn(); return () => {} },
    skills: { registerProvider: () => {} },
    get: (name) => (name === 'webServer' ? {} : undefined),
    baseUrl: 'http://localhost:3000',
    inject: (deps, cb) => { cb(makeSctx()); return () => {} },
  }
}

function settings(presetDir, writePreset) {
  return {
    writeAgents: true,
    writePreset,
    presetTemplate: 'anchored',
    injectAgentsPrompt: false,
    skillSwitches: {},
    skillOrder: [],
    skillsDirs: [],
    skillRankBase: 250,
    residentAgentsPath: join(home, 'AGENTS.md'),
    presetDir,
    presetOrder: 5,
    fallbackText: '',
  }
}

test('writePreset 关闭时只清理各预设目录生成物，保留 preset.yml 与预设根（防误删回归）', () => {
  const presetDir = join(home, '.agent-presets')
  mkdirSync(join(presetDir, 'anchored', 'prompt-configs'), { recursive: true })
  // 预置已种子化状态：避免 ensurePresetSeed 复制全部内置模板干扰预设根断言。
  writePluginState({ seeded: true })
  writeFileSync(join(presetDir, 'anchored', 'preset.yml'),
    'id: anchored\nname: Anchored\nmodules: [prompt-config-engine]\n', 'utf8')
  writeFileSync(join(presetDir, 'anchored', 'agent.cordis.yml'),
    '- id: x\n  name: ./engine/x.mjs\n', 'utf8')
  writeFileSync(join(presetDir, 'anchored', 'prompt-configs', '00-a.yml'), 'id: a\n', 'utf8')

  const value = settings(presetDir, false)
  apply(makeCtx(value, presetDir), value)

  // 生成物清理（宿主以 agent.cordis.yml 为准挂载，删除即停止注入）。
  assert.equal(existsSync(join(presetDir, 'anchored', 'agent.cordis.yml')), false, 'agent.cordis.yml 应被清理')
  assert.equal(existsSync(join(presetDir, 'anchored', 'prompt-configs')), false, 'prompt-configs 应被清理')
  // 参数源与预设根保留——绝不删除整个用户预设目录。
  assert.equal(existsSync(join(presetDir, 'anchored', 'preset.yml')), true, 'preset.yml 参数必须保留')
  assert.deepEqual(readdirSync(presetDir).sort(), ['anchored'], '预设根只应保留预设目录（状态已移出）')
})

test('writePreset 开启时不受影响：预设目录正常生成', () => {
  const presetDir = join(home, '.agent-presets-2')
  mkdirSync(join(presetDir, 'anchored'), { recursive: true })
  writePluginState({ seeded: true })
  writeFileSync(join(presetDir, 'anchored', 'preset.yml'),
    'id: anchored\nname: Anchored\nmodules: [prompt-config-engine]\n', 'utf8')

  const value = settings(presetDir, true)
  apply(makeCtx(value, presetDir), value)

  assert.equal(existsSync(join(presetDir, 'anchored', 'preset.yml')), true, 'writePreset=true 预设参数保留')
})
