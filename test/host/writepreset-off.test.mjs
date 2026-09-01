import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, readdirSync, readFileSync } from 'node:fs'
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
      installSection: (_owner, _ns, _schema, _entry, hooks) => {
        hooks.setSource(() => settingsValue)
        hooks.onChange()
      },
      get: () => undefined,
      mutate: async () => {},
    },
    webServer: { register: () => () => {} },
    commands: { register: () => () => {} },
    tools: { register: () => () => {} },
    effect: (fn) => { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
    on: () => () => {},
    get: () => undefined,
  })
  return {
    logger: { warn: () => {} },
    effect: (fn) => { fn(); return () => {} },
    skills: { registerProvider: () => {} },
    get: (name) => (name === 'webServer' ? {} : undefined),
    provide: () => () => {},
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

test('writePreset 关闭时清空组合为空数组，保留 preset.yml 与预设根（防误删回归 + 官方可挂载回归）', () => {
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

  // 组合改写为空数组而非删除：官方 discovery 对缺 agent.cordis.yml 的目录仍占用
  // id 并判 broken（挂载抛 agent-preset/invalid、picker 丢弃该行），导致无法新建
  // 会话与无法切换预设；空组合零行可正常挂载，等价「停止注入」语义。
  const compositionFile = join(presetDir, 'anchored', 'agent.cordis.yml')
  assert.equal(existsSync(compositionFile), true, 'agent.cordis.yml 应保留（空组合防 broken）')
  const composition = readFileSync(compositionFile, 'utf8')
  const rows = composition.split('\n').filter((line) => !line.startsWith('#') && line.trim().length > 0)
  assert.equal(rows.length > 0 && rows.every((line) => line.trim() === '[]'), true,
    '组合应为空数组（含注释头），实际为空组合')
  assert.equal(existsSync(join(presetDir, 'anchored', 'prompt-configs')), false, 'prompt-configs 应被清理')
  // 参数源与预设根保留——绝不删除整个用户预设目录。
  assert.equal(existsSync(join(presetDir, 'anchored', 'preset.yml')), true, 'preset.yml 参数必须保留')
  // 状态文件已移出预设根；ensurePresetSeed 会幂等补建全部内置预设目录，
  // 清理必须逐个保留其 preset.yml，不能删预设目录本身（防误删回归）。
  const dirs = readdirSync(presetDir).filter((name) => !name.startsWith('.')).sort()
  assert.deepEqual(dirs, ['anchored', 'creative', 'custom', 'liangshen', 'minimal', 'ptc', 'standard'].sort())
  for (const dir of dirs) {
    assert.equal(existsSync(join(presetDir, dir, 'preset.yml')), true, `${dir} 的 preset.yml 必须保留`)
    // 每个预设目录的组合都必须是空数组（关闭开关作用于全部预设，不只是激活预设）。
    const other = readFileSync(join(presetDir, dir, 'agent.cordis.yml'), 'utf8')
    const otherRows = other.split('\n').filter((line) => !line.startsWith('#') && line.trim().length > 0)
    assert.equal(otherRows.length > 0 && otherRows.every((line) => line.trim() === '[]'), true,
      `${dir} 的组合应为空数组`)
  }
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
