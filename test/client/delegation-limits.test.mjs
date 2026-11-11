import test from 'node:test'
import assert from 'node:assert/strict'
import { withSsr, renderElement, makeTranslate } from './support/ssr-render.mjs'
import { compileRules } from '../../engine/rule-spec.mjs'
import { createWorkspaceDrafts } from '../../src/client/data/workspace-drafts.ts'
import { createRuleEditor, getRulesDraft } from '../../src/client/data/rule-drafts.ts'

const { RuleParameterFields } = await withSsr([new URL('../../src/client/features/prompts/RuleFields.tsx', import.meta.url).href])
const t = makeTranslate()
const action = value => ({ id: 'limits', kind: 'host-control', capability: 'delegation-limits', value })

test('委派额度按实际声明显示空值，经原版本保存链拒绝非法候选并保留草稿', async () => {
  const html = renderElement(RuleParameterFields, { t, fields: new Map(), fieldKey: 'delegation:limits',
    value: action({ maxDepth: 0 }), example: action({ maxDepth: 10, askTimeout: 300 }), onChange() {}, onDraft() {} })
  const inputs = new Map([...html.matchAll(/<input\b[^>]*>/g)].map(([input]) => [input.match(/aria-label="([^"]*)"/)?.[1], input.match(/value="([^"]*)"/)?.[1]]))
  assert.equal(inputs.get(t('triggers.label.maxDepth')), '0')
  assert.equal(inputs.get(t('triggers.label.askTimeout')), '')
  let saved = { id: 'delegation', then: [action({ maxDepth: 10, askTimeout: 300 })] }, revision = 'R1'
  const draft = getRulesDraft(createWorkspaceDrafts(), 'delegation-module')
  const editor = createRuleEditor('delegation-module', draft, { request: async body => {
    if (body.edits) {
      assert.deepEqual(body.expectedRevisions, { rules: { delegation: revision } })
      const candidate = body.edits[0].rule
      try { compileRules([candidate]) } catch (error) { return { ok: false, code: 'rules-invalid', message: error.message } }
      saved = structuredClone(candidate); revision = 'R2'
    }
    return { ok: true, value: { rules: [structuredClone(saved)], revisions: { rules: { delegation: revision }, settings: 'S1', variables: 'V1' }, meta: { actions: [], predicates: [], composites: [], waterfallPositions: ['default'] } } }
  }, enqueue: async (_id, task) => task(), isCurrent: () => true, changed() {} })
  await editor.load()
  const entry = draft.entries[0]
  editor.patch(entry.key, { ...entry.value, then: [action({ askTimeout: 80 })] })
  assert.equal(await editor.submit(), true)
  assert.equal(await editor.load(true), true)
  assert.deepEqual(saved.then[0].value, { askTimeout: 80 })
  editor.patch(entry.key, { ...draft.entries[0].value, then: [action({ askTimeout: '2e' })] })
  assert.equal(await editor.submit(), false)
  assert.deepEqual(saved.then[0].value, { askTimeout: 80 })
  assert.deepEqual(draft.entries[0].value.then[0].value, { askTimeout: '2e' })
})
