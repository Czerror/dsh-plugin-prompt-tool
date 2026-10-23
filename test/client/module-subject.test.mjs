import test from 'node:test'
import assert from 'node:assert/strict'
import { canEditModule, moduleDeclares, writableModuleTargets } from '../../src/client/data/module-subject.ts'

/** 判据只读「模块总闸 + 该模块自己的事实」两项；走生产同源入口 canEditModule（不直调内部 canEditSubject）。 */
const gate = { modulesEnabled: true }
const facts = (editable) => ({ declaredModules: [], effectiveModules: [], rowIds: [], sourceMode: 'explicit', editable })
const moduleEntry = (id, editable = true, enabled = true) => ({ id, name: id, user: true, renderable: true, enabled, facts: facts(editable) })

test('canEditModule：模块不在装配集合里（没有主语）时不可编辑', () => {
  assert.equal(canEditModule(gate, [moduleEntry('mod-a')], 'mod-missing'), false)
  assert.equal(canEditModule(gate, undefined, 'mod-a'), false)
})

test('canEditModule：该模块事实不可编辑时不可编辑', () => {
  assert.equal(canEditModule(gate, [moduleEntry('mod-a', false)], 'mod-a'), false)
})

test('canEditModule：模块总闸关闭时不可编辑', () => {
  assert.equal(canEditModule({ modulesEnabled: false }, [moduleEntry('mod-a')], 'mod-a'), false)
})

test('canEditModule：总闸打开且该模块可编辑时为真', () => {
  assert.equal(canEditModule(gate, [moduleEntry('mod-a')], 'mod-a'), true)
})

test('canEditModule：判据逐模块——同一次快照里 A 可编辑不影响 B', () => {
  const modules = [moduleEntry('mod-a'), moduleEntry('mod-b', false)]
  assert.equal(canEditModule(gate, modules, 'mod-a'), true)
  assert.equal(canEditModule(gate, modules, 'mod-b'), false)
})

test('writableModuleTargets：可写用户模块不受启用状态与总闸影响', () => {
  const modules = [
    moduleEntry('mod-a'),
    moduleEntry('mod-disabled', true, false),
    moduleEntry('mod-read-only', false, false),
    { ...moduleEntry('mod-builtin'), user: false },
    { ...moduleEntry('mod-unrenderable', true, false), renderable: false },
    { ...moduleEntry('mod-broken', true, false), broken: 'invalid module.yml' },
    moduleEntry('../invalid', true, false),
  ]
  assert.deepEqual(writableModuleTargets(modules).map(({ id }) => id), ['mod-a', 'mod-disabled'], '只列有效、可写的用户目录模块')
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
