import { test } from 'node:test'
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Config, mergePresetDefaults } from '../../lib/index.mjs'

test('preset.yml params + hostDefaults 合并进 Config 作为唯一入口默认值', () => {
  const base = Config({})
  const spec = {
    params: {
      usePtcMode: true,
      anchorFirstTurn: true,
      anchorCustom: false,
      subagentFlash: false,
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
  assert.equal(merged.anchorFirstTurn, true)
  assert.equal(merged.bootstrapMaxTokens, 2048)
  assert.equal(merged.writeAgents, false)
  assert.equal(merged.skillsDir, 'C:/skills')
  assert.equal(merged.skillRankBase, 300)
  assert.equal(merged.presetOrder, 9)
  assert.equal(merged.promptConfigsDir, 'C:/configs')
  assert.deepEqual(merged.promptConfigs, [{ id: 'custom', text: 'hello' }])
  assert.deepEqual(merged.skillSwitches, { sandboxmod: false })
  assert.deepEqual(merged.skillOrder, ['sandboxmod'])
  // ~/ 路径展开为真实 home 路径，绝不把字面量 `~` 目录写进进程 cwd。
  assert.equal(merged.residentAgentsPath, join(homedir(), '.dsh', 'AGENTS.md'))
  assert.equal(merged.presetDir, join(homedir(), '.dsh', '.agent-presets', 'prompt-tool'))
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
