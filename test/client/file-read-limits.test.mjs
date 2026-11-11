import test from 'node:test'
import assert from 'node:assert/strict'
import { withSsr, renderElement, makeTranslate } from './support/ssr-render.mjs'
import { compileRules } from '../../engine/rule-spec.mjs'
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
  let saved = { ...rule, then: [{ ...rule.then[0], value: { limit: 20000 } }] }, revision = 'R1'
  const fields = new Map(), calls = []
  const draft = getRulesDraft(createWorkspaceDrafts(), 'read-module')
  const editor = createRuleEditor('read-module', draft, { request: async body => {
    calls.push(structuredClone(body))
    if (body.edits) {
      assert.deepEqual(body.expectedRevisions, { rules: { read: revision } })
      const candidate = body.edits[0].rule
      try { compileRules([candidate], { moduleId: 'read-module' }) }
      catch (error) { return { ok: false, message: error.message } }
      saved = structuredClone(candidate); revision = 'R2'
    }
    return { ok: true, value: { rules: [structuredClone(saved)], revisions: { rules: { read: revision }, settings: 'S1', variables: 'V1' },
      meta: { actions: [], predicates: [], composites: [], waterfallPositions: ['default'] } } }
  }, enqueue: async (_id, task) => task(), isCurrent: () => true, changed() {} })
  await editor.load(); draft.fields = fields
  let value = draft.entries[0].value.then[0].value
  const parameters = () => ({ t, fields, fieldKey: 'read:limits', value: { ...rule.then[0], value }, example: rule.then[0],
    onChange: next => {
      value = next.value
      const entry = draft.entries[0]
      editor.patch(entry.key, { ...entry.value, then: [next] })
    }, onDraft() {} })
  const input = key => findInput(RuleParameterFields(parameters()), key)
  for (const key of ['readMaxLineLength', 'readMaxBytes', 'readLimit']) {
    assert.ok(renderElement(RuleParameterFields, parameters()).includes(t('triggers.hint.' + key)), '原字段说明保留继承与单位语义')
  }
  for (const key of ['maxLineLength', 'maxBytes']) {
    assert.equal(input(key).props.value, '', '稀疏读取配置的未声明字段显示继承空值')
    assert.match(renderElement(input(key).type, input(key).props), /value=""/)
    input(key).props.onChange({ target: { value: String(initial[key]) } })
  }
  for (const key of Object.keys(initial)) {
    for (const text of ['0', '-1', '1.5', '-', '1e', '9007199254740992']) {
      input(key).props.onChange({ target: { value: text } })
      assert.equal(fields.get('read:limits:value:' + key).text, text)
      assert.ok(fields.get('read:limits:value:' + key).error, key + ': ' + text)
      assert.equal(input(key).props.value, text, '非法原文继续可见，不替换成实值或示例')
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
  assert.equal(input('maxBytes').props.value, '', '清空后重渲染不回显示例值')
  assert.equal(value.maxLineLength, 10000)
  assert.equal(await editor.submit(), true)
  assert.deepEqual(calls[1].expectedRevisions, { rules: { read: 'R1' } })
  assert.deepEqual(calls[1].edits[0].rule.then[0].value, { maxLineLength: 10000, limit: 3 })
  assert.equal(await editor.load(true), true)
  value = draft.entries[0].value.then[0].value
  assert.equal(input('maxBytes').props.value, '', '保存并重读仍显示继承空值')
  assert.match(renderElement(input('maxBytes').type, input('maxBytes').props), /value=""/)
  for (const key of ['maxLineLength', 'limit']) input(key).props.onChange({ target: { value: '' } })
  assert.deepEqual(value, {})
  for (const key of Object.keys(initial)) assert.equal(input(key).props.value, '', '全空失败草稿不回填示例值')
  assert.equal(await editor.submit(), false, '至少一项限额由真实规则编译器拒绝')
  assert.deepEqual(draft.entries[0].value.then[0].value, {}, '拒绝后保留全空草稿')
  assert.deepEqual(saved.then[0].value, { maxLineLength: 10000, limit: 3 }, '拒绝后保留最后有效保存值')
  for (const key of Object.keys(initial)) assert.equal(input(key).props.value, '')
})

test('同名value对象保留示例显示且不获得读取能力的数字约束', () => {
  const example = { value: { limit: 2, maxBytes: 4, maxLineLength: 5 } }
  let value = { kind: 'another-action', value: {} }
  const fields = new Map()
  for (const key of ['limit', 'maxBytes', 'maxLineLength']) {
    const input = findInput(RuleParameterFields({ t, fields, fieldKey: 'other', value, example, onChange: next => { value = next }, onDraft() {} }), key)
    assert.equal(input.props.value, String(example.value[key]), '只有读取额度改用实际声明值')
    input.props.onChange({ target: { value: '0' } })
    assert.equal(value.value[key], 0)
    assert.equal(fields.get('other:value:' + key).error, '')
  }
})

test('请求patch数字继续支持未声明空值、合法编辑与清空删键', () => {
  let value = { kind: 'request-params', patch: {} }
  const fields = new Map(), example = { patch: { temperature: undefined, maxTokens: undefined } }
  const input = key => findInput(RuleParameterFields({ t, fields, fieldKey: 'request', value, example, requestPatch: true,
    onChange: next => { value = next }, onDraft() {} }), key)
  for (const [key, text] of [['temperature', '0.5'], ['maxTokens', '42']]) {
    assert.equal(input(key).props.value, '')
    input(key).props.onChange({ target: { value: text } })
    assert.equal(input(key).props.value, text)
    assert.equal(value.patch[key], Number(text))
    input(key).props.onChange({ target: { value: '' } })
    assert.equal(Object.hasOwn(value.patch, key), false)
    assert.equal(input(key).props.value, '')
  }
})
