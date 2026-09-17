import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 预设 id 安全化判据与内置预设探测：纯函数 + 文件系统探测，全部走隔离临时目录。
const {
  DEFAULT_PRESET_ID,
  EMPTY_OCCUPIED_PRESET_IDS,
  SAFE_PRESET_PREFIX,
  assertOutputIdSafe,
  detectShippedPresetIdsFromDisk,
  safePresetId,
  templateNameFor,
} = await import('../../lib/index.mjs')

const OCCUPIED = new Set(['standard', 'minimal', 'ptc'])

test('safePresetId：占用集合命中时加前缀，未命中保持原样', () => {
  assert.equal(SAFE_PRESET_PREFIX, 'pt-')
  assert.equal(DEFAULT_PRESET_ID, 'pt-standard')
  assert.equal(safePresetId('standard', OCCUPIED), 'pt-standard')
  assert.equal(safePresetId('ptc', OCCUPIED), 'pt-ptc')
  assert.equal(safePresetId('creative', OCCUPIED), 'creative')
  // 空集 = 不避让（探测不可用时的降级语义）。
  assert.equal(safePresetId('standard', EMPTY_OCCUPIED_PRESET_IDS), 'standard')
})

test('templateNameFor：包内精确命中优先 → 剥前缀 → 原样', () => {
  const packaged = (name) => name === 'standard' || name === 'creative'
  assert.equal(templateNameFor('creative', packaged), 'creative', '包内精确命中直接用')
  assert.equal(templateNameFor('pt-standard', packaged), 'standard', '安全 id 反查回包内模板')
  assert.equal(templateNameFor('standard-copy', packaged), 'standard-copy', '都无 → 原样（用户目录自渲染）')
  assert.equal(templateNameFor('pt-unknown', packaged), 'pt-unknown', '剥前缀也不命中 → 原样')
  // 包内自带同名安全模板时精确命中优先（不使用剥前缀结果）。
  const withSafeTemplate = (name) => name === 'pt-creative' || name === 'creative'
  assert.equal(templateNameFor('pt-creative', withSafeTemplate), 'pt-creative')
})

test('assertOutputIdSafe：占用即 fail loud 且给出安全替代，未占用放行', () => {
  assert.doesNotThrow(() => assertOutputIdSafe('creative', OCCUPIED))
  assert.doesNotThrow(() => assertOutputIdSafe('standard', EMPTY_OCCUPIED_PRESET_IDS))
  assert.throws(() => assertOutputIdSafe('standard', OCCUPIED), /永远不会被挂载/)
  assert.throws(() => assertOutputIdSafe('standard', OCCUPIED), /pt-standard/)
})

test('detectShippedPresetIdsFromDisk：hoisted profiles/node_modules 命中且忽略点目录', () => {
  const home = mkdtempSync(join(tmpdir(), 'pt-shipped-'))
  try {
    const presets = join(home, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-agent-presets', 'presets')
    mkdirSync(join(presets, 'standard'), { recursive: true })
    mkdirSync(join(presets, 'minimal'), { recursive: true })
    mkdirSync(join(presets, '.hidden'), { recursive: true })
    assert.deepEqual([...detectShippedPresetIdsFromDisk(home)].sort(), ['minimal', 'standard'])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('detectShippedPresetIdsFromDisk：各 profile 的 node_modules 与 pnpm 虚拟目录同样命中', () => {
  const home = mkdtempSync(join(tmpdir(), 'pt-shipped-nested-'))
  try {
    const profilePresets = join(home, 'profiles', 'web', 'node_modules', '@deepseek-ai', 'dsh-agent-presets', 'presets')
    mkdirSync(join(profilePresets, 'ptc'), { recursive: true })
    const pnpmPresets = join(
      home, 'profiles', 'node_modules', '.pnpm', '@deepseek-ai+dsh-agent-presets@0.1.6', 'node_modules',
      '@deepseek-ai', 'dsh-agent-presets', 'presets',
    )
    mkdirSync(join(pnpmPresets, 'cordis'), { recursive: true })
    assert.deepEqual([...detectShippedPresetIdsFromDisk(home)].sort(), ['cordis', 'ptc'])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('detectShippedPresetIdsFromDisk：结构缺失返回空集（降级为不避让，不抛错）', () => {
  const home = mkdtempSync(join(tmpdir(), 'pt-shipped-empty-'))
  try {
    assert.equal(detectShippedPresetIdsFromDisk(home).size, 0)
    assert.equal(detectShippedPresetIdsFromDisk(join(home, 'missing-home')).size, 0)
    // profiles 存在但不是目录（文件）时同样降级。
    mkdirSync(join(home, 'weird'))
    assert.equal(detectShippedPresetIdsFromDisk(join(home, 'weird')).size, 0)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
