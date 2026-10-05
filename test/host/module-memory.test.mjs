import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { registerWorldBookTools } from '../../src/runtime/world-book-tools.ts'

function fixture(t) {
  const root = mkdtempSync(join(process.cwd(), 'pt-module-memory-'))
  const moduleRoot = join(root, 'modules')
  const dir = join(moduleRoot, 'alice')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'module.yml'), 'id: alice\nname: Alice\nmodules: []\nrules: []\n')
  const tools = new Map()
  let rebuilds = 0
  const dispose = registerWorldBookTools({
    inject: (_deps, callback) => ({ dispose: callback({ tools: { register: tool => {
      tools.set(tool.name, tool)
      return () => tools.delete(tool.name)
    } } }) }),
  }, { target: () => ({ root: moduleRoot, dir, id: 'alice' }), rebuild: async () => { rebuilds += 1 } })
  t.after(() => { dispose(); assert.equal(tools.size, 0); rmSync(root, { recursive: true, force: true }) })
  return { root, dir, tools, rebuilds: () => rebuilds }
}

test('世界书工具按需读取模块记忆，note 同址保存且不生成自动记忆规则', async t => {
  const f = fixture(t)
  const read = f.tools.get('world_book_read_memory')
  assert.ok(read, '必须注册显式记忆读取工具')
  assert.deepEqual(await read.execute({}, {}), { memory: '' })
  await f.tools.get('world_book_upsert').execute({ id: 'module-old-lore', name: 'Lore', content: 'PUBLIC', note: 'PRIVATE NOTE' }, {})
  assert.match(readFileSync(join(f.dir, 'memory.md'), 'utf8'), /PRIVATE NOTE/)
  const memory = (await read.execute({}, {})).memory
  assert.match(memory, /PRIVATE NOTE/)
  writeFileSync(join(f.dir, 'memory.md'), 'UPDATED MEMORY')
  assert.deepEqual(await read.execute({}, {}), { memory: 'UPDATED MEMORY' })
  const spec = parse(readFileSync(join(f.dir, 'module.yml'), 'utf8'))
  assert.deepEqual(spec.rules.map(rule => rule.id), ['module-old-lore'])
  assert.equal(f.rebuilds(), 1, '显式读取不触发重新装配')
})

test('模块记忆读取失败显式拒绝，链接目标不能读写', async t => {
  const f = fixture(t)
  const read = f.tools.get('world_book_read_memory')
  assert.ok(read)
  mkdirSync(join(f.dir, 'memory.md'))
  await assert.rejects(read.execute({}, {}), /memory|directory|EISDIR|EPERM/i)
  rmSync(join(f.dir, 'memory.md'), { recursive: true })
  const outside = join(f.root, 'outside')
  mkdirSync(outside)
  writeFileSync(join(outside, 'memory.md'), 'OUTSIDE')
  symlinkSync(outside, join(f.dir, 'memory.md'), 'junction')
  await assert.rejects(read.execute({}, {}), /链接|link/)
  await assert.rejects(f.tools.get('world_book_upsert').execute({ id: 'entry', name: 'Entry', content: 'PUBLIC', note: 'BAD' }, {}), /链接|link/)
  assert.equal(readFileSync(join(outside, 'memory.md'), 'utf8'), 'OUTSIDE')
})
