import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs, { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { atomicWriteTextFile } from '../../src/host/text-file.ts'

test('原子文本替换保留正文；替换前失败保留原件并清理暂存', (t) => {
  const directory = mkdtempSync(join(process.cwd(), 'pt-text-file-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const file = join(directory, 'preset.yml')
  writeFileSync(file, '# 原始注释\nname: original\n')
  atomicWriteTextFile(file, '# 原始注释\nname: updated\n', { mode: 0o600 })
  assert.equal(readFileSync(file, 'utf8'), '# 原始注释\nname: updated\n')
  assert.throws(() => atomicWriteTextFile(file, 'invalid', { beforeReplace() { throw new Error('版本冲突') } }), /版本冲突/)
  assert.equal(readFileSync(file, 'utf8'), '# 原始注释\nname: updated\n')
  assert.deepEqual(readdirSync(directory), ['preset.yml'])
  t.mock.method(fs, 'renameSync', () => { throw new Error('替换失败') })
  syncBuiltinESMExports()
  try {
    assert.throws(() => atomicWriteTextFile(file, 'invalid'), /替换失败/)
    assert.equal(readFileSync(file, 'utf8'), '# 原始注释\nname: updated\n')
    assert.deepEqual(readdirSync(directory), ['preset.yml'])
  } finally { t.mock.restoreAll(); syncBuiltinESMExports() }
})

test('权限位：省略 mode 精确保留目标权限，显式 mode 不受 umask 收窄；mkdir 按需建目录', (t) => {
  const directory = mkdtempSync(join(process.cwd(), 'pt-text-file-mode-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const file = join(directory, 'preset.yml')
  writeFileSync(file, 'old\n')
  // 真值源是 statSync 读回的权限位；Windows 下它是 libuv 合成值，只有只读位可观测（另见 rename 覆盖只读文件会失败）。
  if (process.platform === 'win32') {
    atomicWriteTextFile(file, 'new\n')
    assert.ok((statSync(file).mode & 0o200) !== 0, '替换后目标仍应可写')
    assert.equal(readFileSync(file, 'utf8'), 'new\n')
  } else {
    chmodSync(file, 0o640)
    atomicWriteTextFile(file, 'new\n')
    assert.equal(statSync(file).mode & 0o777, 0o640, '省略 mode 时必须精确保留目标权限位')
    // 0o664 在任何非零 umask 下都会被 writeFileSync 的 mode 收窄，只有 chmod 能给出精确值。
    atomicWriteTextFile(file, 'explicit\n', { mode: 0o664 })
    assert.equal(statSync(file).mode & 0o777, 0o664, '显式 mode 不受 umask 收窄')
    assert.equal(readFileSync(file, 'utf8'), 'explicit\n')
  }
  const nested = join(directory, 'nested', 'deep.yml')
  atomicWriteTextFile(nested, 'created\n', { mkdir: true })
  assert.equal(readFileSync(nested, 'utf8'), 'created\n')
})
