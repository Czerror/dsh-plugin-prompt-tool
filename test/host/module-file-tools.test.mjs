import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tempDir } from '../fixtures/host-harness.mjs'
import { registerModuleFileTools } from '../../src/runtime/module-file-tools.ts'
import { resolveModuleToolTarget } from '../../src/host/module-tool-target.ts'

function fixture(t) {
  const root = tempDir('pt-module-file-')
  const moduleRoot = join(root, 'modules')
  const dir = join(moduleRoot, 'alice')
  mkdirSync(join(dir, 'assets'), { recursive: true })
  writeFileSync(join(dir, 'assets', 'knowledge.md'), 'KNOWLEDGE')
  writeFileSync(join(dir, 'module.yml'), 'id: alice\nname: Alice\nmodules: []\nrules: []\n')
  const tools = new Map()
  let rebuilds = 0
  const dispose = registerModuleFileTools({
    inject: (_deps, callback) => ({ dispose: callback({ tools: { register: tool => {
      tools.set(tool.name, tool)
      return () => tools.delete(tool.name)
    } } }) }),
  }, { root: moduleRoot, target: (exec, moduleId) => resolveModuleToolTarget(exec, moduleRoot, () => ['alice'], moduleId), rebuild: async () => { rebuilds += 1 } })
  t.after(() => { dispose(); assert.equal(tools.size, 0) })
  return { root, dir, tools, rebuilds: () => rebuilds }
}

test('模块文件工具：读三处根、缺失为空、追加文本与 JSON 行', async t => {
  const f = fixture(t)
  const read = f.tools.get('module_file_read')
  const append = f.tools.get('module_file_append')
  assert.ok(read, '必须注册文件读取工具')
  assert.ok(append, '必须注册文件追加工具')

  await assert.rejects(read.execute({ path: 'memory.md' }, {}), /没有声明模块目标/, '不声明模块就不挑一个')
  assert.deepEqual(await read.execute({ moduleId: 'alice', path: 'memory.md' }, {}), { path: 'memory.md', content: '', bytes: 0 })
  assert.deepEqual(await read.execute({ moduleId: 'alice', path: 'assets/knowledge.md' }, {}),
    { path: 'assets/knowledge.md', content: 'KNOWLEDGE', bytes: 9 })
  assert.deepEqual(await read.execute({ moduleId: 'alice', path: 'data/AGENTS.md' }, {}),
    { path: 'data/AGENTS.md', content: '', bytes: 0 }, 'data/ 尚未装配时缺失为空')

  await append.execute({ moduleId: 'alice', path: 'memory.md', content: 'PRIVATE NOTE' }, {})
  assert.equal(readFileSync(join(f.dir, 'memory.md'), 'utf8'), 'PRIVATE NOTE\n')
  writeFileSync(join(f.dir, 'memory.md'), 'UPDATED MEMORY')
  assert.deepEqual(await read.execute({ moduleId: 'alice', path: 'memory.md' }, {}),
    { path: 'memory.md', content: 'UPDATED MEMORY', bytes: 14 }, '每次读最新内容')

  await append.execute({ moduleId: 'alice', path: 'data/02-墨.jsonl', entry: { type: 'fact', text: 'a' } }, {})
  await append.execute({ moduleId: 'alice', path: 'data/02-墨.jsonl', entry: { type: 'gain', text: 'b' } }, {})
  const lines = readFileSync(join(f.dir, 'data', '02-墨.jsonl'), 'utf8').trim().split('\n')
  assert.equal(lines.length, 2, 'entry 一次一行')
  assert.deepEqual(JSON.parse(lines[0]), { type: 'fact', text: 'a' })
  assert.deepEqual(JSON.parse(lines[1]), { type: 'gain', text: 'b' })
  assert.deepEqual(await read.execute({ moduleId: 'alice', path: 'data/02-墨.jsonl' }, {}),
    { path: 'data/02-墨.jsonl', content: '{"type":"fact","text":"a"}\n{"type":"gain","text":"b"}\n', bytes: Buffer.byteLength('{"type":"fact","text":"a"}\n{"type":"gain","text":"b"}\n') })

  assert.deepEqual(await append.execute({ moduleId: 'alice', path: 'memory.md', content: '   ' }, {}), { appended: false, path: 'memory.md' })
  assert.equal(readFileSync(join(f.dir, 'memory.md'), 'utf8'), 'UPDATED MEMORY', '空白不写')
  assert.equal(f.rebuilds(), 0, '文件操作不触发重新装配')
})

test('模块文件工具：越界、链接与非法请求拒绝，零写盘', async t => {
  const f = fixture(t)
  const read = f.tools.get('module_file_read')
  const append = f.tools.get('module_file_append')

  for (const path of ['../module.yml', '/etc/passwd', 'configs/x.md', 'assets\\x.md', 'assets/../module.yml', '']) {
    await assert.rejects(read.execute({ moduleId: 'alice', path }, {}), /非法资源路径|只能位于|非空/, path)
  }
  await assert.rejects(read.execute({ moduleId: 'alice', path: 'data/../module.yml' }, {}), /非法资源路径/)
  await assert.rejects(append.execute({ moduleId: 'alice', path: 'assets/knowledge.md', content: 'x' }, {}), /只能追加到/)
  await assert.rejects(append.execute({ moduleId: 'alice', path: 'data/x.jsonl' }, {}), /之一/)
  await assert.rejects(append.execute({ moduleId: 'alice', path: 'data/x.jsonl', content: 'x', entry: {} }, {}), /之一/)
  await assert.rejects(append.execute({ moduleId: 'alice', path: 'data/x.jsonl', entry: [] }, {}), /JSON 对象|must be an object/)
  await assert.rejects(append.execute({ moduleId: 'alice', path: 'data/x.jsonl', entry: {}, extra: 1 }, {}), /未知字段/)
  await assert.rejects(read.execute({ moduleId: 'alice', path: 'data/x.jsonl', extra: 1 }, {}), /未知字段/)

  const outside = join(f.root, 'outside')
  mkdirSync(outside)
  writeFileSync(join(outside, 'x.md'), 'OUTSIDE')
  symlinkSync(outside, join(f.dir, 'data'), 'junction')
  await assert.rejects(read.execute({ moduleId: 'alice', path: 'data/x.md' }, {}), /链接|link/)
  await assert.rejects(append.execute({ moduleId: 'alice', path: 'data/x.jsonl', content: 'BAD' }, {}), /链接|link/)
  assert.equal(readFileSync(join(outside, 'x.md'), 'utf8'), 'OUTSIDE', '链接目标不被改写')
})

test('模块文件工具：大小、编码与目录边界', async t => {
  const f = fixture(t)
  const read = f.tools.get('module_file_read')
  const append = f.tools.get('module_file_append')

  writeFileSync(join(f.dir, 'assets', 'big.md'), Buffer.alloc(1024 * 1024 + 1, 0x61))
  await assert.rejects(read.execute({ moduleId: 'alice', path: 'assets/big.md' }, {}), /1 MiB/)
  writeFileSync(join(f.dir, 'assets', 'bad.md'), Buffer.from([0xff, 0xfe, 0x00]))
  await assert.rejects(read.execute({ moduleId: 'alice', path: 'assets/bad.md' }, {}), /UTF-8|utf-8|encoded/i)

  mkdirSync(join(f.dir, 'data', 'nested'), { recursive: true })
  await assert.rejects(read.execute({ moduleId: 'alice', path: 'data/nested' }, {}), /不是普通文件/)

  await assert.rejects(append.execute({ moduleId: 'alice', path: 'data/x.jsonl', content: 'a'.repeat(1024 * 1024 + 1) }, {}), /1 MiB/)
  writeFileSync(join(f.dir, 'memory.md'), 'a'.repeat(1024 * 1024))
  await assert.rejects(append.execute({ moduleId: 'alice', path: 'memory.md', content: 'x' }, {}), /1 MiB/, '写侧不制造读不出来的文件')
  writeFileSync(join(f.dir, 'data', 'ledger-big.jsonl'), Buffer.alloc(1024 * 1024 + 1, 0x0a))
  const big = await read.execute({ moduleId: 'alice', path: 'data/ledger-big.jsonl' }, {})
  assert.ok(big.bytes > 1024 * 1024, 'data 读上限与 8 MiB 写上限对齐')
  writeFileSync(join(f.dir, 'data', 'full.jsonl'), Buffer.alloc(8 * 1024 * 1024, 0x0a))
  await assert.rejects(append.execute({ moduleId: 'alice', path: 'data/full.jsonl', content: 'x' }, {}), /8 MiB/)
})
