import { test } from 'node:test'
import assert from 'node:assert/strict'

import { assertSafeRelativePath } from '../../src/shared/asset-path.ts'

const control = (code) => 'a' + String.fromCharCode(code) + 'b'

test('合法相对路径原样返回', () => {
  for (const path of ['a.txt', 'dir/a.md', 'a/b/c.png', '中文/说明.md', 'a b/c.d']) {
    assert.equal(assertSafeRelativePath(path), path)
  }
})

test('拒绝空、超长、反斜杠与开头斜杠', () => {
  assert.throws(() => assertSafeRelativePath(''), /非法资源路径/u)
  assert.throws(() => assertSafeRelativePath('a'.repeat(1025)), /非法资源路径/u)
  assert.throws(() => assertSafeRelativePath('a\\b'), /非法资源路径/u)
  assert.throws(() => assertSafeRelativePath('/a'), /非法资源路径/u)
})

test('拒绝控制字符（含 DEL）与 Windows 保留字符', () => {
  assert.throws(() => assertSafeRelativePath(control(0)), /非法资源路径/u)
  assert.throws(() => assertSafeRelativePath(control(0x7f)), /非法资源路径/u)
  for (const path of ['a<b', 'a>b', 'a:b', 'a"b', 'a|b', 'a?b', 'a*b']) {
    assert.throws(() => assertSafeRelativePath(path), /非法资源路径/u)
  }
})

test('拒绝空段、上跳、段尾空格/点与 DOS 保留名', () => {
  for (const path of ['a//b', 'a/./b', 'a/../b', 'a /b', 'a./b', 'a/b/', 'con', 'com1.txt', 'com0', 'lpt0', 'a/com9']) {
    assert.throws(() => assertSafeRelativePath(path), /非法资源路径/u)
  }
})

test('reservedRoots 只拒绝声明的首段', () => {
  assert.throws(() => assertSafeRelativePath('.system/a', { reservedRoots: ['.system'] }), /非法资源路径/u)
  assert.equal(assertSafeRelativePath('.system/a'), '.system/a')
  assert.throws(() => assertSafeRelativePath('.skills-migration/a', { reservedRoots: ['.skills-migration'] }), /非法资源路径/u)
  assert.equal(assertSafeRelativePath('.skills-migration/a', { reservedRoots: ['.system'] }), '.skills-migration/a')
})

test('maxLength 参数生效', () => {
  const long = 'a/'.repeat(1024) + 'a' // 2049
  assert.equal(long.length, 2049)
  assert.throws(() => assertSafeRelativePath(long), /非法资源路径/u)
  assert.equal(assertSafeRelativePath(long, { maxLength: 2049 }), long)
})
