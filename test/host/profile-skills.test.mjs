import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 安装副本目标固定在 DSH_HOME 技能根（官方 user-dsh 来源）：隔离 DSH_HOME 后加载。
const home = mkdtempSync(join(tmpdir(), `prompt-tool-skills-home-${process.pid}-`))
process.env.DSH_HOME = home
const { resolveSkillsDir } = await import('../../lib/index.mjs')

const TARGET_DIR = join(home, 'skills')
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

function writeManifest(dir, version, skills) {
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ version, skills }), 'utf8')
}

test('resolveSkillsDir：按 manifest 初次复制技能到 $DSH_HOME/skills 并写入隐藏版本文件', () => {
  rmSync(TARGET_DIR, { recursive: true, force: true })
  const { sourceDir, cleanup } = makeSource()
  try {
    writeSkill(sourceDir, 'demo-skill', '---\nname: demo-skill\n---\nV1')
    writeManifest(sourceDir, 1, { 'demo-skill': 1 })

    const targetDir = resolveSkillsDir(sourceDir, () => {})
    assert.equal(targetDir, TARGET_DIR)
    assert.equal(readFileSync(join(targetDir, 'demo-skill', 'SKILL.md'), 'utf8'), '---\nname: demo-skill\n---\nV1')
    assert.ok(existsSync(join(targetDir, '.prompt-tool-manifest.json')))
    // 旧版行为（写 $DSH_HOME/profiles/<profile>/skills）必须已经停止。
    assert.equal(existsSync(join(home, 'profiles')), false)
  } finally {
    cleanup()
  }
})

test('resolveSkillsDir：版本升级时覆盖包内技能，保留用户自定义技能', () => {
  rmSync(TARGET_DIR, { recursive: true, force: true })
  const { sourceDir, cleanup } = makeSource()
  try {
    writeSkill(sourceDir, 'demo-skill', '---\nname: demo-skill\n---\nV1')
    writeManifest(sourceDir, 1, { 'demo-skill': 1 })
    const targetDir = resolveSkillsDir(sourceDir, () => {})

    // 用户自定义技能
    writeSkill(targetDir, 'user-custom', '---\nname: user-custom\n---\nKEEP')

    // 包内技能升级
    writeSkill(sourceDir, 'demo-skill', '---\nname: demo-skill\n---\nV2-LONGER')
    writeManifest(sourceDir, 2, { 'demo-skill': 2 })

    resolveSkillsDir(sourceDir, () => {})
    assert.equal(readFileSync(join(targetDir, 'demo-skill', 'SKILL.md'), 'utf8'), '---\nname: demo-skill\n---\nV2-LONGER')
    assert.equal(readFileSync(join(targetDir, 'user-custom', 'SKILL.md'), 'utf8'), '---\nname: user-custom\n---\nKEEP')
  } finally {
    cleanup()
  }
})
