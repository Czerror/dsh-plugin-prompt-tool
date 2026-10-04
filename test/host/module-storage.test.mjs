import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import fs, { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { parse } from 'yaml'
import { isolatedHome } from '../fixtures/host-harness.mjs'

const { moduleRoot } = isolatedHome('pt-module-storage-')
const { loadModuleDefinition, ensureModuleSlices, readRulesDir, commitModuleDefinition } = await import('../../src/host/module-storage.ts')
const { readModuleRules, editModuleRules } = await import('../../src/host/module-rules.ts')
const rule = (id, text = id, state = {}) => ({ id, ...state, then: [{ id: 'inject', kind: 'inject-text', config: { text } }] })
function fixture(id, source = {}) {
  const dir = join(moduleRoot, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'module.yml'), '# owner note\n' + JSON.stringify({ id, modules: [], rules: [rule('first'), rule('second')], variables: { owner: 'Mia' }, ...source }))
  return dir
}
const bytes = dir => Object.fromEntries(readdirSync(join(dir, 'rules')).map(file => [file, readFileSync(join(dir, 'rules', file), 'utf8')]))

test('运行切片按完整定义确定性恢复；纯读、合法源修改与保留文件身份有明确边界', () => {
  const dir = fixture('projection', { rules: [rule('first', 'FIRST', { enabled: false }), rule('second', 'SECOND')], configOrder: { first: 30 } })
  const definition = readFileSync(join(dir, 'module.yml'), 'utf8')
  assert.throws(() => readRulesDir(dir))
  assert.equal(existsSync(join(dir, 'rules')), false, '纯读取不物化')
  const first = ensureModuleSlices(dir)
  assert.deepEqual(first.configOrder, { first: 30, second: 40 }, '缺省编号在末尾，不插入已保存顺序前')
  const initial = bytes(dir)
  assert.deepEqual(Object.keys(initial).sort(), ['_settings.yml', 'first.yml', 'second.yml', 'variables.yml'])
  assert.equal(Object.hasOwn(parse(initial['first.yml']), 'enabled'), false)
  assert.equal(parse(initial['_settings.yml']).rules.first.enabled, false)
  const settingsTime = statSync(join(dir, 'rules', '_settings.yml')).mtimeMs
  const writes = []
  for (const name of ['writeFileSync', 'mkdirSync', 'rmSync', 'rmdirSync', 'renameSync']) mock.method(fs, name, (...args) => { writes.push(name); throw new Error('只读路径不应写盘：' + args[0]) })
  syncBuiltinESMExports()
  try { ensureModuleSlices(dir) } finally { mock.restoreAll(); syncBuiltinESMExports() }
  assert.deepEqual(writes, [], '正确定义和切片读取不创建锁文件或写任何目录')
  assert.equal(statSync(join(dir, 'rules', '_settings.yml')).mtimeMs, settingsTime, '正确切片不重写')
  for (const file of ['first.yml', 'variables.yml', '_settings.yml']) {
    writeFileSync(join(dir, 'rules', file), 'forged: true\n')
    assert.throws(() => readRulesDir(dir))
    ensureModuleSlices(dir)
    assert.deepEqual(bytes(dir), initial)
  }
  rmSync(join(dir, 'rules', '_settings.yml'))
  assert.equal(ensureModuleSlices(dir).rules.find(item => item.id === 'first').enabled, false, '缺失状态不复活禁用规则')
  writeFileSync(join(dir, 'rules', 'extra.yml'), JSON.stringify(rule('extra')))
  assert.throws(() => readRulesDir(dir), /集合失配/)
  ensureModuleSlices(dir)
  assert.deepEqual(bytes(dir), initial, '孤儿切片不反向接纳')
  for (const file of ['notes.md', 'not-a-rule.yml', '.first.yml.tmp-not-a-uuid']) {
    writeFileSync(join(dir, 'rules', file), 'USER OWNED MATERIAL')
    const before = bytes(dir)
    assert.throws(() => ensureModuleSlices(dir), /未知文件/)
    assert.deepEqual(bytes(dir), before, '未知素材不删除，也不部分改写切片')
    rmSync(join(dir, 'rules', file))
  }
  assert.equal(readFileSync(join(dir, 'module.yml'), 'utf8'), definition)
  const changed = parse(definition)
  changed.rules[0].then[0].config.text = 'LEGAL SOURCE'
  changed.unknown = { keep: true }
  writeFileSync(join(dir, 'module.yml'), JSON.stringify(changed))
  assert.equal(ensureModuleSlices(dir).rules[0].then[0].config.text, 'LEGAL SOURCE')
  const validSlices = bytes(dir)
  changed.rules[0].then[0].kind = 'not-an-action'
  writeFileSync(join(dir, 'module.yml'), JSON.stringify(changed))
  assert.throws(() => ensureModuleSlices(dir), /not-an-action/)
  assert.deepEqual(bytes(dir), validSlices, '源语义无效不覆盖任何切片')
  changed.rules[0].then[0].kind = 'inject-text'
  changed.layerSettings = { 'unknown-injection-point': { maxDepth: 1 } }
  writeFileSync(join(dir, 'module.yml'), JSON.stringify(changed))
  assert.throws(() => ensureModuleSlices(dir), /module-layer-settings-invalid/)
  assert.deepEqual(bytes(dir), validSlices, '共享参数结构无效也不能先写切片')
  for (const [index, ids] of [['_private'], ['variables'], ['VARIABLES'], ['CON'], ['lpt1'], ['same', 'SAME']].entries()) {
    const invalid = fixture('reserved-' + index, { rules: ids.map(id => rule(id)) })
    assert.throws(() => ensureModuleSlices(invalid), /保留|冲突/)
    assert.equal(existsSync(join(invalid, 'rules')), false)
  }
})

test('正文版本互不连坐；状态和变量独立，旧正文草稿不能回滚新状态', () => {
  const dir = fixture('revisions')
  const original = readModuleRules(dir)
  const firstFile = join(dir, 'rules', 'first.yml')
  const secondFile = join(dir, 'rules', 'second.yml')
  const secondBytes = readFileSync(secondFile, 'utf8')
  const source = loadModuleDefinition(dir)
  source.doc.set('unknown', { newUserValue: true })
  commitModuleDefinition(source, source.doc)
  const update = editModuleRules(dir, { expectedRevisions: { rules: { first: original.revisions.rules.first } }, edits: [{ previousId: 'first', rule: rule('first', 'BODY A') }] })
  assert.equal(update.revisions.rules.second, original.revisions.rules.second)
  assert.equal(readFileSync(secondFile, 'utf8'), secondBytes)
  editModuleRules(dir, { expectedRevisions: { rules: { second: original.revisions.rules.second } }, edits: [{ previousId: 'second', rule: rule('second', 'BODY B') }] })
  assert.deepEqual(parse(readFileSync(join(dir, 'module.yml'), 'utf8')).unknown, { newUserValue: true })
  assert.throws(() => editModuleRules(dir, { expectedRevisions: { rules: { first: original.revisions.rules.first } }, edits: [{ previousId: 'first', rule: rule('first', 'STALE') }] }), error => error.status === 409)
  const beforeState = readModuleRules(dir)
  const state = loadModuleDefinition(dir)
  state.doc.setIn(['rules', 0, 'enabled'], false)
  commitModuleDefinition(state, state.doc)
  const afterBody = editModuleRules(dir, { expectedRevisions: { rules: { first: beforeState.revisions.rules.first } }, edits: [{ previousId: 'first', rule: rule('first', 'BODY AFTER STATE', { enabled: true }) }] })
  assert.equal(afterBody.rules.find(item => item.id === 'first').enabled, false, '正文补丁保留最新状态')
  assert.throws(() => editModuleRules(dir, { expectedRevisions: beforeState.revisions, activateRuleId: 'first' }), error => error.status === 409)
  const variableFile = join(dir, 'rules', 'variables.yml')
  const variableTime = statSync(variableFile).mtimeMs
  const bodyBefore = readFileSync(firstFile, 'utf8')
  const toggle = loadModuleDefinition(dir)
  toggle.doc.set('variablesEnabled', false)
  const toggled = commitModuleDefinition(toggle, toggle.doc)
  assert.equal(toggled.revisions.variables, afterBody.revisions.variables)
  assert.equal(statSync(variableFile).mtimeMs, variableTime)
  assert.equal(readFileSync(firstFile, 'utf8'), bodyBefore)
  const add = readModuleRules(dir)
  assert.throws(() => editModuleRules(dir, { expectedRevisions: { rules: {} }, edits: [{ previousId: null, rule: rule('new') }] }), error => error.status === 409)
  editModuleRules(dir, { expectedRevisions: { settings: add.revisions.settings }, edits: [{ previousId: null, rule: rule('new') }] })
  assert.equal(readRulesDir(dir).settings.new.order, 20)
  const remove = readModuleRules(dir)
  editModuleRules(dir, { expectedRevisions: { settings: remove.revisions.settings, rules: { new: remove.revisions.rules.new } }, edits: [{ previousId: 'new', rule: null }] })
  assert.equal(existsSync(join(dir, 'rules', 'new.yml')), false)
  const fresh = fixture('validate-only')
  const baseline = loadModuleDefinition(fresh)
  editModuleRules(fresh, { expectedRevisions: baseline.revisions, edits: [{ previousId: null, rule: rule('candidate') }], validateOnly: true })
  assert.equal(existsSync(join(fresh, 'rules')), false, 'validateOnly 连初始化切片也不写')
})

test('提交点前后故障恢复旧或新定义；发布前只读者看不到混合快照', () => {
  const rename = fs.renameSync
  for (const [index, failedFile] of ['first.yml', 'variables.yml', 'module.yml', '_settings.yml'].entries()) {
    const dir = fixture('fault-' + index)
    const baseline = ensureModuleSlices(dir)
    const candidate = loadModuleDefinition(dir)
    candidate.doc.setIn(['rules', 0, 'then', 0, 'config', 'text'], 'COMMITTED BODY')
    candidate.doc.setIn(['variables', 'owner'], 'UPDATED VARIABLE')
    let failed = false
    mock.method(fs, 'renameSync', (from, to) => {
      if (!failed && basename(to) === failedFile) {
        failed = true
        assert.equal(ensureModuleSlices(dir).rules[0].then[0].config.text, 'first', '中途读取沿用最后有效快照')
        throw new Error('injected rename failure')
      }
      return rename(from, to)
    })
    syncBuiltinESMExports()
    try {
      if (failedFile === '_settings.yml') assert.equal(commitModuleDefinition(candidate, candidate.doc).rules[0].then[0].config.text, 'COMMITTED BODY', '提交后恢复成功报告保存成功')
      else assert.throws(() => commitModuleDefinition(candidate, candidate.doc), error => { assert.equal(error.persisted, false); assert.ok(error.revisions); return true })
    } finally { mock.restoreAll(); syncBuiltinESMExports() }
    assert.equal(failed, true)
    const after = ensureModuleSlices(dir)
    assert.equal(after.rules[0].then[0].config.text, failedFile === '_settings.yml' ? 'COMMITTED BODY' : 'first')
    assert.equal(after.variables.owner, failedFile === '_settings.yml' ? 'UPDATED VARIABLE' : 'Mia')
    assert.deepEqual(readRulesDir(dir).revisions, after.revisions)
    if (failedFile !== '_settings.yml') assert.equal(after.text, baseline.text)
  }
  const persistentDir = fixture('persistent-publication-failure')
  const persistent = ensureModuleSlices(persistentDir)
  persistent.doc.setIn(['rules', 0, 'then', 0, 'config', 'text'], 'SAVED')
  mock.method(fs, 'renameSync', (from, to) => { if (basename(to) === '_settings.yml') throw new Error('persistent failure'); return rename(from, to) })
  syncBuiltinESMExports()
  try { assert.throws(() => commitModuleDefinition(persistent, persistent.doc), error => error.persisted === true && error.revisions !== undefined) }
  finally { mock.restoreAll(); syncBuiltinESMExports() }
  assert.equal(ensureModuleSlices(persistentDir).rules[0].then[0].config.text, 'SAVED', '持续发布故障结束后从已提交定义恢复')
  const dir = fixture('external-source-change')
  ensureModuleSlices(dir)
  const candidate = loadModuleDefinition(dir)
  candidate.doc.setIn(['rules', 0, 'then', 0, 'config', 'text'], 'STALE CANDIDATE')
  let altered = false
  mock.method(fs, 'renameSync', (from, to) => {
    const result = rename(from, to)
    if (!altered && basename(to) === 'first.yml') {
      altered = true
      const external = parse(candidate.text)
      external.rules[0].then[0].config.text = 'EXTERNAL SOURCE'
      writeFileSync(join(dir, 'module.yml'), JSON.stringify(external))
    }
    return result
  })
  syncBuiltinESMExports()
  try { assert.throws(() => commitModuleDefinition(candidate, candidate.doc), error => error.code === 'rules-conflict' && error.persisted === false) }
  finally { mock.restoreAll(); syncBuiltinESMExports() }
  assert.equal(ensureModuleSlices(dir).rules[0].then[0].config.text, 'EXTERNAL SOURCE', '源 CAS 失败后从最新合法定义恢复')
})

test('不同进程互斥、异常退出死锁恢复与路径归一不发布混合快照', async () => {
  const storage = new URL('../../src/host/module-storage.ts', import.meta.url).href
  const childCode = `
    import fs from 'node:fs';
    import { basename } from 'node:path';
    import { syncBuiltinESMExports } from 'node:module';
    import { loadModuleDefinition, commitModuleDefinition } from ${JSON.stringify(storage)};
    const [dir, crash] = process.argv.slice(1);
    const snapshot = loadModuleDefinition(dir);
    snapshot.doc.setIn(['rules', 0, 'then', 0, 'config', 'text'], 'CHILD COMMIT');
    const rename = fs.renameSync;
    let held = false;
    const hold = () => {
      held = true;
      fs.writeSync(1, 'locked\\n');
      fs.readSync(0, Buffer.alloc(1), 0, 1, null);
      if (crash !== 'finish') process.exit(23);
    };
    fs.renameSync = (from, to) => {
      if (!held && ((crash === 'before-first' && basename(to) === 'first.yml')
        || (crash === 'before-module' && basename(to) === 'module.yml')
        || (crash === 'before-settings' && basename(to) === '_settings.yml'))) hold();
      const result = rename(from, to);
      if (!held && ['finish', 'crash'].includes(crash) && basename(to) === 'first.yml') hold();
      return result;
    };
    syncBuiltinESMExports();
    commitModuleDefinition(snapshot, snapshot.doc);
  `;
  for (const mode of ['finish', 'crash', 'before-first', 'before-module', 'before-settings']) {
    const dir = fixture('process-' + mode)
    const baseline = ensureModuleSlices(dir)
    baseline.rules[0].then[0].config.text = 'CALLER MUTATION'
    baseline.source.rules[0].then[0].config.text = 'CALLER MUTATION'
    baseline.doc.setIn(['rules', 0, 'then', 0, 'config', 'text'], 'CALLER MUTATION')
    const child = spawn(process.execPath, ['--input-type=module', '--eval', childCode, dir, mode], { cwd: tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] })
    const exit = once(child, 'exit')
    let stderr = ''
    child.stderr.setEncoding('utf8').on('data', text => { stderr += text })
    try {
      const [signal] = await once(child.stdout, 'data')
      assert.equal(signal.toString(), 'locked\n')
      const alternate = process.platform === 'win32' ? dir.toUpperCase().replaceAll('\\', '/') : dir + '/.'
      assert.equal(ensureModuleSlices(alternate).rules[0].then[0].config.text, 'first', '活动期间只读已发布原文，调用方变异不泄露')
      const contender = spawn(process.execPath, ['--input-type=module', '--eval', `
        import { ensureModuleSlices, loadModuleDefinition, commitModuleDefinition } from ${JSON.stringify(storage)};
        let denied = 0;
        try { ensureModuleSlices(process.argv[1]); } catch (error) { if (error.status === 409) denied++; }
        const candidate = loadModuleDefinition(process.argv[1]);
        candidate.doc.set('unknown', 'CONTENDER');
        try { commitModuleDefinition(candidate, candidate.doc); } catch (error) { if (error.status === 409) denied++; }
        process.exit(denied === 2 ? 0 : 1);
      `, dir], { cwd: tmpdir(), stdio: 'ignore' })
      assert.equal((await once(contender, 'exit'))[0], 0, '无旧快照进程读取与写入都明确拒绝活锁')
      child.stdin.end('x')
      assert.equal((await exit)[0], mode === 'finish' ? 0 : 23, stderr)
    } finally { child.stdin.destroy(); if (child.exitCode === null) { child.kill(); await exit } }
    const restored = ensureModuleSlices(dir)
    assert.equal(restored.rules[0].then[0].config.text, ['finish', 'before-settings'].includes(mode) ? 'CHILD COMMIT' : 'first')
    assert.deepEqual(readRulesDir(dir).revisions, restored.revisions)
    assert.equal(existsSync(join(dirname(dir), '.' + basename(dir) + '.rules-locks')), false, '死PID锁回收，空锁目录原子移除')
    assert.equal(readdirSync(dir).some(file => file.startsWith('.module.yml.tmp-')), false)
    assert.equal(readdirSync(join(dir, 'rules')).some(file => file.includes('.tmp-')), false, 'rename前退出只清理精确插件临时名')
    assert.equal(readdirSync(dir).some(name => name.includes('lock')), false, '锁不进入模块资产目录')
  }
})
