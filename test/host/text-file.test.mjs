import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs, { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { atomicWriteTextFile } from '../../src/host/text-file.ts'
import { atomicWriteTextFile as manifestWrite } from '../../src/host/manifest.ts'

test('预设旧接口与技能共享原子文本替换；替换前失败保留原件并清理暂存', (t) => {
  const directory = mkdtempSync(join(process.cwd(), 'pt-text-file-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const file = join(directory, 'preset.yml')
  writeFileSync(file, '# 原始注释\nname: original\n')
  assert.equal(manifestWrite, atomicWriteTextFile)
  let checks = 0
  atomicWriteTextFile(file, '# 原始注释\nname: updated\n', { mode: 0o600, beforeReplace() {
    checks++
    assert.equal(readFileSync(file, 'utf8'), '# 原始注释\nname: original\n')
    assert.equal(readdirSync(directory).length, 2, '先暂存完整内容再做最终复核')
  } })
  assert.equal(checks, 1)
  assert.equal(readFileSync(file, 'utf8'), '# 原始注释\nname: updated\n')
  assert.throws(() => atomicWriteTextFile(file, 'invalid', { beforeReplace() { throw new Error('版本冲突') } }), /版本冲突/)
  assert.equal(readFileSync(file, 'utf8'), '# 原始注释\nname: updated\n')
  assert.deepEqual(readdirSync(directory), ['preset.yml'])
  t.mock.method(fs, 'renameSync', () => { throw new Error('替换失败') })
  syncBuiltinESMExports()
  try {
    assert.throws(() => manifestWrite(file, 'invalid'), /替换失败/)
    assert.equal(readFileSync(file, 'utf8'), '# 原始注释\nname: updated\n')
    assert.deepEqual(readdirSync(directory), ['preset.yml'])
  } finally { t.mock.restoreAll(); syncBuiltinESMExports() }
})
