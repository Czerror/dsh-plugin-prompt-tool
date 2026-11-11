import test from 'node:test'
import assert from 'node:assert/strict'
import { withSsr, makeTranslate } from './support/ssr-render.mjs'
import { createWorkspaceDrafts } from '../../src/client/data/workspace-drafts.ts'
import { createRuleEditor, getRulesDraft } from '../../src/client/data/rule-drafts.ts'

const { RuleParameterFields } = await withSsr([new URL('../../src/client/features/prompts/RuleFields.tsx', import.meta.url).href])
const t = makeTranslate()

function findInput(elements, key) {
  for (const element of Array.isArray(elements) ? elements : [elements]) {
    if (element == null || typeof element !== 'object') continue
    if (element.key === key && typeof element.props?.children?.props?.onChange === 'function') return element.props.children
    const nested = findInput(element.type === RuleParameterFields ? RuleParameterFields(element.props) : element.props?.children, key)
    if (nested) return nested
  }
}

test('真实读取三个额度复用原数字草稿与版本保存，非法原文不发布，空值只撤销该字段', async () => {
  const initial = { maxLineLength: 10000, maxBytes: 1048576, limit: 20000 }
  const rule = { id: 'read', then: [{ id: 'limits', kind: 'host-control', capability: 'file-read-limits', value: initial }] }
  const fields = new Map(), calls = []
  const draft = getRulesDraft(createWorkspaceDrafts(), 'read-module')
  const editor = createRuleEditor('read-module', draft, { request: async body => {
    calls.push(structuredClone(body))
    return { ok: true, value: { rules: [rule], revisions: { rules: { read: 'R1' }, settings: 'S1', variables: 'V1' },
      meta: { actions: [], predicates: [], composites: [], waterfallPositions: ['default'] } } }
  }, enqueue: async (_id, task) => task(), isCurrent: () => true, changed() {} })
  await editor.load(); draft.fields = fields
  const entry = draft.entries[0]
  let value = { ...initial }
  const input = key => findInput(RuleParameterFields({ t, fields, fieldKey: 'read:limits', value: { ...rule.then[0], value }, example: rule.then[0],
    onChange: next => {
      value = next.value
      editor.patch(entry.key, { ...entry.value, then: [next] })
    }, onDraft() {} }), key)
  for (const key of Object.keys(initial)) {
    for (const text of ['0', '-1', '1.5', '-', '1e', '9007199254740992']) {
      input(key).props.onChange({ target: { value: text } })
      assert.equal(fields.get('read:limits:value:' + key).text, text)
      assert.ok(fields.get('read:limits:value:' + key).error, key + ': ' + text)
      assert.equal(value[key], initial[key])
      assert.equal(await editor.submit(), false)
      assert.equal(calls.length, 1, '原hasRuleFields阻止非法草稿发送请求')
    }
    input(key).props.onChange({ target: { value: String(initial[key]) } })
  }
  input('limit').props.onChange({ target: { value: '3' } })
  assert.equal(value.limit, 3)
  assert.equal(fields.get('read:limits:value:limit').error, '')
  input('maxBytes').props.onChange({ target: { value: '' } })
  assert.equal(Object.hasOwn(value, 'maxBytes'), false, '空可选字段删键，不发布为0')
  assert.equal(value.maxLineLength, 10000)
  assert.equal(await editor.submit(), true)
  assert.deepEqual(calls[1].expectedRevisions, { rules: { read: 'R1' } })
  assert.deepEqual(calls[1].edits[0].rule.then[0].value, { maxLineLength: 10000, limit: 3 })
})

test('同名value对象不获得读取能力的数字约束', () => {
  let value = { kind: 'another-action', value: { limit: 2, maxBytes: 4, maxLineLength: 5 } }
  const fields = new Map()
  for (const key of ['limit', 'maxBytes', 'maxLineLength']) {
    const input = findInput(RuleParameterFields({ t, fields, fieldKey: 'other', value, onChange: next => { value = next }, onDraft() {} }), key)
    input.props.onChange({ target: { value: '0' } })
    assert.equal(value.value[key], 0)
    assert.equal(fields.get('other:value:' + key).error, '')
  }
})
