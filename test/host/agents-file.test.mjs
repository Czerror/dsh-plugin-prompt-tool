import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 常驻 AGENTS.md 受管块契约：只认文件头部、整行精确相等的成对标记；
// 正文（含缩进同形行）与 BOM 必须原样保留，写盘失败不破坏旧文件。
const home = mkdtempSync(join(tmpdir(), 'pt-agents-'))
process.env.DSH_HOME = home
const { writeAgents, removeResidentAgentsBlock } = await import('../../lib/index.mjs')

const BEGIN = '# === prompt-tool managed block begin ==='
const END = '# === prompt-tool managed block end ==='
const file = (name) => join(home, name)
const read = (name) => readFileSync(file(name), 'utf8')

test.after(() => rmSync(home, { recursive: true, force: true }))

test('writeAgents 写头部受管块、保留用户正文且同内容不重写', () => {
  writeFileSync(file('a.md'), 'USER LINE\n', 'utf8')
  assert.equal(writeAgents('RULES', file('a.md')), true)
  assert.equal(read('a.md'), `${BEGIN}\nRULES\n${END}\nUSER LINE\n`)
  const before = read('a.md')
  assert.equal(writeAgents('RULES', file('a.md')), true)
  assert.equal(read('a.md'), before, '内容一致时不得重写')
  assert.equal(writeAgents('RULES2', file('a.md')), true)
  assert.equal(read('a.md'), `${BEGIN}\nRULES2\n${END}\nUSER LINE\n`, '更新只替换受管块')
})

test('正文含缩进同形结束标记时不被当作块边界（回归：静默删除正文）', () => {
  const body = `text\n  ${END}\nmore\n`
  writeFileSync(file('b.md'), body, 'utf8')
  assert.equal(writeAgents('RULES', file('b.md')), true)
  assert.ok(read('b.md').includes(body), read('b.md'))
  assert.equal(writeAgents('RULES2', file('b.md')), true)
  assert.ok(read('b.md').includes(body), '二次写入后正文仍完整')
  assert.equal(read('b.md').match(new RegExp(END, 'g')).length, 2, '只有一个受管块标记 + 正文里一行')
})

test('标记不成对（半块）时不动用户文件', () => {
  const half = `${BEGIN}\nOLD\nUSER TAIL\n`
  writeFileSync(file('c.md'), half, 'utf8')
  assert.equal(removeResidentAgentsBlock(file('c.md')), true)
  assert.equal(read('c.md'), half)
  assert.equal(writeAgents('RULES', file('c.md')), true)
  assert.ok(read('c.md').includes('OLD\nUSER TAIL\n'), read('c.md'))
})

test('空文本只删受管块；无块或文件缺失时为空操作', () => {
  writeFileSync(file('d.md'), `${BEGIN}\nRULES\n${END}\nKEEP\n`, 'utf8')
  assert.equal(writeAgents('', file('d.md')), true)
  assert.equal(read('d.md'), 'KEEP\n')
  assert.equal(removeResidentAgentsBlock(file('d.md')), true)
  assert.equal(read('d.md'), 'KEEP\n', '无块文件不得被改写')
  assert.equal(writeAgents('', file('missing.md')), true)
  assert.equal(existsSync(file('missing.md')), false, '空文本不得创建文件')
})

test('BOM 保持在文件头，不落进正文中间', () => {
  writeFileSync(file('e.md'), '\uFEFFUSER\n', 'utf8')
  assert.equal(writeAgents('RULES', file('e.md')), true)
  const after = read('e.md')
  assert.equal(after.charCodeAt(0), 0xfeff)
  assert.equal(after.indexOf('\uFEFF'), 0)
  assert.equal(after, `\uFEFF${BEGIN}\nRULES\n${END}\nUSER\n`)
  assert.equal(writeAgents('RULES', file('e.md')), true)
  assert.equal(read('e.md'), after, '带 BOM 文件重复写入保持幂等')
})

test('CRLF 文件保持 CRLF 写入', () => {
  writeFileSync(file('f.md'), 'user\r\n', 'utf8')
  assert.equal(writeAgents('RULES', file('f.md')), true)
  assert.equal(read('f.md'), `${BEGIN}\r\nRULES\r\n${END}\r\nuser\r\n`)
})
