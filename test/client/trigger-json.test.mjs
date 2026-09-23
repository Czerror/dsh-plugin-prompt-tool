import test from 'node:test'
import assert from 'node:assert/strict'
import { withSsr, renderElement, makeTranslate } from './support/ssr-render.mjs'
const { editTriggerJson, triggerJsonText, TriggerJsonField } = await withSsr([new URL('../../src/client/features/triggers/TriggerJsonField.tsx', import.meta.url).href])

test('JSON 字段合法提交保留字段，非法输入与外部更新互不覆盖', () => {
  const fields = new Map()
  let value = { when: { all: [{ names: { allow: ['bash'] } }] }, extra: { preserve: true } }
  const change = (next) => { value = next }
  const text = JSON.stringify({ ...value, id: 'changed' })
  editTriggerJson(fields, 'x', value, text, 'object', 'invalid', change)
  assert.equal(value.id, 'changed')
  assert.equal(value.extra.preserve, true)
  assert.equal(triggerJsonText(fields, 'x', value).text, text)
  editTriggerJson(fields, 'x', value, '{', 'object', 'invalid', change)
  assert.equal(value.id, 'changed')
  assert.equal(triggerJsonText(fields, 'x', { id: 'remote' }).text, '{')
  assert.equal(fields.get('x').error, 'invalid')
  editTriggerJson(fields, 'x', value, '[]', 'object', 'invalid', change)
  assert.equal(fields.get('x').error, 'invalid')
  editTriggerJson(fields, 'x', value, '{"id":"valid"}', 'object', 'invalid', change)
  assert.deepEqual(JSON.parse(triggerJsonText(fields, 'x', { id: 'remote' }).text), { id: 'remote' })
})

test('JSON 数组接受多动作；错误关联与只读通过真实表单渲染', () => {
  const fields = new Map()
  let value = []
  editTriggerJson(fields, 'actions', value, '[{"kind":"request-params"},{"kind":"guard"}]', 'array', 'invalid', (next) => { value = next })
  assert.equal(value.length, 2)
  editTriggerJson(fields, 'actions', value, '{}', 'array', 'invalid', () => assert.fail('形状错误不得提交'))
  const html = renderElement(TriggerJsonField, { t: makeTranslate(), label: 'Actions', value, fields, fieldKey: 'actions', shape: 'array', disabled: true, onChange() {}, onDraft() {} })
  assert.match(html, /aria-invalid="true"/)
  assert.match(html, /aria-describedby=/)
  assert.match(html, /readonly=""/)
  assert.match(html, /role="alert"/)
})
