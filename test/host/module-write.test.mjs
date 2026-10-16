import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { revisionOf } from '../../src/host/module-write.ts'

// 真值源是 Node 自己的 sha256 与「读到的字节」，不是从 module-write.ts 抄常量：
// 这条摘要同时给字符串与字节两路输入，一次改动（换算法、换编码、少一次 update）必须立刻红。
test('revisionOf：同一读法同一摘要，逐字节等于 Node 的 sha256 十六进制', () => {
  const text = 'rules:\n  - id: first\n'
  const bytes = new TextEncoder().encode(text)
  assert.equal(revisionOf(text), revisionOf(text), '同一输入两次调用结果相同')
  assert.match(revisionOf(text), /^[0-9a-f]{64}$/, '摘要是 64 位小写十六进制')
  assert.notEqual(revisionOf(text), revisionOf(text + '  - id: second\n'), '不同输入摘要不同')
  assert.equal(revisionOf(bytes), revisionOf(text), 'Uint8Array 与等价 UTF-8 字符串同摘要——CAS 两侧读法必须一致')
  assert.equal(revisionOf(text), createHash('sha256').update(text).digest('hex'))
  assert.equal(revisionOf(bytes), createHash('sha256').update(bytes).digest('hex'))
})
