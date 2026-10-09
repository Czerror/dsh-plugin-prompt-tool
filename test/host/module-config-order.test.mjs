import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import fs, { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { basename, dirname, join } from 'node:path'
import { parse } from 'yaml'
import { isolatedHome } from '../fixtures/host-harness.mjs'
import { moduleOrderConfigs, moveToView, sameConfigPosition } from '../../src/client/data/prompt-config-order.ts'
import { configIdentityKey } from '../../src/shared/module-config-order.ts'

const { moduleRoot } = isolatedHome('pt-config-order-')
const { appendModuleConfigOrder, readModuleConfigOrder, saveModuleConfigOrder } = await import('../../src/host/module-config-order.ts')
const { setModuleEnabled } = await import('../../src/host/config-store.ts')
const { ensureModuleReady } = await import('../../src/host/write-module.ts')
const { promptConfigToRule } = await import('../../src/host/rule-builder.ts')

function fixture(name, cards) {
  const root = join(moduleRoot, name, 'modules')
  for (const [moduleId, configs] of Object.entries(cards)) {
    const dir = join(root, moduleId)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'module.yml'), '# keep comment\n' + JSON.stringify({ id: moduleId, modules: ['rule-engine'], custom: 'keep', rules: configs.map(promptConfigToRule) }))
  }
  return root
}
const identities = snapshot => snapshot.entries.map(({ moduleId, configId }) => ({ moduleId, configId }))

test('配置排序：跨模块同名卡保留受众与策略，身份排序写回各自定义且正文不变', () => {
  const root = fixture('append', {
    a: [{ id: 'same', text: 'A1', audience: 'main' }, { id: 'last', text: 'A2', audience: 'subagent', strategy: 'world-book' }],
    b: [{ id: 'same', text: 'B1' }, { id: 'shared', text: 'B2', audience: null }],
  })
  assert.deepEqual(appendModuleConfigOrder(root, 'a'), ['a'])
  setModuleEnabled(root, 'a', true)
  appendModuleConfigOrder(root, 'b')
  setModuleEnabled(root, 'b', true)
  const initial = readModuleConfigOrder(root)
  assert.deepEqual(initial.entries.map(x => [x.moduleId, x.configId, x.sequence, x.audience, x.strategy]), [
    ['a', 'same', 0, 'main', 'static'], ['a', 'last', 10, 'subagent', 'world-book'],
    ['b', 'same', 20, undefined, 'static'], ['b', 'shared', 30, undefined, 'static'],
  ])
  assert.ok(initial.entries.every(entry => !('text' in entry) && !('templateFile' in entry)))
  const drafts = moduleOrderConfigs(initial.entries)
  const mainIds = drafts.filter(card => card.audience !== 'subagent').map(card => card.id)
  const entryByKey = new Map(initial.entries.map(entry => [configIdentityKey(entry), entry]))
  const movedMain = moveToView(drafts, '["b","same"]', '["a","same"]', true, undefined, ['pre-step'], undefined, mainIds)
  const mainOrder = movedMain.map(card => entryByKey.get(card.id))
  saveModuleConfigOrder(root, initial.revision, identities({ entries: mainOrder }))
  const afterMain = readModuleConfigOrder(root)
  assert.deepEqual(afterMain.entries.map(entry => [entry.moduleId, entry.configId]), [['b', 'same'], ['a', 'last'], ['a', 'same'], ['b', 'shared']], '主会话移动保留不可见子代理卡的槽位')
  const subDrafts = moduleOrderConfigs(afterMain.entries)
  const subIds = subDrafts.filter(card => card.audience !== 'main').map(card => card.id)
  const worldBookIds = subDrafts.filter(card => card.audience !== 'main' && card.strategy === 'world-book').map(card => card.id)
  assert.equal(moveToView(subDrafts, '["a","last"]', '["b","shared"]', false, undefined, ['pre-step'], 'world-book', worldBookIds), subDrafts)
  assert.equal(sameConfigPosition(subDrafts[0], { ...subDrafts[1], position: 'before-user' }), false)
  const movedSub = moveToView(subDrafts, '["a","last"]', '["b","shared"]', false, undefined, ['pre-step'], undefined, subIds)
  const reordered = movedSub.map(card => entryByKey.get(card.id))
  saveModuleConfigOrder(root, afterMain.revision, identities({ entries: reordered }))
  assert.deepEqual(readModuleConfigOrder(root).entries.map(entry => [entry.moduleId, entry.configId]), [['b', 'same'], ['b', 'shared'], ['a', 'same'], ['a', 'last']], '子代理移动保留不可见主会话卡的槽位')
  for (const id of ['a', 'b']) ensureModuleReady(id, { modulesRoot: root })
  for (const id of ['b', 'a']) ensureModuleReady(id, { modulesRoot: root })
  assert.deepEqual(identities(readModuleConfigOrder(root)), identities({ entries: reordered }), '重建不会按模块数组重新编号')
  for (const [id, texts] of [['a', ['A1', 'A2']], ['b', ['B1', 'B2']]]) {
    const raw = readFileSync(join(root, id, 'module.yml'), 'utf8')
    assert.match(raw, /# keep comment/)
    const spec = parse(raw)
    assert.equal(spec.custom, 'keep')
    assert.deepEqual(spec.rules.map(card => card.then[0].config.text), texts)
  }
})

test('配置排序：过期版本、未知卡、重复卡拒绝且所有模块字节不变', () => {
  const root = fixture('reject', { a: [{ id: 'a', text: 'A' }], b: [{ id: 'b', text: 'B' }] })
  for (const id of ['a', 'b']) { appendModuleConfigOrder(root, id); setModuleEnabled(root, id, true) }
  const snapshot = readModuleConfigOrder(root)
  const before = ['a', 'b'].map(id => readFileSync(join(root, id, 'module.yml'), 'utf8'))
  assert.throws(() => saveModuleConfigOrder(root, 'stale', identities(snapshot)), /版本|变化/)
  assert.throws(() => saveModuleConfigOrder(root, snapshot.revision, [{ moduleId: 'a', configId: 'missing' }, identities(snapshot)[1]]), /配置卡|集合/)
  assert.throws(() => saveModuleConfigOrder(root, snapshot.revision, [identities(snapshot)[0], identities(snapshot)[0]]), /重复|集合/)
  assert.deepEqual(['a', 'b'].map(id => readFileSync(join(root, id, 'module.yml'), 'utf8')), before)
  const rename = fs.renameSync
  for (const external of [false, true]) {
    let failures = 0
    mock.method(fs, 'renameSync', (from, to) => {
      if (basename(to) === '_settings.yml' && basename(dirname(dirname(to))) === 'b' && failures < 2) {
        failures++
        if (external && failures === 2) {
          const file = join(root, 'a', 'module.yml')
          const source = parse(readFileSync(file, 'utf8'))
          source.custom = 'EXTERNAL DURING FAILURE'
          writeFileSync(file, JSON.stringify(source))
        }
        throw new Error('publication failure after module b commit')
      }
      return rename(from, to)
    })
    syncBuiltinESMExports()
    try { assert.throws(() => saveModuleConfigOrder(root, snapshot.revision, identities(snapshot).reverse())) }
    finally { mock.restoreAll(); syncBuiltinESMExports() }
    assert.equal(readFileSync(join(root, 'b', 'module.yml'), 'utf8'), before[1], 'persisted失败模块也回滚')
    if (external) assert.equal(parse(readFileSync(join(root, 'a', 'module.yml'), 'utf8')).custom, 'EXTERNAL DURING FAILURE', '外部新改动不被盲回滚覆盖')
    else {
      assert.equal(readFileSync(join(root, 'a', 'module.yml'), 'utf8'), before[0], '先成功模块恢复原定义')
    }
  }
})

test('配置排序：重复启用幂等；新增卡追加，停用模块重排后重建与再次启用保序', () => {
  const root = fixture('idempotent', { a: [{ id: 'a', text: 'A' }], b: [{ id: 'b', text: 'B' }] })
  for (const id of ['a', 'b']) { appendModuleConfigOrder(root, id); setModuleEnabled(root, id, true) }
  const before = readFileSync(join(root, 'a', 'module.yml'), 'utf8')
  assert.deepEqual(appendModuleConfigOrder(root, 'a'), [])
  assert.equal(readFileSync(join(root, 'a', 'module.yml'), 'utf8'), before)
  const spec = parse(before)
  spec.rules.push(promptConfigToRule({ id: 'new', text: 'NEW' }))
  writeFileSync(join(root, 'a', 'module.yml'), JSON.stringify(spec))
  appendModuleConfigOrder(root, 'a')
  const ordered = readModuleConfigOrder(root)
  assert.deepEqual(ordered.entries.map(x => [x.configId, x.sequence]), [['a', 0], ['b', 10], ['new', 20]])
  setModuleEnabled(root, 'a', false)
  const other = readFileSync(join(root, 'b', 'module.yml'), 'utf8')
  const disabled = readModuleConfigOrder(root, 'a')
  assert.deepEqual(disabled.entries.map(x => [x.moduleId, x.configId, x.sequence]), [['a', 'a', 0], ['a', 'new', 20]])
  saveModuleConfigOrder(root, disabled.revision, identities(disabled).reverse(), 'a')
  ensureModuleReady('a', { modulesRoot: root })
  assert.deepEqual(readModuleConfigOrder(root, 'a').entries.map(x => [x.configId, x.sequence]), [['new', 0], ['a', 20]])
  assert.equal(readFileSync(join(root, 'b', 'module.yml'), 'utf8'), other, '单模块重排不改其他模块槽位')
  appendModuleConfigOrder(root, 'a')
  setModuleEnabled(root, 'a', true)
  assert.deepEqual(readModuleConfigOrder(root).entries.map(x => [x.configId, x.sequence]), [['new', 0], ['b', 10], ['a', 20]])
  setModuleEnabled(root, 'a', false)
  const activeOnly = readModuleConfigOrder(root)
  saveModuleConfigOrder(root, activeOnly.revision, identities(activeOnly))
  appendModuleConfigOrder(root, 'a')
  setModuleEnabled(root, 'a', true)
  assert.deepEqual(readModuleConfigOrder(root).entries.map(x => [x.configId, x.sequence]), [['b', 0], ['new', 30], ['a', 40]], '部分槽位被占后整体追加仍保留用户排好的相对次序')
  const freshRoot = fixture('disabled-unassigned', { fresh: [{ id: 'x', text: 'X' }, { id: 'y', text: 'Y' }] })
  const fresh = readModuleConfigOrder(freshRoot, 'fresh')
  saveModuleConfigOrder(freshRoot, fresh.revision, identities(fresh).reverse(), 'fresh')
  ensureModuleReady('fresh', { modulesRoot: freshRoot })
  assert.deepEqual(readModuleConfigOrder(freshRoot, 'fresh').entries.map(x => [x.configId, x.sequence]), [['y', 0], ['x', 10]], '未启用且未分配序号的模块同样可排序')
})
