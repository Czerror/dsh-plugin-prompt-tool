import test from 'node:test'
import assert from 'node:assert/strict'
import { isValidElement } from 'react'
import { getTriggerEditorMeta } from '../../engine/trigger-editor-meta.mjs'
import { compileDeclarations } from '../../engine/trigger-spec.mjs'
import { withSsr, renderElement, makeTranslate } from './support/ssr-render.mjs'
const { TriggerRuleFields, TriggerParameterFields, replaceTriggerAction, TriggerJsonField } = await withSsr([
  new URL('../../src/client/features/triggers/TriggerRuleFields.tsx', import.meta.url).href,
  new URL('../../src/client/features/triggers/TriggerJsonField.tsx', import.meta.url).href,
])
const meta = getTriggerEditorMeta(), t = makeTranslate()
const propsOf = (rule) => ({ rule, meta, t, fields: new Map(), fieldKey: 'rule:0', onChange() {}, onDraft() {} })
function find(node, check) {
  if (Array.isArray(node)) { for (const item of node) { const found = find(item, check); if (found) return found } }
  if (!isValidElement(node)) return
  if (check(node)) return node
  return find(node.props.children, check)
}

test('七类原语、四个组合及九类动作均由实际目录回显，动作例子可编译', () => {
  for (const entry of meta.predicates) {
    const rule = replaceTriggerAction({ id: 'test', when: entry.example }, meta.actions.find(({ kind }) => kind === 'request-params'))
    const html = renderElement(TriggerRuleFields, propsOf(rule))
    assert.ok(html.includes(entry.kind), entry.kind)
    compileDeclarations([rule])
  }
  for (const action of meta.actions) {
    const rule = replaceTriggerAction({ id: 'test' }, action)
    const html = renderElement(TriggerRuleFields, propsOf(rule))
    assert.ok(html.includes(action.kind), action.kind)
    assert.ok(html.includes(action.channel), action.channel)
    compileDeclarations([rule])
  }
})

test('复杂条件和多动作往返保留未知字段；不支持 when 明确提示且不静默删除', () => {
  const condition = { all: [{ names: { allow: ['bash'] } }, { not: { phase: { promoted: true } } }] }
  const actions = [{ kind: 'request-params', patch: { future: { nested: 1 } } }, { kind: 'request-params', patch: { maxTokens: 50 } }]
  let changed
  const rule = { id: 'complex', channel: 'agent/request', when: condition, do: actions, future: 'keep' }
  const props = { ...propsOf(rule), onChange: (value) => { changed = value } }
  const tree = TriggerRuleFields(props)
  const json = find(tree, (node) => node.type === TriggerJsonField && node.props.label === t('triggers.multiActions'))
  assert.deepEqual(json.props.value, actions)
  json.props.onChange([...actions, actions[1]])
  assert.deepEqual(changed.when, condition)
  assert.equal(changed.do.length, 3)
  assert.equal(changed.future, 'keep')
  for (const kind of ['inject-text', 'guard']) {
    const next = replaceTriggerAction(rule, meta.actions.find((entry) => entry.kind === kind))
    assert.deepEqual(next.when, condition)
    const html = renderElement(TriggerRuleFields, propsOf(next))
    assert.ok(html.includes(t('triggers.unsupportedWhen')))
    assert.match(html, /aria-label="条件类型"[^>]*disabled=""|disabled=""[^>]*aria-label="条件类型"/)
  }
})

test('结构化参数编辑保留未显示数据，非法数字草稿不写入值', () => {
  const fields = new Map()
  let value = { maxTokens: 20, extra: { nested: true } }
  const props = { t, value, example: {}, fields, fieldKey: 'rule:0:do', onChange: (next) => { value = next }, onDraft() {} }
  const tree = TriggerParameterFields(props)
  const input = find(tree, (node) => node.type === 'input' && node.props.inputMode === 'decimal')
  input.props.onChange({ target: { value: '4x' } })
  assert.equal(value.maxTokens, 20)
  assert.equal(fields.get('rule:0:do:maxTokens').text, '4x')
  input.props.onChange({ target: { value: '40' } })
  assert.equal(value.maxTokens, 40)
  assert.deepEqual(value.extra, { nested: true })
  assert.equal(fields.get('rule:0:do:maxTokens').error, '')
})
