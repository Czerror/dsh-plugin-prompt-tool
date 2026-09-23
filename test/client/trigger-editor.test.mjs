import test from 'node:test'
import assert from 'node:assert/strict'
import { getTriggerEditorMeta } from '../../engine/trigger-editor-meta.mjs'
import { compileDeclarations } from '../../engine/trigger-spec.mjs'
import { getTriggerDraft } from '../../src/client/data/trigger-drafts.ts'
import { createWorkspaceDrafts } from '../../src/client/data/workspace-drafts.ts'
import { withSsr, renderElement, makeTranslate } from './support/ssr-render.mjs'
const { newTriggerRule, removeTriggerRule, TriggerRulesList } = await withSsr([new URL('../../src/client/features/triggers/TriggerRulesEditor.tsx', import.meta.url).href])
const meta = getTriggerEditorMeta()

test('新规则来自引擎同源动作目录，九类声明均可编译；复制保留未知嵌套字段', () => {
  const values = []
  for (const action of meta.actions) {
    const next = newTriggerRule(values, action)
    compileDeclarations([next])
    values.push(next)
  }
  assert.equal(new Set(values.map(({ id }) => id)).size, 9)
  const source = { ...values[0], future: { nested: [1, { untouched: true }] } }
  const copy = newTriggerRule(values, meta.actions[0], source)
  assert.notEqual(copy.id, source.id)
  assert.deepEqual(copy.future, source.future)
  copy.future.nested[1].untouched = false
  assert.equal(source.future.nested[1].untouched, true)
})

test('删除仅移除目标行并移动后续原始字段，不覆盖其他草稿', () => {
  const draft = getTriggerDraft(createWorkspaceDrafts(), 'p')
  draft.value = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  draft.fields.set('rule:0:full', { source: '{}', text: '{', error: 'first' })
  draft.fields.set('rule:2:full', { source: '{}', text: '[', error: 'third' })
  draft.fields.set('rule:1:full', { source: '{}', text: 'bad', error: 'second' })
  assert.deepEqual(removeTriggerRule(draft, 1), [{ id: 'a' }, { id: 'c' }])
  assert.equal(draft.fields.get('rule:0:full').error, 'first')
  assert.equal(draft.fields.get('rule:1:full').error, 'third')
  assert.equal(draft.fields.has('rule:2:full'), false)
})

test('列表呈现真实摘要、校验与只读边界，无效 JSON 阻止提交', () => {
  const draft = getTriggerDraft(createWorkspaceDrafts(), 'p')
  draft.loaded = true
  draft.meta = meta
  draft.value = [newTriggerRule([], meta.actions[0])]
  draft.fields.set('rule:0:full', { source: '{}', text: '{', error: 'invalid' })
  const editor = { patch() {}, load() {}, submit() {}, discard() {} }
  const html = renderElement(TriggerRulesList, { draft, editor, t: makeTranslate(), onDraft() {} })
  assert.match(html, /无条件 → 注入文本/)
  assert.match(html, /当前规则/)
  assert.doesNotMatch(html, /<details/)
  assert.match(html, /请先修正未完成的字段/)
  assert.match(html, /disabled="">保存规则/)
  const readOnly = renderElement(TriggerRulesList, { draft, editor, t: makeTranslate(), onDraft() {}, disabled: true })
  assert.match(readOnly, /disabled="">新建规则/)
  assert.doesNotMatch(html, /role="switch"/)
})
