import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 安装副本目标固定在 DSH_HOME 技能根（官方 user-dsh 来源）：隔离 DSH_HOME 后加载。
const home = mkdtempSync(join(tmpdir(), `prompt-tool-skills-home-${process.pid}-`))
process.env.DSH_HOME = home
const { resolveSkillsDir } = await import('../../lib/index.mjs')

const TARGET_DIR = join(home, 'skills')
const LEDGER = join(TARGET_DIR, '.prompt-tool-manifest.json')
after(() => rmSync(home, { recursive: true, force: true }))

/** 每个用例独立的包内 skills 源目录（模拟包根下的 skills/）。 */
function makeSource() {
  const root = mkdtempSync(join(tmpdir(), `prompt-tool-skills-src-${process.pid}-`))
  const sourceDir = join(root, 'skills')
  mkdirSync(sourceDir, { recursive: true })
  return { sourceDir, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

function writeSkill(root, folder, content) {
  const dir = join(root, folder)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), content, 'utf8')
}

function readLedger() {
  return JSON.parse(readFileSync(LEDGER, 'utf8'))
}

test('resolveSkillsDir：首启把包内技能复制到 $DSH_HOME/skills 并写内容哈希账本', () => {
  rmSync(TARGET_DIR, { recursive: true, force: true })
  const { sourceDir, cleanup } = makeSource()
  try {
    writeSkill(sourceDir, 'demo-skill', '---\nname: demo-skill\n---\nV1')

    const targetDir = resolveSkillsDir(sourceDir, () => {})
    assert.equal(targetDir, TARGET_DIR)
    assert.equal(readFileSync(join(targetDir, 'demo-skill', 'SKILL.md'), 'utf8'), '---\nname: demo-skill\n---\nV1')
    const ledger = readLedger()
    assert.equal(typeof ledger.deployed['demo-skill'], 'string')
    assert.match(ledger.deployed['demo-skill'], /^[0-9a-f]{64}$/)
    // 旧版行为（写 $DSH_HOME/profiles/<profile>/skills）必须已经停止。
    assert.equal(existsSync(join(home, 'profiles')), false)
  } finally {
    cleanup()
  }
})

test('resolveSkillsDir：包内容未变时不覆盖副本（用户本地改动保留）', () => {
  rmSync(TARGET_DIR, { recursive: true, force: true })
  const { sourceDir, cleanup } = makeSource()
  try {
    writeSkill(sourceDir, 'demo-skill', '---\nname: demo-skill\n---\nV1')
    const targetDir = resolveSkillsDir(sourceDir, () => {})
    writeFileSync(join(targetDir, 'demo-skill', 'SKILL.md'), '---\nname: demo-skill\n---\nLOCAL-EDIT', 'utf8')

    resolveSkillsDir(sourceDir, () => {})
    assert.equal(readFileSync(join(targetDir, 'demo-skill', 'SKILL.md'), 'utf8'), '---\nname: demo-skill\n---\nLOCAL-EDIT',
      '包内容未变：本地改动不得被冲掉')

    // 包内容变化 → 整体替换（升级），并更新账本。
    writeSkill(sourceDir, 'demo-skill', '---\nname: demo-skill\n---\nV2-LONGER')
    resolveSkillsDir(sourceDir, () => {})
    assert.equal(readFileSync(join(targetDir, 'demo-skill', 'SKILL.md'), 'utf8'), '---\nname: demo-skill\n---\nV2-LONGER')
  } finally {
    cleanup()
  }
})

test('resolveSkillsDir：升级保留停用态，用户自建技能目录不动', () => {
  rmSync(TARGET_DIR, { recursive: true, force: true })
  const { sourceDir, cleanup } = makeSource()
  try {
    writeSkill(sourceDir, 'demo-skill', '---\nname: demo-skill\n---\nV1')
    const targetDir = resolveSkillsDir(sourceDir, () => {})

    // 用户停用包内技能（磁盘事实）+ 用户自建技能
    renameSync(join(targetDir, 'demo-skill', 'SKILL.md'), join(targetDir, 'demo-skill', 'SKILL.md.disabled'))
    writeSkill(targetDir, 'user-custom', '---\nname: user-custom\n---\nKEEP')

    // 包内技能升级
    writeSkill(sourceDir, 'demo-skill', '---\nname: demo-skill\n---\nV2-LONGER')
    resolveSkillsDir(sourceDir, () => {})

    assert.equal(existsSync(join(targetDir, 'demo-skill', 'SKILL.md')), false, '升级不得把用户停用的技能悄悄打开')
    assert.equal(readFileSync(join(targetDir, 'demo-skill', 'SKILL.md.disabled'), 'utf8'), '---\nname: demo-skill\n---\nV2-LONGER')
    assert.equal(readFileSync(join(targetDir, 'user-custom', 'SKILL.md'), 'utf8'), '---\nname: user-custom\n---\nKEEP')
  } finally {
    cleanup()
  }
})
