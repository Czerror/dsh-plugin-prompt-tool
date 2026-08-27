import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeGitBashWorkdir, bashCandidates } from '../../engine/custom-bash.mjs'

test('custom-bash：normalizeGitBashWorkdir 转换 Git Bash 盘符路径（win32）', () => {
  assert.equal(normalizeGitBashWorkdir('/e/foo/bar', 'win32'), 'E:\\foo\\bar')
  assert.equal(normalizeGitBashWorkdir('/c', 'win32'), 'C:\\')
  assert.equal(normalizeGitBashWorkdir('C:\\foo', 'win32'), 'C:\\foo')
  assert.equal(normalizeGitBashWorkdir('/usr/bin', 'win32'), '/usr/bin')
  assert.equal(normalizeGitBashWorkdir('/e/foo', 'linux'), '/e/foo')
  assert.equal(normalizeGitBashWorkdir('', 'win32'), '')
})

test('custom-bash：bashCandidates 从 git 安装根派生候选并去重', () => {
  const c = bashCandidates({ ProgramFiles: 'C:\\Program Files' }, 'C:\\Program Files\\Git\\cmd\\git.exe')
  assert.ok(c.includes('C:\\Program Files\\Git\\bin\\bash.exe'))
  assert.ok(c.includes('C:\\Program Files\\Git\\cmd\\bash.exe'))
  assert.ok(c.includes('C:\\Program Files\\Git\\bin\\bash.exe'))
  assert.equal(new Set(c).size, c.length, '候选去重')
})
