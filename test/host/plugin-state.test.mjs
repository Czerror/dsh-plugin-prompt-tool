import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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
  writePluginState({ seeded: true })
  assert.deepEqual(readPluginState(), { seeded: true })
  assert.equal(existsSync(`${STATE_FILE}.tmp`), false, '临时文件不应残留')
})

test('readPluginState：文件缺失/损坏返回空对象（按未标记处理）', () => {
  writePluginState({})
  assert.deepEqual(readPluginState(), {})
  writeFileSync(STATE_FILE, '{broken', 'utf8')
  assert.deepEqual(readPluginState(), {})
})

test('ensurePresetSeed：状态文件标记兼容保留，删除后自动补建恢复', () => {
  const first = ensurePresetSeed()
  assert.ok(first.created.length > 0, '首次应复制内置模板')
  assert.deepEqual(readPluginState().seeded, true, '种子化后应写状态文件')
  assert.equal(existsSync(join(PRESETS_DIR, '.pt-seeded')), false, '预设根内不写种子标记')
  // 二次调用幂等：全部存在时不重复复制。
  assert.deepEqual(ensurePresetSeed().created, [])
  // 删除某个内置预设后，种子化自动补建（seeded 标记不再是「永不恢复」闸门）。
  const id = first.created[0]
  assert.ok(typeof id === 'string' && id.length > 0)
  rmSync(join(PRESETS_DIR, id), { recursive: true, force: true })
  assert.ok(ensurePresetSeed().created.includes(id), '删除的内置预设应被补建恢复')
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

  // 多次状态读写 + 种子化。
  writePluginState({ seeded: true })
    writePluginState({ seeded: true })
  ensurePresetSeed()

  const after = snapshot()
  assert.deepEqual(after, before, 'DSH_HOME 根下其他文件必须逐字节不变、无新增/删除')
  assert.equal(existsSync(`${join(home, '.prompt-tool-state.json')}.tmp`), false, '原子写不得残留 tmp')
})
