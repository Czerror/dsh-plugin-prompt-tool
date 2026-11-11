import test from 'node:test'
import assert from 'node:assert/strict'
import { withSsr, renderElement, makeTranslate } from './support/ssr-render.mjs'
import { compileRules } from '../../engine/rule-spec.mjs'
import { createWorkspaceDrafts } from '../../src/client/data/workspace-drafts.ts'
import { createRuleEditor, getRulesDraft } from '../../src/client/data/rule-drafts.ts'

const { RuleParameterFields } = await withSsr([new URL('../../src/client/features/prompts/RuleFields.tsx', import.meta.url).href])
const t = makeTranslate()

const example = { id: 'limits', kind: 'host-control', capability: 'file-read-limits', value: { maxLineLength: 10000, maxBytes: 1048576, limit: 20000 } }
const render = (value, options = {}) => renderElement(RuleParameterFields, {
  t, fields: new Map(), fieldKey: 'read:limits', example, value, onChange() {}, onDraft() {}, ...options,
})
const inputValues = html => new Map([...html.matchAll(/<input\b[^>]*>/g)].map(([input]) => [
  input.match(/aria-label="([^"]*)"/)?.[1], input.match(/value="([^"]*)"/)?.[1],
]))
const readLabels = ['readMaxLineLength', 'readMaxBytes', 'readLimit']

test('读取额度按实际声明渲染，稀疏与全空配置显示继承空值', () => {
  for (const [value, expected] of [
    [{ maxLineLength: 10000, maxBytes: 1048576, limit: 20000 }, ['10000', '1048576', '20000']],
    [{ limit: 20000 }, ['', '', '20000']],
    [{}, ['', '', '']],
  ]) {
    const action = { ...example, value }, before = structuredClone(action)
    const html = render(action), inputs = inputValues(html)
    assert.deepEqual(readLabels.map(key => inputs.get(t('triggers.label.' + key))), expected)
    assert.deepEqual(action, before, '渲染不将示例数值补入实际声明')
  }
})

test('读取额度经公开规则编辑器提交稀疏值，重读保留空值，拒绝全空候选', async () => {
  let saved = { id: 'read', then: [structuredClone(example)] }, revision = 'R1'
  const calls = []
  const draft = getRulesDraft(createWorkspaceDrafts(), 'read-module')
  const editor = createRuleEditor('read-module', draft, { request: async body => {
    calls.push(structuredClone(body))
    if (body.edits) {
      assert.deepEqual(body.expectedRevisions, { rules: { read: revision } })
      const candidate = body.edits[0].rule
      try { compileRules([candidate], { moduleId: 'read-module' }) }
      catch (error) { return { ok: false, code: 'rules-invalid', message: error.message } }
      saved = structuredClone(candidate); revision = 'R2'
    }
    return { ok: true, value: { rules: [structuredClone(saved)], revisions: { rules: { read: revision }, settings: 'S1', variables: 'V1' },
      meta: { actions: [], predicates: [], composites: [], waterfallPositions: ['default'] } } }
  }, enqueue: async (_id, task) => task(), isCurrent: () => true, changed() {} })
  await editor.load()
  const entry = draft.entries[0]
  editor.patch(entry.key, { ...entry.value, then: [{ ...example, value: { maxLineLength: 10000, limit: 3 } }] })
  assert.equal(inputValues(render(draft.entries[0].value.then[0])).get(t('triggers.label.readMaxBytes')), '')
  assert.equal(await editor.submit(), true)
  assert.deepEqual(calls[1].expectedRevisions, { rules: { read: 'R1' } })
  assert.deepEqual(calls[1].edits[0].rule.then[0].value, { maxLineLength: 10000, limit: 3 })
  assert.equal(await editor.load(true), true)
  assert.equal(inputValues(render(draft.entries[0].value.then[0])).get(t('triggers.label.readMaxBytes')), '', '保存并重读仍显示继承空值')
  editor.patch(entry.key, { ...draft.entries[0].value, then: [{ ...example, value: {} }] })
  assert.equal(await editor.submit(), false, '至少一项限额由真实规则编译器拒绝')
  assert.deepEqual(draft.entries[0].value.then[0].value, {}, '拒绝后保留全空草稿')
  assert.match(draft.error, /file-read-limits.value requires/)
  assert.deepEqual(saved.then[0].value, { maxLineLength: 10000, limit: 3 }, '拒绝后保留最后有效保存值')
  const inputs = inputValues(render(draft.entries[0].value.then[0]))
  assert.deepEqual(readLabels.map(key => inputs.get(t('triggers.label.' + key))), ['', '', ''], '失败草稿不回显示例值')
})

test('非读取动作的同名value对象保留示例显示和显式零值', () => {
  for (const [value, expected] of [[{}, ['2', '4', '5']], [{ limit: 0, maxBytes: 0, maxLineLength: 0 }, ['0', '0', '0']]]) {
    const action = { kind: 'another-action', value }, before = structuredClone(action)
    const inputs = inputValues(render(action, { example: { value: { limit: 2, maxBytes: 4, maxLineLength: 5 } } }))
    assert.deepEqual([t('triggers.label.limit'), 'maxBytes', 'maxLineLength'].map(label => inputs.get(label)), expected)
    assert.deepEqual(action, before)
  }
})

test('请求patch数字按声明显示未声明空值和合法值', () => {
  for (const [patch, expected] of [[{}, ['', '']], [{ temperature: 0.5, maxTokens: 42 }, ['0.5', '42']]]) {
    const action = { kind: 'request-params', patch }, before = structuredClone(action)
    const inputs = inputValues(render(action, { example: { patch: { temperature: undefined, maxTokens: undefined } }, requestPatch: true }))
    assert.deepEqual(['temperature', 'maxTokens'].map(key => inputs.get(t('triggers.label.' + key))), expected)
    assert.deepEqual(action, before, '展示不将省略的patch字段补回')
  }
})
