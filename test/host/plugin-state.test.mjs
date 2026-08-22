import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 状态文件在 DSH_HOME 下、预设根之外：独立进程 + 临时 DSH_HOME 验证读写与旧标记迁移。
const home = mkdtempSync(join(tmpdir(), 'pt-state-'))
process.env.DSH_HOME = home
const {
  ensurePresetSeed,
  readPluginState,
  writePluginState,
} = await import('../../lib/index.mjs')

const STATE_FILE = join(home, '.prompt-tool-state.json')
const PRESETS_DIR = join(home, '.agent-presets')

test('writePluginState/readPluginState：原子写（tmp+rename）往返一致', () => {
  writePluginState({ seeded: true, paramsMigrated: false })
  assert.deepEqual(readPluginState(), { seeded: true, paramsMigrated: false })
  assert.equal(existsSync(`${STATE_FILE}.tmp`), false, '临时文件不应残留')
})

test('readPluginState：文件缺失/损坏返回空对象（按未标记处理）', () => {
  writePluginState({})
  assert.deepEqual(readPluginState(), {})
  writeFileSync(STATE_FILE, '{broken', 'utf8')
  assert.deepEqual(readPluginState(), {})
})

test('ensurePresetSeed：状态文件标记后不再种子化，删除不复活', () => {
  const first = ensurePresetSeed()
  assert.ok(first.created.length > 0, '首次应复制内置模板')
  assert.deepEqual(readPluginState().seeded, true, '种子化后应写状态文件')
  assert.equal(existsSync(join(PRESETS_DIR, '.pt-seeded')), false, '预设根内不再写 .pt-seeded')
  // 二次调用：状态已标记，不重复。
  assert.deepEqual(ensurePresetSeed().created, [])
})

test('ensurePresetSeed：兼容旧版预设根 .pt-seeded 标记（迁入状态文件并删除）', () => {
  // 清空状态（模拟旧版：无状态文件、只有预设根内标记）。
  writePluginState({})
  mkdirSync(PRESETS_DIR, { recursive: true })
  writeFileSync(join(PRESETS_DIR, '.pt-seeded'), '', 'utf8')
  const before = ensurePresetSeed()
  assert.deepEqual(before.created, [], '旧标记存在 = 已种子化，不重复复制')
  assert.equal(readPluginState().seeded, true, '旧标记应迁入状态文件')
  assert.equal(existsSync(join(PRESETS_DIR, '.pt-seeded')), false, '旧标记文件应删除')
})

test('安全边界：状态写入只影响自身文件，DSH_HOME 根其他文件不被删除/修改', () => {
  // 模拟 DSH_HOME 根下官方/用户文件（settings.yaml、AGENTS.md、profiles/ 等）。
  const settingsYaml = join(home, 'settings.yaml')
  const agentsMd = join(home, 'AGENTS.md')
  const profilesDir = join(home, 'profiles', 'web')
  writeFileSync(settingsYaml, 'appId: deepseek-harness\n', 'utf8')
  writeFileSync(agentsMd, '# AGENTS\n', 'utf8')
  mkdirSync(profilesDir, { recursive: true })
  writeFileSync(join(profilesDir, 'profile.yml'), 'id: web\n', 'utf8')

  const snapshot = () => ({
    settingsYaml: readFileSync(settingsYaml, 'utf8'),
    agentsMd: readFileSync(agentsMd, 'utf8'),
    profileYml: readFileSync(join(profilesDir, 'profile.yml'), 'utf8'),
    // 状态文件自身允许新增；DSH_HOME 根下其他条目必须不变。
    rootEntries: readdirSync(home).filter((name) => name !== '.prompt-tool-state.json').sort(),
  })
  const before = snapshot()

  // 多次状态读写（含旧标记迁移路径）。
  writePluginState({ seeded: true })
  writePluginState({ seeded: true, paramsMigrated: true })
  ensurePresetSeed()

  const after = snapshot()
  assert.deepEqual(after, before, 'DSH_HOME 根下其他文件必须逐字节不变、无新增/删除')
  assert.equal(existsSync(`${join(home, '.prompt-tool-state.json')}.tmp`), false, '原子写不得残留 tmp')
})
