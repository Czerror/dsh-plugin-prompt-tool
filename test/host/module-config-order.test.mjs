import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { isolatedHome } from '../fixtures/host-harness.mjs'

const { moduleRoot } = isolatedHome('pt-config-order-')
const { appendModuleConfigOrder, readModuleConfigOrder, saveModuleConfigOrder } = await import('../../src/host/module-config-order.ts')
const { setModuleEnabled } = await import('../../src/host/config-store.ts')
const { materializeModule } = await import('../../src/host/write-preset.ts')

function fixture(name, cards) {
  const root = join(moduleRoot, name, 'modules')
  for (const [moduleId, configs] of Object.entries(cards)) {
    const dir = join(root, moduleId)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'module.yml'), '# keep comment\n' + JSON.stringify({ id: moduleId, modules: ['prompt-config-engine'], custom: 'keep', promptConfigs: configs }))
  }
  return root
}
const identities = snapshot => snapshot.entries.map(({ moduleId, configId }) => ({ moduleId, configId }))

test('配置排序：新模块尾部追加，跨模块拖拽写回各自定义，重读保序且正文不变', () => {
  const root = fixture('append', { a: [{ id: 'first', text: 'A1' }, { id: 'last', text: 'A2' }], b: [{ id: 'middle', text: 'B' }] })
  assert.deepEqual(appendModuleConfigOrder(root, 'a'), ['a'])
  setModuleEnabled(root, 'a', true)
  appendModuleConfigOrder(root, 'b')
  setModuleEnabled(root, 'b', true)
  const initial = readModuleConfigOrder(root)
  assert.deepEqual(initial.entries.map(x => [x.moduleId, x.configId, x.sequence]), [['a', 'first', 0], ['a', 'last', 10], ['b', 'middle', 20]])
  const reordered = [initial.entries[0], initial.entries[2], initial.entries[1]]
  saveModuleConfigOrder(root, initial.revision, reordered.map(({ moduleId, configId }) => ({ moduleId, configId })))
  assert.deepEqual(identities(readModuleConfigOrder(root)), identities({ entries: reordered }))
  for (const id of ['a', 'b']) materializeModule(id, { moduleDir: root })
  assert.deepEqual(readdirSync(join(root, 'a', 'configs')), ['0000-first.yml', '0020-last.yml'])
  assert.deepEqual(readdirSync(join(root, 'b', 'configs')), ['0010-middle.yml'])
  for (const id of ['b', 'a']) materializeModule(id, { moduleDir: root })
  assert.deepEqual(identities(readModuleConfigOrder(root)), identities({ entries: reordered }), '重建不会按模块数组重新编号')
  for (const [id, texts] of [['a', ['A1', 'A2']], ['b', ['B']]]) {
    const raw = readFileSync(join(root, id, 'module.yml'), 'utf8')
    assert.match(raw, /# keep comment/)
    const spec = parse(raw)
    assert.equal(spec.custom, 'keep')
    assert.deepEqual(spec.promptConfigs.map(card => card.text), texts)
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
})

test('配置排序：重复启用幂等；新增卡追加，停用模块重排后重建与再次启用保序', () => {
  const root = fixture('idempotent', { a: [{ id: 'a', text: 'A' }], b: [{ id: 'b', text: 'B' }] })
  for (const id of ['a', 'b']) { appendModuleConfigOrder(root, id); setModuleEnabled(root, id, true) }
  const before = readFileSync(join(root, 'a', 'module.yml'), 'utf8')
  assert.deepEqual(appendModuleConfigOrder(root, 'a'), [])
  assert.equal(readFileSync(join(root, 'a', 'module.yml'), 'utf8'), before)
  const spec = parse(before)
  spec.promptConfigs.push({ id: 'new', text: 'NEW' })
  writeFileSync(join(root, 'a', 'module.yml'), JSON.stringify(spec))
  appendModuleConfigOrder(root, 'a')
  const ordered = readModuleConfigOrder(root)
  assert.deepEqual(ordered.entries.map(x => [x.configId, x.sequence]), [['a', 0], ['b', 10], ['new', 20]])
  setModuleEnabled(root, 'a', false)
  const other = readFileSync(join(root, 'b', 'module.yml'), 'utf8')
  const disabled = readModuleConfigOrder(root, 'a')
  assert.deepEqual(disabled.entries.map(x => [x.moduleId, x.configId, x.sequence]), [['a', 'a', 0], ['a', 'new', 20]])
  saveModuleConfigOrder(root, disabled.revision, identities(disabled).reverse(), 'a')
  materializeModule('a', { moduleDir: root })
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
  materializeModule('fresh', { moduleDir: freshRoot })
  assert.deepEqual(readModuleConfigOrder(freshRoot, 'fresh').entries.map(x => [x.configId, x.sequence]), [['y', 0], ['x', 10]], '未启用且未分配序号的模块同样可排序')
})
