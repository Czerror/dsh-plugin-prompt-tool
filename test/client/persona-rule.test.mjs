import test from 'node:test'
import assert from 'node:assert/strict'
import { withSsr, renderElement, makeTranslate } from './support/ssr-render.mjs'
import { createWorkspaceDrafts } from '../../src/client/data/workspace-drafts.ts'
import { createRuleEditor, getRulesDraft } from '../../src/client/data/rule-drafts.ts'

const { ModulePersonaCard } = await withSsr([new URL('../../src/client/features/prompts/ModulePersonaCard.tsx', import.meta.url).href])
const t = makeTranslate()

test('人设规则动作卡呈现省略字段的只读状态与显式空串', () => {
  const action = { id: 'identity', kind: 'persona', audience: 'main', prefix: '', complete: false }
  const html = renderElement(ModulePersonaCard, { t, action, disabled: false, onChange: () => {} })
  assert.match(html, /data-persona-action="identity"/)
  assert.match(html, new RegExp(`aria-label="${t('persona.prefix.aria')}"`))
  assert.match(html, new RegExp(`aria-label="${t('persona.suffix.aria')}"[^>]*readonly`))
  assert.match(html, new RegExp(`textarea[^>]*aria-label="${t('persona.prefix.aria')}"[^>]*></textarea>`))
})

test('人设动作编辑只提交所属规则及其版本，冲突保留空串与 false 草稿', async () => {
  const original = { id: 'coding', if: { variable: { key: 'mode', value: 'coding' } }, then: [{ id: 'identity', kind: 'persona', prefix: 'BEFORE', complete: false }] }
  const untouched = { id: 'other', then: [{ id: 'other-identity', kind: 'persona', suffix: 'TAIL' }] }
  const calls = [], draft = getRulesDraft(createWorkspaceDrafts(), 'module-a')
  const editor = createRuleEditor('module-a', draft, {
    request: async body => {
      calls.push(structuredClone(body))
      return body.edits ? { ok: false, code: 'rules-conflict', message: '版本冲突' }
        : { ok: true, value: { rules: [original, untouched], revisions: { rules: { coding: 'R1', other: 'R2' }, settings: 'S1', variables: 'V1' }, meta: { actions: [], predicates: [], composites: [], waterfallPositions: ['default'] } } }
    },
    enqueue: async (_moduleId, task) => task(), isCurrent: () => true, changed: () => {},
  })
  await editor.load()
  const entry = draft.entries[0]
  editor.patch(entry.key, { ...entry.value, then: [{ ...entry.value.then[0], prefix: '' }] })
  assert.equal(await editor.submit(), false)
  assert.deepEqual(calls[1], { expectedModuleId: 'module-a', expectedRevisions: { rules: { coding: 'R1' } }, edits: [{ previousId: 'coding', rule: { ...original, then: [{ id: 'identity', kind: 'persona', prefix: '', complete: false }] }, settingsChanged: false }] })
  assert.equal(draft.entries[0].value.then[0].prefix, '')
  assert.equal(draft.entries[0].value.then[0].complete, false)
  assert.deepEqual(draft.entries[1].value, untouched)
})
