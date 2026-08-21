import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// migrateLegacyLayout / normalizePresetRootDir 为纯函数，不依赖 DSH_HOME。
const { migrateLegacyLayout, normalizePresetRootDir } = await import('../../lib/index.mjs')

function makeLegacyLayout(root) {
  // 旧容器根：.agent-presets/prompt-tool/{engine, agent.cordis.yml, anchored/}
  const container = join(root, '.agent-presets', 'prompt-tool')
  mkdirSync(join(container, 'engine'), { recursive: true })
  writeFileSync(join(container, 'engine', 'prompt-config-engine.mjs'), 'engine-stub', 'utf8')
  writeFileSync(join(container, 'agent.cordis.yml'), 'forward-stub', 'utf8')
  mkdirSync(join(container, 'anchored'), { recursive: true })
  writeFileSync(join(container, 'anchored', 'agent.cordis.yml'), 'child-stub', 'utf8')
  // 旧用户预设目录：~/.dsh/presets/{anchored, custom}/preset.yml + .seeded
  const userPresets = join(root, 'presets')
  mkdirSync(join(userPresets, 'anchored'), { recursive: true })
  writeFileSync(join(userPresets, 'anchored', 'preset.yml'), 'id: anchored\nname: Anchored\n', 'utf8')
  mkdirSync(join(userPresets, 'custom'), { recursive: true })
  writeFileSync(join(userPresets, 'custom', 'preset.yml'), 'id: custom\nname: Custom\n', 'utf8')
  writeFileSync(join(userPresets, '.seeded'), '', 'utf8')
  return { container, userPresets }
}

test('migrateLegacyLayout：旧布局 → 官方对齐布局（引擎/用户预设迁移 + 旧目录归档）', () => {
  const root = join(tmpdir(), `prompt-tool-migration-${process.pid}-${Date.now()}`)
  const { container, userPresets } = makeLegacyLayout(root)
  const presetRoot = join(root, '.agent-presets')
  try {
    const migrated = migrateLegacyLayout(presetRoot, userPresets)
    assert.equal(migrated, true, '应报告发生迁移')
    // 1) 共享引擎：容器根 engine/ → 预设根 .engine/
    assert.ok(existsSync(join(presetRoot, '.engine', 'prompt-config-engine.mjs')), '共享引擎应迁移到 .engine')
    assert.equal(existsSync(join(container, 'engine')), false, '旧容器根 engine 不再存在（已 rename）')
    // 2) 用户预设：~/.dsh/presets/* → 预设根/<id>/
    assert.ok(existsSync(join(presetRoot, 'anchored', 'preset.yml')), 'anchored 参数应迁移到预设根')
    assert.ok(existsSync(join(presetRoot, 'custom', 'preset.yml')), 'custom 参数应迁移到预设根')
    // 3) 旧目录归档（.bak 保留安全网，不删除）
    const baks = readdirSync(presetRoot).filter((name) => name.includes('.bak-'))
    assert.ok(baks.some((name) => name.startsWith('prompt-tool.bak-')), `旧容器根应归档（实际: ${baks.join(', ')}）`)
    const rootBaks = readdirSync(root).filter((name) => name.startsWith('presets.bak-'))
    assert.ok(rootBaks.length > 0, `旧用户目录应归档为 presets.bak-*（实际: ${rootBaks.join(', ')}）`)
    // 4) 幂等：再次调用不再迁移（旧目录已归档）
    assert.equal(migrateLegacyLayout(presetRoot, userPresets), false, '重复调用不应再迁移')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('migrateLegacyLayout：无旧布局时零操作', () => {
  const root = join(tmpdir(), `prompt-tool-migration-none-${process.pid}-${Date.now()}`)
  mkdirSync(join(root, '.agent-presets'), { recursive: true })
  try {
    assert.equal(migrateLegacyLayout(join(root, '.agent-presets'), join(root, 'presets')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('normalizePresetRootDir：旧容器根/旧用户目录归一化为预设根，其余原样', () => {
  const root = 'C:/dsh-home'
  const presetRoot = join(root, '.agent-presets')
  const legacyContainer = join(presetRoot, 'prompt-tool')
  assert.equal(normalizePresetRootDir(legacyContainer, presetRoot, legacyContainer), presetRoot)
  assert.equal(normalizePresetRootDir(join(presetRoot, 'prompt-tool'), presetRoot, legacyContainer), presetRoot)
  assert.equal(normalizePresetRootDir(join(root, 'presets'), presetRoot, legacyContainer), join(root, 'presets'))
  assert.equal(normalizePresetRootDir(join(root, 'custom-root'), presetRoot, legacyContainer), join(root, 'custom-root'))
})
