import test from 'node:test'
import assert from 'node:assert/strict'
import { canEditSubject, moduleDeclares, subjectDraftKey } from '../../src/client/data/module-subject.ts'

/** 判据只读「模块总闸 + 当前模块事实」两项；moduleFacts 缺席＝没有主语（无模块事实）。 */
const gate = (overrides = {}) => ({ modulesEnabled: true, ...overrides })

test('canEditSubject：moduleFacts 缺席（无主语）时不可编辑', () => {
  assert.equal(canEditSubject(gate()), false)
})

test('canEditSubject：moduleFacts.editable 为假时不可编辑', () => {
  assert.equal(canEditSubject(gate({ moduleFacts: { editable: false } })), false)
})

test('canEditSubject：模块总闸关闭时不可编辑', () => {
  assert.equal(canEditSubject({ modulesEnabled: false, moduleFacts: { editable: true } }), false)
})

test('canEditSubject：总闸打开且当前模块可编辑时为真', () => {
  assert.equal(canEditSubject(gate({ moduleFacts: { editable: true } })), true)
})

test('subjectDraftKey：无主语不产生草稿键（不得退化成 undefined:scope）', () => {
  assert.equal(subjectDraftKey(undefined, 'module'), undefined)
  assert.equal(subjectDraftKey(undefined, 'subagent'), undefined)
})

test('subjectDraftKey：有主语时与今日同形', () => {
  assert.equal(subjectDraftKey('mod-a', 'module'), 'mod-a:module')
  assert.equal(subjectDraftKey('mod-a', 'subagent'), 'mod-a:subagent')
})

/** 声明面判据来自 `/meta` 下发的 `declares`（顶层键名数组），不是客户端另立的名录。 */
const declared = (declares) => [{ id: 'mod-a', name: 'A', declares }]

test('moduleDeclares：显式下发时按声明面回答（多节 = 任一存在）', () => {
  const modules = declared(['rules', 'customTools'])
  assert.equal(moduleDeclares(modules, 'mod-a', 'rules'), true)
  assert.equal(moduleDeclares(modules, 'mod-a', 'customTools'), true)
  assert.equal(moduleDeclares(modules, 'mod-a', 'persona'), false)
  assert.equal(moduleDeclares(modules, 'mod-a', 'params', 'layerSettings'), false, '两节都不存在＝未声明')
  assert.equal(moduleDeclares(modules, 'mod-a', 'params', 'rules'), true, '任一存在即已声明')
  assert.equal(moduleDeclares(declared([]), 'mod-a', 'customTools'), false, '空数组＝什么都没声明')
})

test('moduleDeclares：声明面未下发（含模块不在快照里）＝未知，不当作「没声明」', () => {
  assert.equal(moduleDeclares([{ id: 'mod-a', name: 'A' }], 'mod-a', 'customTools'), undefined)
  assert.equal(moduleDeclares(undefined, 'mod-a', 'customTools'), undefined)
  assert.equal(moduleDeclares(declared(['rules']), 'mod-b', 'customTools'), undefined, '快照里没有该模块＝未知')
})
