import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Config, mergePresetDefaults } from '../../lib/index.mjs'

const rootDir = fileURLToPath(new URL('../..', import.meta.url))

/** Node 26 起 import() query 不再强制重载 ESM 模块，改由子进程验证 DSH_HOME 动态性。 */
function probePresetDir(envDshHome) {
  const script = `
    const lib = await import('./lib/index.mjs')
    const merged = lib.mergePresetDefaults(lib.Config({}), {
      hostDefaults: { presetDir: '~/.dsh/.agent-presets/prompt-tool' },
    })
    console.log(JSON.stringify(merged.presetDir))
  `
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: rootDir,
    env: envDshHome === undefined
      ? { ...process.env, DSH_HOME: '' }
      : { ...process.env, DSH_HOME: envDshHome },
    encoding: 'utf8',
  })
  if (res.status !== 0) throw new Error(`probe failed: ${res.stderr}`)
  return JSON.parse(res.stdout.trim())
}

const expectedDshHome = process.env.DSH_HOME !== undefined && process.env.DSH_HOME.trim().length > 0
  ? resolve(process.env.DSH_HOME)
  : join(homedir(), '.dsh')

test('preset.yml params + hostDefaults 合并进 Config 作为唯一入口默认值', () => {
  const base = Config({})
  const spec = {
    params: {
      usePtcMode: true,
      firstTurnAnchor: true,
      firstTurnCustom: false,
      bootstrapMaxTokens: 2048,
    },
    hostDefaults: {
      writePreset: true,
      writeAgents: false,
      skillsDir: 'C:/skills',
      skillsDirs: ['~/my-skills'],
      skillRankBase: 300,
      residentAgentsPath: '~/.dsh/AGENTS.md',
      presetDir: '~/.dsh/.agent-presets/prompt-tool',
      presetOrder: 9,
      fallbackText: 'FALLBACK',
      promptConfigs: [{ id: 'custom', text: 'hello' }],
      skillSwitches: { sandboxmod: false },
      skillOrder: ['sandboxmod'],
    },
  }
  const merged = mergePresetDefaults(base, spec)
  assert.equal(merged.usePtcMode, true)
  assert.equal(merged.firstTurnAnchor, true)
  assert.equal(merged.bootstrapMaxTokens, 2048)
  assert.equal(merged.writeAgents, false)
  assert.equal(merged.skillsDir, 'C:/skills')
  assert.deepEqual(merged.skillsDirs, [join(homedir(), 'my-skills')])
  assert.equal(merged.skillRankBase, 300)
  assert.equal(merged.presetOrder, 9)
  assert.deepEqual(merged.promptConfigs, [{ id: 'custom', text: 'hello' }])
  assert.deepEqual(merged.skillSwitches, { sandboxmod: false })
  assert.deepEqual(merged.skillOrder, ['sandboxmod'])
  // ~/.dsh 路径按 DSH_HOME（未设置时为 OS home/.dsh）展开。
  assert.equal(merged.residentAgentsPath, join(expectedDshHome, 'AGENTS.md'))
  assert.equal(merged.presetDir, join(expectedDshHome, '.agent-presets', 'prompt-tool'))
})

test('优先级:cordis Config < preset.yml < settings;preset 覆盖 cordis 默认值', () => {
  const base = Config({ usePtcMode: false, writeAgents: true })
  const spec = { params: { usePtcMode: true }, hostDefaults: { writeAgents: false } }
  const merged = mergePresetDefaults(base, spec)
  assert.equal(merged.usePtcMode, true)
  assert.equal(merged.writeAgents, false)
})

test('preset 默认值只覆盖类型匹配字段,非法值被忽略', () => {
  const base = Config({})
  const merged = mergePresetDefaults(base, {
    params: { usePtcMode: 'on', bootstrapMaxTokens: -1 },
    hostDefaults: { writeAgents: 'not-a-bool', skillsDir: 42 },
  })
  assert.equal(merged.usePtcMode, true) // on → true
  assert.equal(merged.bootstrapMaxTokens, 0) // -1 非法,保持默认
  assert.equal(merged.writeAgents, true) // 非布尔忽略
  // 非法值被忽略（回退 schema 默认空），不炸校验。
  assert.equal(merged.skillsDir, '')
})

test('~/.dsh 路径跟随运行时 DSH_HOME，而不是写死操作系统 home', async () => {
  const root = mkdtempSync(join(process.env.DSH_TEST_TEMP ?? tmpdir(), 'prompt-tool-dsh-home-'))
  try {
    assert.equal(probePresetDir(root), join(root, '.agent-presets', 'prompt-tool'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('DSH_HOME 未设置或为空时回退到 OS home 下的 .dsh', async () => {
  assert.equal(probePresetDir(undefined), join(homedir(), '.dsh', '.agent-presets', 'prompt-tool'))
})
