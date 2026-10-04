import test from 'node:test'
import assert from 'node:assert/strict'
import { createWorkspaceDrafts } from '../../src/client/data/workspace-drafts.ts'
import { createRuleEditor, getRulesDraft, ruleEdits, rulesDirty } from '../../src/client/data/rule-drafts.ts'

const meta = { predicates: [], composites: ['all', 'any', 'not', 'notAny'], actions: [], waterfallPositions: ['default'] }
const alpha = { id: 'alpha', enabled: true, group: 'mode', exclusive: true, do: [{ id: 'alpha-text', kind: 'inject-text', config: { id: 'text', text: 'Alpha', layer: 'pre-step', future: { keep: 42 } } }] }
const beta = { id: 'beta', enabled: false, group: 'mode', do: [{ id: 'beta-text', kind: 'inject-text', config: { id: 'other', text: 'Beta', layer: 'pre-step' } }] }
const snapshot = (rules = [alpha, beta], revision = 'baseline') => ({ rules: structuredClone(rules), revisions: { rules: Object.fromEntries(rules.map(rule => [rule.id, revision])), settings: revision, variables: revision }, meta })
function harness(request) {
  const draft = getRulesDraft(createWorkspaceDrafts(), 'module-a'), calls = []
  let current = true
  const editor = createRuleEditor('module-a', draft, {
    request: async body => { calls.push(structuredClone(body)); return request(body) },
    enqueue: async (moduleId, task) => { assert.equal(moduleId, 'module-a'); return task() },
    isCurrent: () => current, changed: () => {},
  })
  return { draft, editor, calls, switchModule: () => { current = false } }
}

test('rules bridge: rename/delete use previous identity and CAS; unknown payload and action IDs survive', async () => {
  const next = { ...structuredClone(alpha), id: 'renamed-alpha', name: 'renamed' }
  const h = harness(async body => ({ ok: true, value: body.edits ? snapshot([next], 'saved') : snapshot() }))
  await h.editor.load()
  await h.editor.load()
  assert.deepEqual(h.calls, [{ expectedModuleId: 'module-a' }], 'same loaded draft does not read twice')
  const key = h.draft.entries[0].key
  h.editor.patch(key, next)
  h.editor.remove(h.draft.entries[1].key)
  assert.equal(await h.editor.submit(), true)
  assert.deepEqual(h.calls[1], { expectedModuleId: 'module-a', expectedRevisions: { rules: { alpha: 'baseline', beta: 'baseline' }, settings: 'baseline' }, edits: [
    { previousId: 'alpha', rule: next, settingsChanged: false }, { previousId: 'beta', rule: null },
  ] })
  assert.equal(h.draft.entries[0].key, key)
  assert.equal(h.draft.entries[0].previousId, 'renamed-alpha')
  assert.deepEqual(h.draft.entries[0].value.do[0].config.future, { keep: 42 })
  assert.equal(rulesDirty(h.draft), false)
  await h.editor.submit()
  assert.equal(h.calls.length, 2, 'unchanged submit does not write')
})

test('rules bridge: raw invalid JSON, CAS failure and switched module never discard local input', async () => {
  const h = harness(async body => body.edits ? { ok: false, code: 'rules-conflict', message: 'revision changed' } : { ok: true, value: snapshot() })
  await h.editor.load()
  const key = h.draft.entries[0].key
  const changed = { ...structuredClone(alpha), name: 'local draft' }
  h.editor.patch(key, changed)
  h.draft.fields.set(key + ':full', { source: '{}', text: '{"when":', error: 'unfinished JSON' })
  assert.equal(await h.editor.submit(), false)
  assert.equal(h.calls.length, 1)
  assert.equal(h.draft.fields.get(key + ':full').text, '{"when":')
  h.draft.fields.clear()
  assert.equal(await h.editor.submit(), false)
  assert.equal(h.draft.error, 'revision changed')
  assert.deepEqual(h.draft.entries[0].value, changed)
  assert.equal(h.draft.revisions.rules.alpha, 'baseline')
  assert.deepEqual(h.calls[1].expectedRevisions, { rules: { alpha: 'baseline' } }, '正文编辑不提交无关规则或状态指纹')
  h.switchModule()
  assert.equal(await h.editor.submit(), false)
  assert.equal(h.calls.length, 2)
})

test('rules bridge: activation accepts full mutex snapshot while preserving edits made during save', async () => {
  let release
  const waiting = new Promise(resolve => { release = resolve })
  const h = harness(async body => body.edits ? waiting : { ok: true, value: snapshot() })
  await h.editor.load()
  const target = h.draft.entries[1]
  h.editor.patch(target.key, { ...target.value, enabled: true })
  const saving = h.editor.submit({ activateRuleId: 'beta' })
  await Promise.resolve()
  h.editor.patch(target.key, { ...h.draft.entries[1].value, name: 'typed during save' })
  h.editor.patch(h.draft.entries[0].key, { ...h.draft.entries[0].value, name: 'other body during save' })
  release({ ok: true, value: snapshot([{ ...alpha, enabled: false }, { ...beta, enabled: true }], 'activated') })
  assert.equal(await saving, true)
  assert.equal(h.calls[1].activateRuleId, 'beta')
  assert.equal(h.draft.entries[0].value.enabled, false)
  assert.equal(h.draft.entries[1].value.enabled, true)
  assert.equal(h.draft.entries[1].value.name, 'typed during save')
  assert.deepEqual(ruleEdits(h.draft), [
    { previousId: 'alpha', rule: { ...alpha, enabled: false, name: 'other body during save' }, settingsChanged: false },
    { previousId: 'beta', rule: { ...beta, enabled: true, name: 'typed during save' }, settingsChanged: false },
  ])
  assert.equal(h.draft.revisions.settings, 'activated')
  let published = false
  const persisted = snapshot([alpha, beta, { id: 'new', do: [] }], 'persisted')
  const failed = harness(async body => {
    if (body.refreshOnly) { published = true; return { ok: true, value: persisted } }
    return { ok: true, value: body.edits
      ? { ...persisted, persisted: true, publicationPending: true, publicationError: 'activation failed' }
      : failed.calls.length > 2 ? persisted : snapshot() }
  })
  await failed.editor.load()
  failed.editor.add({ id: 'new', do: [] })
  assert.equal(await failed.editor.submit(), false)
  assert.equal(failed.draft.error, 'activation failed')
  assert.equal(failed.draft.publicationPending, true)
  assert.equal(rulesDirty(failed.draft), false, '已持久化响应确认实际请求，重试不会重复新增')
  await failed.editor.load(true)
  assert.equal(failed.draft.error, 'activation failed', '重新读取不能伪装运行已发布')
  assert.equal(await failed.editor.submit(), true)
  assert.equal(published, true)
  assert.deepEqual(failed.calls.at(-1), { expectedModuleId: 'module-a', refreshOnly: true })
  assert.equal(failed.calls.filter(body => body.edits).length, 1)
  assert.equal(failed.draft.publicationPending, false)
  assert.equal(failed.draft.error, undefined)
})
