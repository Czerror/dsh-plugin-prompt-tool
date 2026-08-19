import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixSkillEntry } from '../../lib/index.mjs'
import { parseFrontmatter } from '../../lib/preset-core.mjs'

const makeRoot = () => {
  const dir = mkdtempSync(join(tmpdir(), 'prompt-tool-skill-fix-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const writeSkill = (root, folder, content) => {
  const dir = join(root, folder)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'SKILL.md')
  writeFileSync(file, content, 'utf8')
  return file
}

test('fixSkillEntry：BOM + 非法 frontmatter name + 非法目录名 → 全部修复', () => {
  const { dir, cleanup } = makeRoot()
  try {
    writeSkill(dir, 'Premium Web', '\uFEFF---\nname: 高级开发工程师\ndescription: Demo\n---\nBODY')
    const result = fixSkillEntry(dir, 'Premium Web')
    assert.equal(result.fixed, true)
    assert.equal(result.fixedFolder, 'premium-web')
    assert.equal(result.name, 'premium-web')
    assert.equal(existsSync(join(dir, 'Premium Web')), false)
    const raw = readFileSync(join(dir, 'premium-web', 'SKILL.md'), 'utf8')
    assert.equal(raw.charCodeAt(0) === 0xfeff, false)
    const { data, body } = parseFrontmatter(raw)
    assert.equal(data.name, 'premium-web')
    assert.equal(data.description, 'Demo')
    assert.equal(body, 'BODY')
  } finally {
    cleanup()
  }
})

test('fixSkillEntry：目录合法时只改写 name 并剥 BOM，不重命名', () => {
  const { dir, cleanup } = makeRoot()
  try {
    writeSkill(dir, 'good-folder', '\uFEFF---\nname: 中文名\ndescription: Demo\n---\nBODY')
    const result = fixSkillEntry(dir, 'good-folder')
    assert.equal(result.fixed, true)
    assert.equal(result.fixedFolder, 'good-folder')
    const { data } = parseFrontmatter(readFileSync(join(dir, 'good-folder', 'SKILL.md'), 'utf8'))
    assert.equal(data.name, 'good-folder')
  } finally {
    cleanup()
  }
})

test('fixSkillEntry：目标目录已存在时追加数字后缀', () => {
  const { dir, cleanup } = makeRoot()
  try {
    writeSkill(dir, 'premium-web', '---\nname: premium-web\ndescription: Existing\n---\nOLD')
    writeSkill(dir, 'Premium Web', '---\nname: 高级开发工程师\n---\nNEW')
    const result = fixSkillEntry(dir, 'Premium Web')
    assert.equal(result.fixed, true)
    assert.equal(result.fixedFolder, 'premium-web-2')
    assert.equal(existsSync(join(dir, 'premium-web-2', 'SKILL.md')), true)
  } finally {
    cleanup()
  }
})

test('fixSkillEntry：拒绝路径穿越与不存在目录', () => {
  const { dir, cleanup } = makeRoot()
  try {
    const traversal = fixSkillEntry(dir, '../evil')
    assert.equal(traversal.fixed, false)
    assert.match(traversal.error, /非法目录名/)
    const missing = fixSkillEntry(dir, 'nope')
    assert.equal(missing.fixed, false)
    assert.match(missing.error, /目录不存在/)
  } finally {
    cleanup()
  }
})
