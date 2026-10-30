/**
 * 技能文件的读取前校验：路径、文件名、祖先链、普通文件、可写位与 1 MiB 上限。
 * 真值源是 docs/skills-management.md 的写入边界与 shared/skills.ts 的常量。
 */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { readSkillMarker } = await import('../../src/host/skills-marker.ts')
const { MAX_SKILL_CONTENT_BYTES } = await import('../../src/shared/skills.ts')

const sandbox = mkdtempSync(join(tmpdir(), 'pt-skill-marker-'))
after(() => { rmSync(sandbox, { recursive: true, force: true }) })

let counter = 0
function marker(text, name = 'SKILL.md') {
  counter += 1
  const dir = join(sandbox, `skill-${counter}`)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, name)
  writeFileSync(file, text, 'utf8')
  return file
}

const valid = '---\nname: demo\ndescription: Demo\n---\nBody\n'

test('读取返回原文、解析结果与权限位', () => {
  const file = marker(valid)
  const read = readSkillMarker(file)
  assert.equal(read.raw, valid)
  assert.equal(read.parse.ok, true)
  assert.equal(typeof read.mode, 'number')
})

test('拒绝非绝对路径与非法文件名', () => {
  assert.throws(() => readSkillMarker('SKILL.md'), /绝对路径/u)
  assert.throws(() => readSkillMarker(join(sandbox, 'notes.txt')), /SKILL\.md/u)
})

test('拒绝目录等非普通文件', () => {
  const dir = join(sandbox, 'as-dir')
  mkdirSync(join(dir, 'SKILL.md'), { recursive: true })
  assert.throws(() => readSkillMarker(join(dir, 'SKILL.md')), /普通文件/u)
})

test('非法 frontmatter 以解析结果返回，不在这里抛', () => {
  const read = readSkillMarker(marker('没有 frontmatter'))
  assert.equal(read.parse.ok, false)
  assert.match(read.parse.issue, /frontmatter/u)
})

test('拒绝超过 1 MiB 的文件', () => {
  const file = marker('x'.repeat(MAX_SKILL_CONTENT_BYTES + 1))
  assert.throws(() => readSkillMarker(file), /不能超过 1 MiB/u)
})

test('writable 时拒绝只读位；只读仍可读', () => {
  const file = marker(valid)
  chmodSync(file, 0o444)
  assert.throws(() => readSkillMarker(file, { writable: true }), /只读/u)
  assert.equal(readSkillMarker(file).raw, valid)
})
