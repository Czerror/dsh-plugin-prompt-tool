import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 种子化只发生在预设根内：独立进程 + 临时 DSH_HOME 验证补建、幂等与安全边界。
const home = mkdtempSync(join(tmpdir(), 'pt-seed-'))
process.env.DSH_HOME = home
const { ensurePresetSeed } = await import('../../lib/index.mjs')

const PRESETS_DIR = join(home, '.agent-presets')
const STATE_FILE = join(home, '.prompt-tool-state.json')

test('ensurePresetSeed：首次复制内置模板，二次幂等，删除后自动补建', () => {
  const first = ensurePresetSeed()
  assert.ok(first.created.length > 0, '首次应复制内置模板')
  assert.equal(existsSync(join(PRESETS_DIR, '.pt-seeded')), false, '预设根内不写种子标记')
  // 二次调用幂等：全部存在时不重复复制。
  assert.deepEqual(ensurePresetSeed().created, [])
  // 删除某个内置预设后，种子化自动补建（无「永不恢复」闸门）。
  const id = first.created[0]
  assert.ok(typeof id === 'string' && id.length > 0)
  rmSync(join(PRESETS_DIR, id), { recursive: true, force: true })
  assert.ok(ensurePresetSeed().created.includes(id), '删除的内置预设应被补建恢复')
})

test('种子化不写状态文件，也不改动 DSH_HOME 根下其他文件', () => {
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
    rootEntries: readdirSync(home).sort(),
  })
  const before = snapshot()

  ensurePresetSeed()

  assert.deepEqual(snapshot(), before, 'DSH_HOME 根下其他文件必须逐字节不变、无新增/删除')
  assert.equal(existsSync(STATE_FILE), false, '插件不再写 DSH_HOME 根状态文件')
  assert.equal(existsSync(`${STATE_FILE}.tmp`), false, '不得残留临时文件')
})
