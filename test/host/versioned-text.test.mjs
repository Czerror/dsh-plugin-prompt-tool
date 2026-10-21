import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { replaceVersionedText } from '../../src/host/versioned-text.ts'

const fixture = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pt-versioned-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'target.txt')
  writeFileSync(file, 'old')
  return { dir, file }
}

test('versioned text：正常替换读两次、替换一次，prepare 收到初始快照', (t) => {
  const { dir, file } = fixture(t)
  let reads = 0
  let prepared
  const result = replaceVersionedText({
    file,
    expectedRevision: 'r1',
    read: () => {
      reads += 1
      return { revision: 'r1', value: 'old', text: 'old' }
    },
    prepare: value => { prepared = value; return 'new' },
    conflict: () => new Error('conflict'),
  })
  assert.deepEqual(result, { changed: true, text: 'new' })
  assert.equal(reads, 2, '初始 + beforeReplace 各读一次')
  assert.equal(prepared, 'old')
  assert.equal(readFileSync(file, 'utf8'), 'new')
  assert.deepEqual(readdirSync(dir).filter(name => name.startsWith('.')), [], '临时文件已清理')
})

test('versioned text：expectedRevision 不匹配零写入，prepare 不调用', (t) => {
  const { file } = fixture(t)
  let prepareCalls = 0
  const conflict = Object.assign(new Error('stale'), { code: 'test-conflict' })
  assert.throws(() => replaceVersionedText({
    file,
    expectedRevision: 'r2',
    read: () => ({ revision: 'r1', value: 'old', text: 'old' }),
    prepare: () => { prepareCalls += 1; return 'new' },
    conflict: () => conflict,
  }), error => error === conflict)
  assert.equal(prepareCalls, 0)
  assert.equal(readFileSync(file, 'utf8'), 'old')
})

test('versioned text：read 与 replace 之间版本变化，替换前再核拒绝', (t) => {
  const { dir, file } = fixture(t)
  let reads = 0
  const conflict = new Error('changed-between')
  assert.throws(() => replaceVersionedText({
    file,
    expectedRevision: 'r1',
    read: () => {
      reads += 1
      return { revision: reads === 1 ? 'r1' : 'r2', value: 'old', text: 'old' }
    },
    prepare: () => 'new',
    conflict: () => conflict,
  }), error => error === conflict)
  assert.equal(reads, 2)
  assert.equal(readFileSync(file, 'utf8'), 'old', '原文件不被覆盖')
  assert.deepEqual(readdirSync(dir).filter(name => name.startsWith('.')), [], '临时文件已清理')
})

test('versioned text：prepare 返回 undefined 或原文相同都不写盘', (t) => {
  const { file } = fixture(t)
  let reads = 0
  const unchanged = replaceVersionedText({
    file,
    expectedRevision: 'r1',
    read: () => { reads += 1; return { revision: 'r1', value: 'old', text: 'old' } },
    prepare: () => undefined,
    conflict: () => new Error('conflict'),
  })
  assert.deepEqual(unchanged, { changed: false })
  assert.equal(reads, 1)
  const same = replaceVersionedText({
    file,
    expectedRevision: 'r1',
    read: () => ({ revision: 'r1', value: 'old', text: 'old' }),
    prepare: () => 'old',
    conflict: () => new Error('conflict'),
  })
  assert.deepEqual(same, { changed: false })
})

test('versioned text：recheck 收到第二次读取的快照', (t) => {
  const { file } = fixture(t)
  let reads = 0
  let rechecked
  const result = replaceVersionedText({
    file,
    expectedRevision: 'r1',
    read: () => {
      reads += 1
      return { revision: 'r1', value: reads === 1 ? 'old' : 'old-after', text: 'old' }
    },
    prepare: () => 'new',
    recheck: value => { rechecked = value },
    conflict: () => new Error('conflict'),
  })
  assert.equal(result.changed, true)
  assert.equal(rechecked, 'old-after')
  assert.equal(readFileSync(file, 'utf8'), 'new')
})
test('versioned text：read 回传的 mode 透传给原子替换', (t) => {
  const { file } = fixture(t)
  if (process.platform !== 'win32') chmodSync(file, 0o640)
  const mode = statSync(file).mode
  const result = replaceVersionedText({
    file,
    expectedRevision: 'r1',
    read: () => ({ revision: 'r1', value: 'old', text: 'old', mode }),
    prepare: () => 'new',
    conflict: () => new Error('conflict'),
  })
  assert.equal(result.changed, true)
  assert.equal(readFileSync(file, 'utf8'), 'new')
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o640)
  else assert.ok((statSync(file).mode & 0o200) !== 0, '替换后仍可写')
})

test('versioned text：prepare/recheck 的域错误原样传播，原文件不变', (t) => {
  const { file } = fixture(t)
  const prepareError = new Error('invalid-prepare')
  assert.throws(() => replaceVersionedText({
    file,
    expectedRevision: 'r1',
    read: () => ({ revision: 'r1', value: 'old', text: 'old' }),
    prepare: () => { throw prepareError },
    conflict: () => new Error('conflict'),
  }), error => error === prepareError)
  assert.equal(readFileSync(file, 'utf8'), 'old')

  const recheckError = new Error('invalid-recheck')
  assert.throws(() => replaceVersionedText({
    file,
    expectedRevision: 'r1',
    read: () => ({ revision: 'r1', value: 'old', text: 'old' }),
    prepare: () => 'new',
    recheck: () => { throw recheckError },
    conflict: () => new Error('conflict'),
  }), error => error === recheckError)
  assert.equal(readFileSync(file, 'utf8'), 'old')
})
