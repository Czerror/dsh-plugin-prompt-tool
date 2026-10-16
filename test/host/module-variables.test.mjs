import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import fs, { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { syncBuiltinESMExports } from 'node:module'
import { basename, dirname, join } from 'node:path'
import { parse } from 'yaml'
import { isolatedHome, tempDir } from '../fixtures/host-harness.mjs'

const { home, moduleRoot } = isolatedHome('pt-module-variables-')
const otherHome = tempDir('pt-module-variables-other-')
const { readModuleVariables, editModuleVariables } = await import('../../src/host/module-variables.ts')
const { globalVariablesFile } = await import('../../src/host/paths.ts')
const entry = new URL('../../src/host/module-variables.ts', import.meta.url).href
const storage = new URL('../../src/host/module-slices.ts', import.meta.url).href
const write = new URL('../../src/host/module-write.ts', import.meta.url).href

function fixture(t, id) {
  const dir = join(moduleRoot, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'module.yml'), `id: ${id}\nmodules: []\nrules: []\nvariables:\n  owner: Mia # owner comment\nunknown: { keep: true }\n`)
  rmSync(globalVariablesFile(), { force: true })
  t.after(() => rmSync(globalVariablesFile(), { force: true }))
  return dir
}

test('变量主路径：全局持久值跨进程共享，模块快照独立且 YAML 注释与未知字段保留', t => {
  const dir = fixture(t, 'shared')
  const initial = readModuleVariables(dir)
  assert.deepEqual(initial.global, {})
  assert.equal(initial.revisions.global, null)
  assert.equal(existsSync(globalVariablesFile()), false, '缺失只读不创建全局文件')
  writeFileSync(globalVariablesFile(), '# global owner\nvariables:\n  counter: "10" # counter comment\nunknown: { keep: true }\n')
  const before = readModuleVariables(dir)
  const saved = editModuleVariables(dir, { scope: 'global', changes: { counter: '20', empty: '' }, expectedRevisions: before.revisions })
  assert.deepEqual(saved.global, { counter: '20', empty: '' })
  assert.deepEqual(saved.effective, { counter: '20', empty: '', owner: 'Mia' })
  assert.equal(saved.persisted, true)
  const text = readFileSync(globalVariablesFile(), 'utf8')
  for (const comment of ['global owner', 'counter comment']) assert.ok(text.includes('# ' + comment))
  assert.deepEqual(parse(text).unknown, { keep: true })
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', `
    import { readModuleVariables } from ${JSON.stringify(entry)};
    process.stdout.write(JSON.stringify(readModuleVariables(process.argv[1])));
  `, dir], { cwd: process.cwd(), env: { ...process.env, DSH_HOME: home }, encoding: 'utf8' })
  assert.equal(child.status, 0, child.stderr)
  assert.deepEqual(JSON.parse(child.stdout).global, saved.global)
  const isolated = spawnSync(process.execPath, ['--input-type=module', '--eval', `
    import { readModuleVariables } from ${JSON.stringify(entry)};
    process.stdout.write(JSON.stringify(readModuleVariables(process.argv[1]).global));
  `, dir], { cwd: process.cwd(), env: { ...process.env, DSH_HOME: otherHome }, encoding: 'utf8' })
  assert.equal(isolated.status, 0, isolated.stderr)
  assert.deepEqual(JSON.parse(isolated.stdout), {}, '不同 DSH_HOME 全局值隔离')
  const changed = editModuleVariables(dir, { scope: 'module', changes: { owner: 'Nova', counter: '21', empty: '' }, expectedRevisions: saved.revisions })
  assert.deepEqual(changed.module, { owner: 'Nova', counter: '21', empty: '' })
  assert.equal(changed.global.counter, '20', '从全局回落计算的结果只写来源模块')
  assert.equal(changed.effective.counter, '21')
  const moduleText = readFileSync(join(dir, 'module.yml'), 'utf8')
  assert.match(moduleText, /# owner comment/)
  assert.deepEqual(parse(moduleText).unknown, { keep: true })
  assert.deepEqual(parse(readFileSync(join(dir, 'rules', 'variables.yml'), 'utf8')), changed.module)
  const peer = join(moduleRoot, 'peer')
  mkdirSync(peer)
  writeFileSync(join(peer, 'module.yml'), 'id: peer\nmodules: []\nrules: []\nvariables: { owner: Bob }\n')
  assert.deepEqual(readModuleVariables(peer).effective, { counter: '20', empty: '', owner: 'Bob' }, '模块同名值不串写')
  const replaced = editModuleVariables(dir, { scope: 'module', values: { owner: '' }, expectedRevisions: changed.revisions })
  assert.deepEqual(replaced.effective, { counter: '20', empty: '', owner: '' }, '整表替换移除模块覆盖，空串仍保留')
  const deleted = editModuleVariables(dir, { scope: 'global', changes: { counter: null }, expectedRevisions: replaced.revisions })
  assert.deepEqual(deleted.global, { empty: '' }, '空串保存，只有 null 明确删除')
})

test('变量拒绝：缺值、保留名、过期版本、体积、坏 YAML 与链接都保持原文件', t => {
  const dir = fixture(t, 'reject')
  const first = readModuleVariables(dir)
  const saved = editModuleVariables(dir, { scope: 'global', values: { keep: 'KEEP' }, expectedRevisions: first.revisions })
  const before = readFileSync(globalVariablesFile(), 'utf8')
  for (const request of [
    { scope: 'session', changes: { keep: 'NO' } },
    { changes: { keep: undefined } },
    { values: { keep: 1 } },
    { changes: { CWD: 'NO' } },
    { changes: { pick: 'NO' } },
    { changes: { ' spaced ': 'NO' } },
    { changes: JSON.parse('{"__proto__":"NO"}') },
    { changes: { keep: 'NO' }, expectedRevisions: {} },
    { changes: { keep: 'NO' }, expectedRevisions: { global: null } },
    { changes: { huge: 'x'.repeat(1024 * 1024 + 1) } },
    { values: Object.fromEntries(Array.from({ length: 5 }, (_, index) => ['large' + index, 'x'.repeat(1024 * 1024)])) },
    { values: {}, changes: {} },
  ]) {
    assert.throws(() => editModuleVariables(dir, { scope: 'global', expectedRevisions: saved.revisions, ...request }))
    assert.equal(readFileSync(globalVariablesFile(), 'utf8'), before)
  }
  const dependency = readModuleVariables(dir)
  const globalChanged = editModuleVariables(dir, { scope: 'global', changes: { counter: '20' }, expectedRevisions: dependency.revisions })
  const moduleBefore = readFileSync(join(dir, 'module.yml'), 'utf8')
  assert.throws(() => editModuleVariables(dir, { scope: 'module', changes: { counter: '11' }, expectedRevisions: dependency.revisions }), error => error.status === 409, '写模块也校验被读取的全局版本')
  assert.equal(readFileSync(join(dir, 'module.yml'), 'utf8'), moduleBefore)
  const moduleChanged = editModuleVariables(dir, { scope: 'module', changes: { owner: 'Lee' }, expectedRevisions: globalChanged.revisions })
  assert.throws(() => editModuleVariables(dir, { scope: 'global', changes: { keep: 'LOST' }, expectedRevisions: globalChanged.revisions }), error => error.status === 409, '写全局也校验被读取的模块版本')
  assert.throws(() => editModuleVariables(dir, { scope: 'module', changes: { other: 'LOST' }, expectedRevisions: globalChanged.revisions }), error => error.status === 409, '两个调用者读取同一模块后，不允许后写者覆盖先写者')
  const retry = editModuleVariables(dir, { scope: 'module', changes: { other: 'KEPT' }, expectedRevisions: moduleChanged.revisions })
  assert.deepEqual(retry.module, { owner: 'Lee', other: 'KEPT' })
  writeFileSync(globalVariablesFile(), 'variables: &shared { keep: KEEP }\nunknown: *shared\n')
  const aliased = readModuleVariables(dir)
  const aliasBytes = readFileSync(globalVariablesFile(), 'utf8')
  assert.throws(() => editModuleVariables(dir, { scope: 'global', changes: { keep: 'ALTERED' }, expectedRevisions: aliased.revisions }), /YAML.*引用/)
  assert.equal(readFileSync(globalVariablesFile(), 'utf8'), aliasBytes, '变量锚点不能连带修改其他字段')
  writeFileSync(globalVariablesFile(), 'variables: null\n')
  assert.throws(() => readModuleVariables(dir), /平铺字符串/)
  writeFileSync(globalVariablesFile(), 'variables: [\n')
  assert.throws(() => readModuleVariables(dir), /YAML/)
  assert.throws(() => editModuleVariables(dir, { scope: 'global', values: {}, expectedRevisions: saved.revisions }), /YAML/)
  assert.equal(readFileSync(globalVariablesFile(), 'utf8'), 'variables: [\n')
  rmSync(globalVariablesFile())
  const target = join(home, 'outside-variables.yml')
  writeFileSync(target, before)
  symlinkSync(target, globalVariablesFile())
  assert.throws(() => readModuleVariables(dir), /链接|普通文件/)
  assert.throws(() => editModuleVariables(dir, { scope: 'global', values: {}, expectedRevisions: saved.revisions }), /链接|普通文件/)
  assert.equal(readFileSync(target, 'utf8'), before)
})

test('变量边界：相同整表幂等，跨进程锁阻止并行丢更新', async t => {
  const dir = fixture(t, 'boundary')
  const first = readModuleVariables(dir)
  const saved = editModuleVariables(dir, { scope: 'global', values: { count: '1' }, expectedRevisions: first.revisions })
  const before = readFileSync(globalVariablesFile(), 'utf8')
  const result = editModuleVariables(dir, { scope: 'global', values: { count: '1' }, expectedRevisions: saved.revisions })
  assert.deepEqual(result.revisions, saved.revisions)
  assert.equal(readFileSync(globalVariablesFile(), 'utf8'), before)
  const child = spawn(process.execPath, ['--input-type=module', '--eval', `
    import fs from 'node:fs';
    import { withModuleLock } from ${JSON.stringify(write)};
    withModuleLock(process.argv[1], 'variables', () => {
      fs.writeSync(1, 'locked\\n');
      fs.readSync(0, Buffer.alloc(1), 0, 1, null);
    });
  `, dirname(globalVariablesFile())], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] })
  const exited = once(child, 'exit')
  try {
    const [signal] = await once(child.stdout, 'data')
    assert.equal(signal.toString(), 'locked\n')
    assert.throws(() => editModuleVariables(dir, { scope: 'global', changes: { count: '2' }, expectedRevisions: saved.revisions }), error => error.status === 409)
    assert.equal(readFileSync(globalVariablesFile(), 'utf8'), before)
  } finally {
    child.stdin.end('x')
    assert.equal((await exited)[0], 0)
  }
  const rename = fs.renameSync
  let observedModuleLock = false
  mock.method(fs, 'renameSync', (from, to) => {
    if (to === globalVariablesFile()) {
      const contender = spawnSync(process.execPath, ['--input-type=module', '--eval', `
        import { loadModuleDefinition, commitModuleDefinition } from ${JSON.stringify(storage)};
        const source = loadModuleDefinition(process.argv[1]);
        source.doc.setIn(['variables', 'owner'], 'CONCURRENT');
        try { commitModuleDefinition(source, source.doc); process.exit(1); }
        catch (error) { process.exit(error.status === 409 ? 0 : 2); }
      `, dir], { cwd: process.cwd(), encoding: 'utf8' })
      assert.equal(contender.status, 0, contender.stderr)
      observedModuleLock = true
    }
    return rename(from, to)
  })
  syncBuiltinESMExports()
  try { editModuleVariables(dir, { scope: 'global', changes: { count: '2' }, expectedRevisions: saved.revisions }) }
  finally { mock.restoreAll(); syncBuiltinESMExports() }
  assert.equal(observedModuleLock, true, '全局提交期间持有模块读依赖锁')
  const fresh = readModuleVariables(dir)
  mock.method(fs, 'renameSync', (from, to) => {
    if (basename(to) === '_settings.yml') throw new Error('publication failure')
    return rename(from, to)
  })
  syncBuiltinESMExports()
  let pending
  try { pending = editModuleVariables(dir, { scope: 'module', changes: { count: '3' }, expectedRevisions: fresh.revisions }) }
  finally { mock.restoreAll(); syncBuiltinESMExports() }
  assert.equal(pending.persisted, true)
  assert.equal(pending.publicationPending, true)
  assert.equal(pending.module.count, '3')
  assert.equal(parse(readFileSync(join(dir, 'module.yml'), 'utf8')).variables.count, '3')
  const recovered = readModuleVariables(dir)
  assert.deepEqual(recovered.revisions, pending.revisions)
  assert.equal(recovered.effective.count, '3', '已提交而发布失败仍报告新值，后续恢复不重放变更')
})
