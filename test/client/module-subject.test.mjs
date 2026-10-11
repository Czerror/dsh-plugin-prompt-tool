import test from 'node:test'
import assert from 'node:assert/strict'
import { canEditSubject, subjectDraftKey } from '../../src/client/data/module-subject.ts'

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
