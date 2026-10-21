import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import fs, { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readSkillContent, writeSkillContent } from '../../src/host/skills-content.ts'
import { setSkillInvocation } from '../../src/host/skills-policy.ts'
import { writeSkillsState } from '../../src/host/skills-config.ts'

const fresh = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pt-skills-cas-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const skill = (text = 'body') => `---\nname: demo\ndescription: old\n---\n\n${text}\n`

/** 在指定文件的第 at 次 readFileSync 前写入外部内容，再返回该内容。 */
const externalChange = (path, changed, at = 3) => {
  const original = fs.readFileSync.bind(fs)
  let reads = 0
  let mutated = false
  mock.method(fs, 'readFileSync', (target, ...args) => {
    if (target === path) {
      reads += 1
      if (reads === at) {
        mutated = true
        writeFileSync(path, changed)
        return Buffer.from(changed)
      }
    }
    return original(target, ...args)
  })
  syncBuiltinESMExports()
  return {
    restore: () => { mock.restoreAll(); syncBuiltinESMExports() },
    mutated: () => mutated,
  }
}

test('技能正文 CAS：成功替换后，替换前外部改写保留原文件与冲突消息', (t) => {
  const dir = fresh(t)
  const path = join(dir, 'SKILL.md')
  writeFileSync(path, skill())
  const catalog = () => [{ name: 'demo', path, valid: true, canEdit: true }]
  const read = readSkillContent(catalog, 'demo', path)
  assert.equal(read.ok, true)
  const written = writeSkillContent(catalog, 'demo', path, 'new body', 'new description', read.revision)
  assert.equal(written.ok, true)
  const changed = skill('external body')
  const hook = externalChange(path, changed)
  try {
    const result = writeSkillContent(catalog, 'demo', path, 'lost body', 'lost description', written.revision)
    assert.equal(result.ok, false)
    assert.match(result.message, /技能内容版本冲突/)
  } finally { hook.restore() }
  assert.equal(hook.mutated(), true)
  assert.equal(readFileSync(path, 'utf8'), changed)
})

test('技能调用策略 CAS：外部改写后保留冲突消息与原文件', (t) => {
  const dir = fresh(t)
  const path = join(dir, 'SKILL.md')
  writeFileSync(path, skill())
  assert.equal(setSkillInvocation(path, 'model').ok, true)
  const changed = readFileSync(path, 'utf8') + '# external\n'
  const hook = externalChange(path, changed)
  try {
    const result = setSkillInvocation(path, 'user')
    assert.equal(result.ok, false)
    assert.match(result.message, /技能内容版本冲突/)
  } finally { hook.restore() }
  assert.equal(hook.mutated(), true)
  assert.equal(readFileSync(path, 'utf8'), changed)
})

test('技能状态 CAS：外部改写后保留冲突消息与原文件', (t) => {
  const dir = fresh(t)
  const path = join(dir, 'skills.yml')
  const first = writeSkillsState({ folders: [dir] }, path)
  assert.equal(first.ok, true)
  const changed = readFileSync(path, 'utf8') + '# external\n'
  const hook = externalChange(path, changed)
  try {
    const result = writeSkillsState({ folders: [join(dir, 'other')] }, path)
    assert.equal(result.ok, false)
    assert.match(result.message, /技能状态内容版本冲突/)
  } finally { hook.restore() }
  assert.equal(hook.mutated(), true)
  assert.equal(readFileSync(path, 'utf8'), changed)
})
