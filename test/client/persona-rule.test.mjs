import test from 'node:test'
import assert from 'node:assert/strict'
import { withSsr, renderElement, makeTranslate } from './support/ssr-render.mjs'
import { createWorkspaceDrafts } from '../../src/client/data/workspace-drafts.ts'
import { createRuleEditor, getRulesDraft } from '../../src/client/data/rule-drafts.ts'

const { ModulePersonaCard } = await withSsr([new URL('../../src/client/features/prompts/ModulePersonaCard.tsx', import.meta.url).href])
const t = makeTranslate()
const { RuleCard } = await withSsr([new URL('../../src/client/features/prompts/RuleCard.tsx', import.meta.url).href])

test('默认身份规则卡只接受当前保存定义和目标的真实观测，草稿与关闭不显示成功', () => {
  const rule = { id: 'identity', enabled: true, then: [{ id: 'strip', kind: 'persona', stripDefaultIdentity: 'preset' }] }
  const draft = getRulesDraft(createWorkspaceDrafts(), 'module-a')
  Object.assign(draft, { loaded: true, saved: [structuredClone(rule)], revisions: { rules: { identity: 'R1' }, settings: 'S1', variables: 'V1' } })
  const entry = { key: 'identity', previousId: 'identity', value: rule }
  const observation = { moduleId: 'module-a', ruleId: 'identity', channel: 'persona:identity:preset', hit: 0, miss: 0, unavailable: 0, error: 0, identityOutcome: 'matched', definitionRevision: 'R1:S1' }
  const render = diagnostics => renderElement(RuleCard, { t, entry, draft, editor: {}, meta: { layers: [] }, expanded: true, onToggle() {}, onDuplicate() {}, expandedRows: new Map(), moduleId: 'module-a', diagnostics })
  assert.match(render([]), new RegExp(t('rules.identity.unverified')))
  assert.match(render([observation]), new RegExp(t('rules.identity.matched')))
  assert.match(render([{ ...observation, definitionRevision: 'OLD' }]), new RegExp(t('rules.identity.unverified')))
  draft.revisions.settings = 'S2'
  assert.match(render([observation]), new RegExp(t('rules.identity.unverified')), '不同设置版本的记录不显示')
  draft.revisions.settings = 'S1'
  entry.value = { ...rule, then: [{ ...rule.then[0], stripDefaultIdentity: 'harness' }] }
  assert.match(render([observation]), new RegExp(t('rules.identity.unverified')))
  entry.value = { ...rule, enabled: false }
  assert.match(render([observation]), new RegExp(t('rules.identity.disabled')))
  assert.doesNotMatch(render([observation]), new RegExp(t('rules.identity.matched')))
  entry.value = rule; draft.revisions.settings = 'S3'
  assert.match(render([observation]), new RegExp(t('rules.identity.unverified')), '此处仅验证版本筛选；启停哈希回环由真实装配用例覆盖')
  assert.match(render([{ ...observation, definitionRevision: 'R1:S3' }]), new RegExp(t('rules.identity.matched')))
  const branch = { ...rule, else: [{ id: 'other', kind: 'persona', stripDefaultIdentity: 'harness' }], if: { scope: { audience: 'main' } } }
  entry.value = branch; draft.saved = [structuredClone(branch)]
  const current = { ...observation, definitionRevision: 'R1:S3', actionId: 'strip', agentId: 'a' }
  assert.match(render([current, { ...current, actionId: 'other', channel: 'persona:identity:harness', identityOutcome: 'condition-miss' }]), new RegExp(t('rules.identity.matched')), '未选分支不抵消有效成功')
  assert.match(render([current, { ...current, actionId: 'peer', identityOutcome: 'target-mismatch' }]), new RegExp(t('rules.identity.unavailable')), '同目标另一动作真实失配不能被成功掩盖')
})

test('人设规则动作卡呈现省略字段的只读状态与显式空串', () => {
  const action = { id: 'identity', kind: 'persona', audience: 'main', prefix: '', complete: false }
  const html = renderElement(ModulePersonaCard, { t, action, disabled: false, onChange: () => {} })
  assert.match(html, /data-persona-action="identity"/)
  assert.match(html, new RegExp(t('persona.identity.label')))
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
