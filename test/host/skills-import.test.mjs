/**
 * 技能上传入口对共享路径原语的接线：管理目录与 DEL 控制字符在写盘前拒绝。
 */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { importSkillsPackage } = await import('../../src/host/skills-import.ts')

const root = mkdtempSync(join(tmpdir(), 'pt-skills-import-'))
after(() => rmSync(root, { recursive: true, force: true }))

const encode = (text) => Buffer.from(text, 'utf8').toString('base64')
const marker = encode('---\nname: demo\n---\nbody\n')

test('技能上传：管理目录按共享路径规则拒绝', () => {
  const result = importSkillsPackage(root, [{ path: '.system/SKILL.md', content: marker }])
  assert.equal(result.ok, false)
  assert.match(result.message, /非法资源路径/u)
})

test('技能上传：DEL 控制字符按共享路径规则拒绝', () => {
  const path = 'a' + String.fromCharCode(0x7f) + '/SKILL.md'
  const result = importSkillsPackage(root, [{ path, content: marker }])
  assert.equal(result.ok, false)
  assert.match(result.message, /非法资源路径/u)
})
