import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import fs, { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { syncBuiltinESMExports } from 'node:module'
import { parse } from 'yaml'
import { isolatedHome } from '../fixtures/host-harness.mjs'

const { home } = isolatedHome('pt-persona-selection-')
const { readPersonaSources, writePersonaSources, selectedPersonaModules } = await import('../../src/host/persona-selection.ts')
const { enabledModuleIds, enableTablePath, setModuleEnabled } = await import('../../src/host/config-store.ts')
function fixture(name) {
  const root = join(home, name, 'modules')
  for (const id of ['alpha', 'beta']) {
    mkdirSync(join(root, id), { recursive: true })
    writeFileSync(join(root, id, 'module.yml'), JSON.stringify({ id, name: id.toUpperCase(), modules: [], rules: [],
      persona: { main: { prefix: id + '-MAIN', complete: false }, subagent: { suffix: id + '-CHILD' } }, variablesEnabled: id !== 'beta' }))
  }
  return root
}

test('人设来源主路径：主子独立选择未启用模块，筛选对应正文，持久化保启用表与注释', () => {
  const root = fixture('roundtrip'), file = enableTablePath(root)
  const initial = readPersonaSources(root)
  assert.deepEqual(initial.sources, { main: null, subagent: null })
  assert.equal(initial.revision, null)
  assert.deepEqual(initial.candidates, [{ id: 'alpha', name: 'ALPHA' }, { id: 'beta', name: 'BETA' }])
  assert.equal(existsSync(file), false, '读取缺失配置不写盘')
  const alphaFile = join(root, 'alpha', 'module.yml'), betaFile = join(root, 'beta', 'module.yml')
  const sourceBytes = [readFileSync(alphaFile), readFileSync(betaFile)]
  const alphaProjection = join(root, 'alpha', 'rules', '_settings.yml'), betaProjection = join(root, 'beta', 'rules', '_settings.yml')
  assert.equal(existsSync(alphaProjection), false, '只读候选列表不物化投影')
  const selected = writePersonaSources(root, { main: 'alpha', subagent: 'beta' }, null)
  assert.deepEqual(parse(readFileSync(alphaProjection, 'utf8')).persona, parse(sourceBytes[0].toString()).persona, '未启用规则的人设来源也生成校验投影')
  writeFileSync(betaProjection, 'persona: { subagent: { prefix: FORGED } }\n')
  assert.deepEqual(enabledModuleIds(root), [], '选择人设不启用普通规则')
  assert.deepEqual(selectedPersonaModules(root), [
    { moduleId: 'alpha', persona: { main: { prefix: 'alpha-MAIN', complete: false } }, variablesEnabled: true },
    { moduleId: 'beta', persona: { subagent: { suffix: 'beta-CHILD' } }, variablesEnabled: false },
  ])
  assert.deepEqual(selectedPersonaModules(root, { main: 'alpha', subagent: 'alpha' }), [
    { moduleId: 'alpha', persona: { main: { prefix: 'alpha-MAIN', complete: false }, subagent: { suffix: 'alpha-CHILD' } }, variablesEnabled: true },
  ])
  assert.deepEqual(parse(readFileSync(betaProjection, 'utf8')).persona, parse(sourceBytes[1].toString()).persona, '运行读取从唯一源恢复被篡改的投影')
  assert.deepEqual([readFileSync(alphaFile), readFileSync(betaFile)], sourceBytes, '派生投影恢复不改模块源字节')
  assert.deepEqual(selected.sources, { main: 'alpha', subagent: 'beta' })
  writeFileSync(file, '# user configuration\nschemaVersion: 3\nenabled: [beta] # enabled comment\npersonaSources: # selection comment\n  main: alpha # main source comment\nunknown: { keep: true }\n')
  const before = readPersonaSources(root)
  const changed = writePersonaSources(root, { main: 'beta', subagent: 'alpha' }, before.revision)
  const text = readFileSync(file, 'utf8')
  for (const comment of ['user configuration', 'enabled comment', 'selection comment', 'main source comment']) assert.ok(text.includes(comment), comment)
  assert.deepEqual(parse(text).enabled, ['beta'])
  assert.deepEqual(parse(text).unknown, { keep: true })
  setModuleEnabled(root, 'alpha', true)
  assert.deepEqual(readPersonaSources(root).sources, changed.sources, '启用表更新不丢来源选择')
  const latest = readPersonaSources(root)
  const cleared = writePersonaSources(root, { main: null, subagent: null }, latest.revision)
  assert.deepEqual(cleared.sources, { main: null, subagent: null })
  assert.equal(parse(readFileSync(file, 'utf8')).personaSources, undefined)
  assert.deepEqual(enabledModuleIds(root), ['beta', 'alpha'])
  assert.deepEqual(selectedPersonaModules(root), [])
})

test('人设来源拒绝：陈旧版本、未知目标、非法字段、链接与坏 YAML 均不覆盖既有配置', () => {
  const root = fixture('reject'), file = enableTablePath(root)
  const saved = writePersonaSources(root, { main: 'alpha', subagent: null }, null)
  const bytes = readFileSync(file)
  for (const [sources, revision] of [
    [{ main: 'beta', subagent: null }, null], [{ main: '../beta', subagent: null }, saved.revision],
    [{ main: 'missing', subagent: null }, saved.revision], [{ main: false, subagent: null }, saved.revision],
    [{ main: 'alpha', subagent: null, other: 'beta' }, saved.revision], [{ main: 'alpha' }, saved.revision],
  ]) {
    assert.throws(() => writePersonaSources(root, sources, revision))
    assert.deepEqual(readFileSync(file), bytes)
  }
  mkdirSync(join(root, 'invalid'))
  writeFileSync(join(root, 'invalid', 'module.yml'), 'id: invalid\nmodules: []\nrules: [null]\n')
  assert.equal(readPersonaSources(root).candidates.some(item => item.id === 'invalid'), false)
  assert.throws(() => writePersonaSources(root, { main: 'invalid', subagent: null }, saved.revision))
  writeFileSync(file, 'schemaVersion: 3\nenabled: [beta]\npersonaSources: &shared { main: alpha }\nunknown: *shared\n')
  const aliased = readPersonaSources(root)
  const aliasBytes = readFileSync(file)
  assert.throws(() => writePersonaSources(root, { main: 'beta', subagent: null }, aliased.revision), /引用|alias/i)
  assert.deepEqual(readFileSync(file), aliasBytes)
  writeFileSync(file, 'personaSources: [broken\n')
  assert.throws(() => readPersonaSources(root), /YAML/)
  assert.throws(() => writePersonaSources(root, { main: null, subagent: null }, saved.revision), /YAML/)
  assert.throws(() => setModuleEnabled(root, 'alpha', true), /YAML/)
  assert.equal(readFileSync(file, 'utf8'), 'personaSources: [broken\n')
  rmSync(file)
  const outside = join(home, 'unowned-config.yml')
  writeFileSync(outside, bytes)
  symlinkSync(outside, file)
  assert.throws(() => readPersonaSources(root), /链接|普通/)
  assert.throws(() => setModuleEnabled(root, 'beta', true), /链接|普通/)
  assert.deepEqual(readFileSync(outside), bytes)
  rmSync(file)
  writeFileSync(file, bytes)
  symlinkSync(join(root, 'beta'), join(root, 'linked'), 'junction')
  assert.throws(() => writePersonaSources(root, { main: 'linked', subagent: null }, saved.revision), /链接/)
  assert.deepEqual(readFileSync(file), bytes)
})

test('人设来源边界：相同选择幂等，跨进程与启用表共享锁，替换前外部变化保持原件', async () => {
  const root = fixture('lock'), file = enableTablePath(root)
  const saved = writePersonaSources(root, { main: 'alpha', subagent: null }, null)
  const bytes = readFileSync(file)
  assert.equal(writePersonaSources(root, saved.sources, saved.revision).revision, saved.revision)
  assert.deepEqual(readFileSync(file), bytes)
  const manualRoot = fixture('manual-noop'), manualFile = enableTablePath(manualRoot)
  const manual = '{ schemaVersion: 3, enabled: [ ], personaSources: { main: alpha } }'
  writeFileSync(manualFile, manual)
  const unchanged = readPersonaSources(manualRoot)
  writePersonaSources(manualRoot, unchanged.sources, unchanged.revision)
  setModuleEnabled(manualRoot, 'beta', false)
  assert.equal(readFileSync(manualFile, 'utf8'), manual, '相同语义保留手工空格与无末尾换行')
  const owner = new URL('../../src/host/module-storage.ts', import.meta.url).href
  const child = spawn(process.execPath, ['--input-type=module', '--eval', `
    import fs from 'node:fs'; import { withModuleLock } from ${JSON.stringify(owner)};
    withModuleLock(process.argv[1], 'config', () => { fs.writeSync(1, 'locked'); fs.readSync(0, Buffer.alloc(1), 0, 1, null); });
  `, dirname(file)], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] })
  const exited = once(child, 'exit')
  try {
    const [signal] = await once(child.stdout, 'data')
    assert.equal(signal.toString(), 'locked')
    assert.throws(() => writePersonaSources(root, { main: 'beta', subagent: null }, saved.revision), error => error.status === 409)
    assert.throws(() => setModuleEnabled(root, 'beta', true), error => error.status === 409)
    assert.deepEqual(readFileSync(file), bytes)
  } finally { child.stdin.end('x'); assert.equal((await exited)[0], 0) }
  const childRead = spawnSync(process.execPath, ['--input-type=module', '--eval', `
    import { readPersonaSources } from ${JSON.stringify(new URL('../../src/host/persona-selection.ts', import.meta.url).href)};
    process.stdout.write(JSON.stringify(readPersonaSources(process.argv[1]).sources));
  `, root], { cwd: process.cwd(), encoding: 'utf8' })
  assert.equal(childRead.status, 0, childRead.stderr)
  assert.deepEqual(JSON.parse(childRead.stdout), saved.sources)
  const write = fs.writeFileSync
  let modified = false
  mock.method(fs, 'writeFileSync', (target, ...args) => {
    const result = write(target, ...args)
    if (!modified && String(target).includes('.config.yml.tmp-')) { modified = true; write(file, bytes.toString() + 'external: PRESERVE\n') }
    return result
  })
  syncBuiltinESMExports()
  try { assert.throws(() => writePersonaSources(root, { main: 'beta', subagent: null }, saved.revision), error => error.status === 409) }
  finally { mock.restoreAll(); syncBuiltinESMExports() }
  assert.equal(modified, true)
  assert.equal(parse(readFileSync(file, 'utf8')).external, 'PRESERVE')
  assert.deepEqual(readPersonaSources(root).sources, saved.sources)
})
