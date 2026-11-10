import test from 'node:test'
import assert from 'node:assert/strict'
import { withSsr, renderElement, makeTranslate } from './support/ssr-render.mjs'
import { createWorkspaceDrafts } from '../../src/client/data/workspace-drafts.ts'
import { createRuleEditor, getRulesDraft } from '../../src/client/data/rule-drafts.ts'

const { ModulePersonaCard, RuleCard } = await withSsr([new URL('../../src/client/features/prompts/ModulePersonaCard.tsx', import.meta.url).href, new URL('../../src/client/features/prompts/RuleCard.tsx', import.meta.url).href])
const t = makeTranslate()

test('来源身份规则卡分开展示来源、启用意图和未验证可用性', () => {
  const rule = { id: 'purge-4', enabled: true, source: { format: 'dsh-purge', id: 4, name: 'SYSTEM_PROMPT_PERSONA', path: 'lib/patches/prompt.mjs', commit: '126caa2c99297223a7e0e87e604aecfc802f396e' }, then: [{ id: 'identity', kind: 'persona', stripDefaultIdentity: 'preset' }] }
  const draft = getRulesDraft(createWorkspaceDrafts(), 'limit-breaker')
  const html = renderElement(RuleCard, { t, entry: { key: 'r', value: rule }, draft, editor: {}, meta: { layers: [] }, moduleId: 'limit-breaker', expanded: true, expandedRows: new Map(), onToggle: () => {}, onDuplicate: () => {} })
  assert.match(html, /SYSTEM_PROMPT_PERSONA/)
  assert.ok(html.includes(t('rules.intentOn')))
  assert.ok(html.includes(t('rules.availabilityUnverified')))
  const action = renderElement(ModulePersonaCard, { t, action: rule.then[0], onChange: () => {} })
  assert.ok(action.includes(t('persona.stripDefaultIdentity')))
  const common = { t, entry: { key: 'r', value: rule }, draft, editor: {}, meta: { layers: [] }, moduleId: 'limit-breaker', expanded: true, expandedRows: new Map(), onToggle: () => {}, onDuplicate: () => {} }
  draft.saved = [rule]; common.entry.previousId = rule.id; draft.revisions = { rules: { 'purge-4': 'R1' }, settings: 'S1', variables: 'V1' }
  const record = { moduleId: 'limit-breaker', ruleId: 'purge-4', channel: 'persona:identity:preset', hit: 0, miss: 0, unavailable: 0, error: 0, identityOutcome: 'target-mismatch', definitionRevision: 'R1' }
  assert.ok(renderElement(RuleCard, { ...common, diagnostics: [record] }).includes(t('rules.availabilityUnavailable')))
  assert.ok(renderElement(RuleCard, { ...common, diagnostics: [{ ...record, identityOutcome: 'matched' }] }).includes(t('rules.availabilityMatched')))
})

test('身份规则保存目标或正文版本后不沿用旧成功观测', () => {
  const before = { id: 'purge-4', enabled: true, source: { format: 'dsh-purge', id: 4, name: 'SYSTEM_PROMPT_PERSONA', path: 'lib/patches/prompt.mjs', commit: 'source' }, then: [{ id: 'identity', kind: 'persona', stripDefaultIdentity: 'preset' }] }
  const draft = getRulesDraft(createWorkspaceDrafts(), 'limit-breaker')
  const changed = { ...before, then: [{ ...before.then[0], stripDefaultIdentity: 'harness' }] }
  draft.saved = [changed]; draft.revisions = { rules: { 'purge-4': 'R2' }, settings: 'S1', variables: 'V1' }
  const common = { t, entry: { key: 'r', previousId: 'purge-4', value: changed }, draft, editor: {}, meta: { layers: [] }, moduleId: 'limit-breaker', expanded: true, expandedRows: new Map(), onToggle: () => {}, onDuplicate: () => {} }
  const old = { moduleId: 'limit-breaker', ruleId: 'purge-4', channel: 'persona:identity:preset', hit: 1, miss: 0, unavailable: 0, error: 0, lastOutcome: 'hit', identityOutcome: 'matched', definitionRevision: 'R1' }
  assert.ok(renderElement(RuleCard, { ...common, diagnostics: [old] }).includes(t('rules.availabilityUnverified')))
  assert.ok(renderElement(RuleCard, { ...common, diagnostics: [{ ...old, channel: 'persona:identity:harness' }] }).includes(t('rules.availabilityUnverified')))
  assert.ok(renderElement(RuleCard, { ...common, diagnostics: [{ ...old, channel: 'persona:identity:harness', definitionRevision: 'R2' }] }).includes(t('rules.availabilityMatched')))
})

test('人设规则动作卡呈现省略字段的只读状态与显式空串', () => {
  const action = { id: 'identity', kind: 'persona', audience: 'main', prefix: '', complete: false }
  const html = renderElement(ModulePersonaCard, { t, action, disabled: false, onChange: () => {} })
  assert.match(html, /data-persona-action="identity"/)
  assert.match(html, new RegExp(`aria-label="${t('persona.prefix.aria')}"`))
  assert.match(html, new RegExp(`aria-label="${t('persona.suffix.aria')}"[^>]*readonly`))
  assert.match(html, new RegExp(`textarea[^>]*aria-label="${t('persona.prefix.aria')}"[^>]*></textarea>`))
})

test('人设动作编辑只提交所属规则及其版本，冲突保留空串与 false 草稿', async () => {
  const original = { id: 'coding', if: { variable: { key: 'mode', value: 'coding' } }, then: [{ id: 'identity', kind: 'persona', prefix: 'BEFORE', complete: false, stripDefaultIdentity: 'harness' }] }
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
  assert.deepEqual(calls[1], { expectedModuleId: 'module-a', expectedRevisions: { rules: { coding: 'R1' } }, edits: [{ previousId: 'coding', rule: { ...original, then: [{ id: 'identity', kind: 'persona', prefix: '', complete: false, stripDefaultIdentity: 'harness' }] }, settingsChanged: false }] })
  assert.equal(draft.entries[0].value.then[0].prefix, '')
  assert.equal(draft.entries[0].value.then[0].complete, false)
  assert.deepEqual(draft.entries[1].value, untouched)
})
