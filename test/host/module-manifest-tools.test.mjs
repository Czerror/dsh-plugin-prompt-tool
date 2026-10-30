import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tempDir } from '../fixtures/host-harness.mjs'
import { registerModuleManifestTools } from '../../src/runtime/module-manifest-tools.ts'
import { resolveModuleToolTarget } from '../../src/host/module-tool-target.ts'

const MANIFEST = `dirs:
  - data/10-宪章
files:
  - from: assets/AGENTS.md
    to: data/AGENTS.md
checks:
  - path: data/02-墨.jsonl
    kind: jsonl
    maxBytes: 8388608
`

function fixture(t, manifest = MANIFEST) {
  const root = tempDir('pt-module-manifest-')
  const moduleRoot = join(root, 'modules')
  const dir = join(moduleRoot, 'alice')
  mkdirSync(join(dir, 'assets'), { recursive: true })
  writeFileSync(join(dir, 'assets', 'AGENTS.md'), 'AGENTS TEMPLATE')
  writeFileSync(join(dir, 'assets', 'manifest.yml'), manifest)
  writeFileSync(join(dir, 'module.yml'), 'id: alice\nname: Alice\nmodules: []\nrules: []\n')
  const tools = new Map()
  const dispose = registerModuleManifestTools({
    inject: (_deps, callback) => ({ dispose: callback({ tools: { register: tool => {
      tools.set(tool.name, tool)
      return () => tools.delete(tool.name)
    } } }) }),
  }, { root: moduleRoot, target: (exec, moduleId) => resolveModuleToolTarget(exec, moduleRoot, () => ['alice'], moduleId), rebuild: async () => {} })
  t.after(() => { dispose(); assert.equal(tools.size, 0) })
  return { root, dir, tools, run: (action) => tools.get('module_manifest').execute({ moduleId: 'alice', action }, {}) }
}

test('模块清单：next 按目录 → 文件 → 检查顺序，apply 只落缺失', async t => {
  const f = fixture(t)
  assert.deepEqual(await f.run('next'), { action: 'next', ok: false, entries: [{ kind: 'dir', path: 'data/10-宪章' }] })

  const applied = await f.run('apply')
  assert.equal(applied.action, 'apply')
  const created = applied.entries.filter(entry => entry.skipped === false).map(entry => entry.path)
  assert.ok(created.includes('data/10-宪章'))
  assert.ok(created.includes('data/AGENTS.md'))
  assert.equal(readFileSync(join(f.dir, 'data', 'AGENTS.md'), 'utf8'), 'AGENTS TEMPLATE')
  assert.deepEqual(await f.run('next'), { action: 'next', ok: false, entries: [{ kind: 'check', path: 'data/02-墨.jsonl' }] })

  writeFileSync(join(f.dir, 'data', '02-墨.jsonl'), '{"type":"fact"}\n')
  assert.deepEqual(await f.run('next'), { action: 'next', ok: true, entries: [] })

  const again = await f.run('apply')
  assert.deepEqual(again.entries.filter(entry => entry.skipped === false), [])
  assert.ok(again.entries.some(entry => entry.path === 'data/AGENTS.md' && entry.skipped === true), '已存在不覆盖')
})

test('模块清单：check 的四种 kind 与坏行定位', async t => {
  const f = fixture(t, `checks:
  - path: data/a.md
    kind: file
  - path: data/b.md
    kind: text
  - path: data/c.json
    kind: json
  - path: data/d.jsonl
    kind: jsonl
`)
  mkdirSync(join(f.dir, 'data'))
  writeFileSync(join(f.dir, 'data', 'a.md'), 'A')
  writeFileSync(join(f.dir, 'data', 'b.md'), 'B')
  writeFileSync(join(f.dir, 'data', 'c.json'), '{"ok":true}')
  writeFileSync(join(f.dir, 'data', 'd.jsonl'), '{"n":1}\n坏行\n')
  const checked = await f.run('check')
  assert.equal(checked.ok, false)
  assert.deepEqual(checked.entries.map(entry => [entry.path, entry.ok]), [
    ['data/a.md', true], ['data/b.md', true], ['data/c.json', true], ['data/d.jsonl', false],
  ])
  assert.match(checked.entries[3].error, /第 2 行/)

  writeFileSync(join(f.dir, 'data', 'c.json'), '{bad')
  assert.equal((await f.run('check')).entries[2].ok, false)
})

test('模块清单：未知字段、越界路径与链接拒绝', async t => {
  for (const manifest of [
    'unknown: 1\n',
    'dirs:\n  - data/../module.yml\n',
    'files:\n  - from: assets/AGENTS.md\n    to: module.yml\n',
    'checks:\n  - path: data/x\n    kind: xml\n',
    'checks:\n  - path: data/x\n    kind: file\n    extra: 1\n',
  ]) {
    const f = fixture(t, manifest)
    await assert.rejects(f.run('next'), /未知字段|非法资源路径|只能位于|kind/)
  }
  const f = fixture(t)
  mkdirSync(join(f.dir, 'data'))
  mkdirSync(join(f.root, 'outside'))
  symlinkSync(join(f.root, 'outside'), join(f.dir, 'data', '10-宪章'), 'junction')
  await assert.rejects(f.run('apply'), /链接|link/)

  const fromOutside = fixture(t, 'files:\n  - from: data/x\n    to: data/y\n')
  await assert.rejects(fromOutside.run('next'), /只能位于 assets\//, 'from 只读 assets')
  const big = fixture(t, 'files:\n  - from: assets/big.bin\n    to: data/big.bin\n')
  writeFileSync(join(big.dir, 'assets', 'big.bin'), Buffer.alloc(1024 * 1024 + 1, 0x61))
  await assert.rejects(big.run('apply'), /超过 1 MiB/)
  const missing = fixture(t)
  await assert.rejects(missing.tools.get('module_manifest').execute({ action: 'next' }, {}), /没有声明模块目标/, '工具按显式 moduleId 定位')
  await assert.rejects(missing.run('bad'), /action|must be/)
})
