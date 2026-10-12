import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { tempDir } from '../fixtures/host-harness.mjs'
import { registerModuleMemoryTools } from '../../src/runtime/module-memory-tools.ts'
import { resolveModuleToolTarget } from '../../src/host/module-tool-target.ts'

function fixture(t) {
  // 系统临时目录 + 夹具登记的清理：不在仓库 cwd 里留 pt-module-memory-*。
  const root = tempDir('pt-module-memory-')
  const moduleRoot = join(root, 'modules')
  const dir = join(moduleRoot, 'alice')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'module.yml'), 'id: alice\nname: Alice\nmodules: []\nrules: []\n')
  const tools = new Map()
  let rebuilds = 0
  const dispose = registerModuleMemoryTools({
    inject: (_deps, callback) => ({ dispose: callback({ tools: { register: tool => {
      tools.set(tool.name, tool)
      return () => tools.delete(tool.name)
    } } }) }),
  }, { root: moduleRoot, target: (exec, moduleId) => resolveModuleToolTarget(exec, moduleRoot, () => ['alice'], moduleId), rebuild: async () => { rebuilds += 1 } })
  t.after(() => { dispose(); assert.equal(tools.size, 0) })
  return { root, dir, tools, rebuilds: () => rebuilds }
}

test('模块记忆工具独立追加和读取最新内容，空追加不写盘且不增加规则', async t => {
  const f = fixture(t)
  const read = f.tools.get('module_memory_read')
  assert.ok(read, '必须注册显式记忆读取工具')
  await assert.rejects(read.execute({}, {}), /没有声明模块目标/, '不声明模块就不挑一个')
  assert.deepEqual(await read.execute({ moduleId: 'alice' }, {}), { memory: '' })
  await f.tools.get('module_memory_append').execute({ content: 'PRIVATE NOTE', moduleId: 'alice' }, {})
  assert.match(readFileSync(join(f.dir, 'memory.md'), 'utf8'), /PRIVATE NOTE/)
  const memory = (await read.execute({ moduleId: 'alice' }, {})).memory
  assert.match(memory, /PRIVATE NOTE/)
  writeFileSync(join(f.dir, 'memory.md'), 'UPDATED MEMORY')
  assert.deepEqual(await read.execute({ moduleId: 'alice' }, {}), { memory: 'UPDATED MEMORY' })
  const spec = parse(readFileSync(join(f.dir, 'module.yml'), 'utf8'))
  assert.deepEqual(spec.rules, [])
  await f.tools.get('module_memory_append').execute({ content: '   ', moduleId: 'alice' }, {})
  assert.equal(readFileSync(join(f.dir, 'memory.md'), 'utf8'), 'UPDATED MEMORY')
  assert.equal(f.rebuilds(), 0, '记忆操作不触发重新装配')
})

test('模块记忆读取失败显式拒绝，链接目标不能读写', async t => {
  const f = fixture(t)
  const read = f.tools.get('module_memory_read')
  assert.ok(read)
  mkdirSync(join(f.dir, 'memory.md'))
  await assert.rejects(read.execute({ moduleId: 'alice' }, {}), /memory|directory|EISDIR|EPERM/i)
  rmSync(join(f.dir, 'memory.md'), { recursive: true })
  const outside = join(f.root, 'outside')
  mkdirSync(outside)
  writeFileSync(join(outside, 'memory.md'), 'OUTSIDE')
  symlinkSync(outside, join(f.dir, 'memory.md'), 'junction')
  await assert.rejects(read.execute({ moduleId: 'alice' }, {}), /链接|link/)
  await assert.rejects(f.tools.get('module_memory_append').execute({ content: 'BAD', moduleId: 'alice' }, {}), /链接|link/)
  assert.equal(readFileSync(join(outside, 'memory.md'), 'utf8'), 'OUTSIDE')
})
