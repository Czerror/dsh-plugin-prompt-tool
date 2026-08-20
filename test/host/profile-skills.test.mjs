import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolveProfileSkillsDir } from '../../lib/index.mjs'

function makeRoot() {
  const root = join(tmpdir(), `prompt-tool-skills-sync-${process.pid}-${Date.now()}`)
  const profileDir = join(root, 'prompt-tool')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'prompt-tool' }), 'utf8')
  const sourceDir = join(root, 'src-skills')
  mkdirSync(sourceDir, { recursive: true })
  const ctx = { baseUrl: pathToFileURL(profileDir + '/').href }
  return { root, profileDir, sourceDir, ctx, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

function writeSkill(root, folder, content) {
  const dir = join(root, folder)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), content, 'utf8')
}

test('resolveProfileSkillsDir：按 manifest 初次复制技能并写入隐藏版本文件', () => {
  const { profileDir, sourceDir, ctx, cleanup } = makeRoot()
  try {
    writeSkill(sourceDir, 'demo-skill', '---\nname: demo-skill\n---\nV1')
    writeFileSync(join(sourceDir, 'manifest.json'), JSON.stringify({ version: 1, skills: { 'demo-skill': 1 } }), 'utf8')

    const targetDir = resolveProfileSkillsDir(ctx, sourceDir, () => {})
    assert.equal(targetDir, join(profileDir, 'skills'))
    assert.equal(readFileSync(join(targetDir, 'demo-skill', 'SKILL.md'), 'utf8'), '---\nname: demo-skill\n---\nV1')
    assert.ok(existsSync(join(targetDir, '.prompt-tool-manifest.json')))
  } finally {
    cleanup()
  }
})

test('resolveProfileSkillsDir：版本升级时覆盖包内技能，保留用户自定义技能', () => {
  const { sourceDir, ctx, cleanup } = makeRoot()
  try {
    writeSkill(sourceDir, 'demo-skill', '---\nname: demo-skill\n---\nV1')
    writeFileSync(join(sourceDir, 'manifest.json'), JSON.stringify({ version: 1, skills: { 'demo-skill': 1 } }), 'utf8')
    const targetDir = resolveProfileSkillsDir(ctx, sourceDir, () => {})

    // 用户自定义技能
    writeSkill(targetDir, 'user-custom', '---\nname: user-custom\n---\nKEEP')

    // 包内技能升级
    writeSkill(sourceDir, 'demo-skill', '---\nname: demo-skill\n---\nV2-LONGER')
    writeFileSync(join(sourceDir, 'manifest.json'), JSON.stringify({ version: 2, skills: { 'demo-skill': 2 } }), 'utf8')

    resolveProfileSkillsDir(ctx, sourceDir, () => {})
    assert.equal(readFileSync(join(targetDir, 'demo-skill', 'SKILL.md'), 'utf8'), '---\nname: demo-skill\n---\nV2-LONGER')
    assert.equal(readFileSync(join(targetDir, 'user-custom', 'SKILL.md'), 'utf8'), '---\nname: user-custom\n---\nKEEP')
  } finally {
    cleanup()
  }
})

test('resolveProfileSkillsDir：迁移清理误复制的项目根结构，保留用户自定义技能', () => {
  const { sourceDir, ctx, cleanup } = makeRoot()
  try {
    writeSkill(sourceDir, 'demo-skill', '---\nname: demo-skill\n---\nV1')
    writeFileSync(join(sourceDir, 'manifest.json'), JSON.stringify({ version: 1, skills: { 'demo-skill': 1 } }), 'utf8')
    const targetDir = resolveProfileSkillsDir(ctx, sourceDir, () => {})

    // 历史误复制的项目根结构：无 SKILL.md 的顶层目录应被清理。
    mkdirSync(join(targetDir, '.agents', 'skills'), { recursive: true })
    mkdirSync(join(targetDir, '.github'), { recursive: true })
    mkdirSync(join(targetDir, 'docs'), { recursive: true })
    writeFileSync(join(targetDir, 'docs', 'guide.md'), 'x', 'utf8')
    // 用户自定义技能（含 SKILL.md）：保留。
    writeSkill(targetDir, 'user-custom', '---\nname: user-custom\n---\nKEEP')

    resolveProfileSkillsDir(ctx, sourceDir, () => {})
    assert.equal(existsSync(join(targetDir, '.agents')), false)
    assert.equal(existsSync(join(targetDir, '.github')), false)
    assert.equal(existsSync(join(targetDir, 'docs')), false)
    assert.equal(existsSync(join(targetDir, 'user-custom', 'SKILL.md')), true)
    assert.equal(existsSync(join(targetDir, 'demo-skill', 'SKILL.md')), true)
  } finally {
    cleanup()
  }
})
