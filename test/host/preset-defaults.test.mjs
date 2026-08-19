import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Config, mergePresetDefaults } from '../../lib/index.mjs'

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
      skillRankBase: 300,
      residentAgentsPath: '~/.dsh/AGENTS.md',
      presetDir: '~/.dsh/.agent-presets/prompt-tool',
      presetOrder: 9,
      fallbackText: 'FALLBACK',
      promptConfigsDir: 'C:/configs',
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
  assert.equal(merged.skillRankBase, 300)
  assert.equal(merged.presetOrder, 9)
  assert.equal(merged.promptConfigsDir, 'C:/configs')
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
  assert.equal(merged.skillsDir.length >= 0, true)
})

test('~/.dsh 路径跟随运行时 DSH_HOME，而不是写死操作系统 home', async () => {
  const previous = process.env.DSH_HOME
  const root = mkdtempSync(join(process.env.DSH_TEST_TEMP ?? tmpdir(), 'prompt-tool-dsh-home-'))
  process.env.DSH_HOME = root
  try {
    const fresh = await import(`../../lib/index.mjs?dsh-home=${process.pid}-${Date.now()}`)
    const merged = fresh.mergePresetDefaults(fresh.Config({}), {
      hostDefaults: {
        residentAgentsPath: '~/.dsh/AGENTS.md',
        presetDir: '~/.dsh/.agent-presets/prompt-tool',
        writePreset: true,
      },
    })
    assert.equal(merged.residentAgentsPath, join(root, 'AGENTS.md'))
    assert.equal(merged.presetDir, join(root, '.agent-presets', 'prompt-tool'))
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(root, { recursive: true, force: true })
  }
})

test('DSH_HOME 未设置或为空时回退到 OS home 下的 .dsh', async () => {
  const previous = process.env.DSH_HOME
  try {
    delete process.env.DSH_HOME
    const unset = await import(`../../lib/index.mjs?dsh-home-unset=${process.pid}-${Date.now()}`)
    const fromUnset = unset.mergePresetDefaults(unset.Config({}), {
      hostDefaults: { presetDir: '~/.dsh/.agent-presets/prompt-tool' },
    })
    assert.equal(fromUnset.presetDir, join(homedir(), '.dsh', '.agent-presets', 'prompt-tool'))

    process.env.DSH_HOME = '   '
    const empty = await import(`../../lib/index.mjs?dsh-home-empty=${process.pid}-${Date.now()}`)
    const fromEmpty = empty.mergePresetDefaults(empty.Config({}), {
      hostDefaults: { presetDir: '~/.dsh/.agent-presets/prompt-tool' },
    })
    assert.equal(fromEmpty.presetDir, join(homedir(), '.dsh', '.agent-presets', 'prompt-tool'))
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})
