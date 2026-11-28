import test from 'node:test'
import assert from 'node:assert/strict'
import { createWorkspaceDrafts } from '../../src/client/data/workspace-drafts.ts'
import { bridgeCall } from '../../src/client/data/bridge-client.ts'
import { createRuleEditor, getRulesDraft, rulesDirty } from '../../src/client/data/rule-drafts.ts'
import { createTemplateRuleWriter } from '../../src/client/data/template-rule-writer.ts'

const meta = { predicates: [], composites: ['all', 'any', 'not', 'notAny'], actions: [], waterfallPositions: ['default'] }
const alpha = { id: 'alpha', enabled: true, group: 'mode', exclusive: true, then: [{ id: 'alpha-text', kind: 'inject-text', config: { id: 'text', text: 'Alpha', layer: 'pre-step', future: { keep: 42 } } }] }
const beta = { id: 'beta', enabled: false, group: 'mode', then: [{ id: 'beta-text', kind: 'inject-text', config: { id: 'other', text: 'Beta', layer: 'pre-step' } }] }
const snapshot = (rules = [alpha, beta], revision = 'baseline') => ({ rules: structuredClone(rules), revisions: { rules: Object.fromEntries(rules.map(rule => [rule.id, revision])), settings: revision, variables: revision }, meta })
function harness(request, enqueue = async (_moduleId, task) => task()) {
  const draft = getRulesDraft(createWorkspaceDrafts(), 'module-a'), calls = []
  let current = true
  const editor = createRuleEditor('module-a', draft, {
    request: async body => { calls.push(structuredClone(body)); return request(body) },
    enqueue: async (moduleId, task) => { assert.equal(moduleId, 'module-a'); return enqueue(moduleId, task) },
    isCurrent: () => current, changed: () => {},
  })
  return { draft, editor, calls, switchModule: () => { current = false } }
}

test('rules bridge: moving commits the module once, rejects incomplete input and preserves in-flight edits', async () => {
  const branch = { if: { scope: { audience: 'main' } }, then: [alpha.then[0]], else: [beta.then[0]] }
  const original = { ...alpha, then: [branch, beta.then[0]], else: [alpha.then[0], beta.then[0]] }
  let finish
  let nextSave
  const definitionRevision = 'd'.repeat(64)
  const h = harness(async body => body.edits ? nextSave?.(body) ?? new Promise(resolve => { finish = resolve })
    : { ok: true, value: body.refreshOnly ? snapshot(h.draft.saved, 'published') : snapshot([original, beta]) })
  await h.editor.load()
  const [entry, other] = h.draft.entries, path = entry.key + ':then'
  h.editor.patch(other.key, { ...other.value, name: 'same module' })
  h.draft.fields.set(other.key + ':full', { source: '{}', text: '{', error: 'unfinished' })
  assert.equal(await h.editor.move(entry.key, path, 0, 1), false)
  assert.deepEqual(h.draft.entries[0].value, original)
  assert.equal(h.draft.fields.get(other.key + ':full').text, '{')
  assert.equal(h.calls.length, 1, 'invalid sibling blocks both movement and writing')
  h.draft.fields.delete(other.key + ':full')
  h.editor.setComposing(other.key, true)
  assert.equal(await h.editor.move(entry.key, path, 0, 1), false)
  h.editor.setComposing(other.key, false)
  assert.equal(h.calls.length, 1, 'composition end does not replay movement')
  h.draft.fields.set(path + ':0:then:0:alpha-text:n', { source: '01', text: '01' })
  h.draft.fields.set(entry.key + ':else:0:alpha-text:n', { source: '02', text: '02' })
  const saving = h.editor.move(entry.key, path, 0, 1)
  await Promise.resolve()
  assert.equal(h.calls.length, 2)
  const sent = h.calls[1]
  assert.equal(sent.expectedModuleId, 'module-a')
  assert.deepEqual(sent.expectedRevisions.rules, { alpha: 'baseline', beta: 'baseline' })
  assert.deepEqual(sent.edits[0].rule.then, [beta.then[0], branch])
  assert.equal(sent.edits[0].rule.id, original.id, '主子分支仍属于同一条规则')
  assert.deepEqual(sent.edits[0].rule.then[1].if, { scope: { audience: 'main' } }, '分支受众条件原样保存')
  assert.equal(sent.edits[1].rule.name, 'same module')
  assert.equal(h.draft.fields.has(path + ':0:then:0:alpha-text:n'), false)
  assert.equal(h.draft.fields.has(entry.key + ':else:0:alpha-text:n'), true)
  h.editor.patch(entry.key, { ...h.draft.entries[0].value, name: 'typed while saving' })
  finish({ ok: true, value: { ...snapshot(sent.edits.map(edit => edit.rule), 'saved'), definitionRevision, publicationPending: true, publicationError: 'publish failed' } })
  assert.equal(await saving, false, 'publication failure does not undo a persisted move')
  assert.equal(h.draft.entries[0].value.name, 'typed while saving')
  assert.deepEqual(h.draft.saved[0].then, [beta.then[0], branch])
  assert.equal(h.calls.length, 2, 'one move performs one module write')
  nextSave = () => ({ ok: false, code: 'rules-invalid', message: 'new write rejected' })
  assert.equal(await h.editor.submitRule(entry.key), false)
  assert.equal(h.editor.retryKind, 'save', 'the newer rejection has its own recovery despite the older publication failure')
  assert.equal(h.draft.error, 'new write rejected')
  assert.equal(h.draft.publicationError, 'publish failed')
  h.editor.patch(other.key, { ...h.draft.entries[1].value, name: 'unrelated draft' })
  assert.equal(h.draft.error, 'new write rejected', 'editing a different rule leaves the save failure intact')
  const unsaved = h.draft.entries[0].value
  h.editor.patch(entry.key, h.draft.saved[0])
  assert.equal(h.draft.error, undefined, 'reverting the rejected rule clears its save failure')
  assert.equal(h.draft.publicationError, 'publish failed')
  assert.equal(h.calls.length, 3, 'reverting does not publish the older version')
  h.editor.patch(entry.key, unsaved)
  assert.equal(await h.editor.submitRule(entry.key), false)
  assert.equal(await h.editor.retryPublication(), true)
  assert.deepEqual(h.calls[4], { expectedModuleId: 'module-a', refreshOnly: true, expectedDefinitionRevision: definitionRevision })
  assert.equal(h.draft.error, 'new write rejected', 'publishing the older version does not clear the newer save error')
  assert.equal(h.editor.retryKind, 'save')
  assert.equal(h.draft.entries[0].value.name, 'typed while saving')
  nextSave = body => ({ ok: true, value: snapshot([body.edits[0].rule, h.draft.saved[1]], 'retried') })
  assert.equal(await h.editor.retry(), true)
  assert.deepEqual(h.calls.at(-1).edits.map(edit => edit.previousId), [original.id])
  assert.equal(h.draft.entries[1].value.name, 'unrelated draft')
  assert.equal(h.draft.errorCode, undefined)
})

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
  assert.deepEqual(h.draft.entries[0].value.then[0].config.future, { keep: 42 })
  assert.equal(rulesDirty(h.draft), false)
  await h.editor.submit()
  assert.equal(h.calls.length, 2, 'unchanged submit does not write')
})

test('撤回被拒的启用不重试发布，已启用赢家的选择仍可重试', async () => {
  const h = harness(async body => body.edits
    ? { ok: false, code: 'rules-invalid', message: 'activation rejected' }
    : { ok: true, value: { ...snapshot(), publicationPending: true, publicationError: 'older publish failed' } })
  await h.editor.load()
  const [winner, disabled] = h.draft.entries
  h.editor.patch(disabled.key, { ...disabled.value, enabled: true })
  assert.equal(await h.editor.submitRule(disabled.key, { activateRuleId: beta.id }), false)
  h.editor.patch(disabled.key, disabled.value)
  assert.equal(await h.editor.submitRule(disabled.key), true)
  assert.equal(h.draft.error, undefined)
  assert.equal(h.draft.publicationError, 'older publish failed')
  assert.deepEqual(h.calls.map(body => [body.activateRuleId, body.refreshOnly]), [[undefined, undefined], [beta.id, undefined]])

  assert.equal(await h.editor.submit({ activateRuleId: winner.value.id }), false)
  assert.equal(h.draft.error, 'activation rejected')
  assert.equal(await h.editor.retry(), false)
  assert.deepEqual(h.calls.slice(2).map(body => [body.activateRuleId, body.edits]), [[alpha.id, []], [alpha.id, []]])
})

test('lost save receipt is reconciled by reading the original module and preserves later input', async () => {
  let stored = alpha
  const h = harness(async body => {
    if (!body.edits) return { ok: true, value: snapshot([stored, beta], stored === alpha ? 'before' : 'after') }
    stored = structuredClone(body.edits[0].rule)
    return { ok: false, code: 'bridge-response-unknown' }
  })
  await h.editor.load()
  const key = h.draft.entries[0].key
  h.editor.patch(key, { ...alpha, name: 'sent' })
  assert.equal(await h.editor.submit(), false)
  h.editor.patch(key, { ...alpha, name: 'later' })
  assert.equal(h.editor.retryKind, 'read')
  assert.equal(await h.editor.submit(), false)
  await h.editor.retry()
  assert.deepEqual(h.calls[2], { expectedModuleId: 'module-a' })
  assert.equal(h.draft.saved[0].name, 'sent')
  assert.equal(h.draft.entries[0].value.name, 'later')
  assert.equal(h.calls.filter(body => body.edits).length, 1)
})

test('rules bridge: shared-alias rejection requires reading and preserves local input', async () => {
  const h = harness(async body => body.edits ? { ok: false, code: 'shared-alias', message: 'detach shared reference' } : { ok: true, value: snapshot() })
  await h.editor.load()
  const key = h.draft.entries[0].key
  const changed = { ...structuredClone(alpha), name: 'local draft', then: [alpha.then[0], beta.then[0]] }
  h.editor.patch(key, changed)
  assert.equal(await h.editor.move(key, key + ':then', 0, 1), false)
  changed.then.reverse()
  assert.equal(h.draft.error, 'detach shared reference')
  assert.equal(h.draft.errorCode, 'shared-alias')
  assert.deepEqual(h.draft.entries[0].value, changed)
  assert.equal(h.draft.revisions.rules.alpha, 'baseline')
  assert.deepEqual(h.calls[1].expectedRevisions, { rules: { alpha: 'baseline' } }, '正文编辑不提交无关规则或状态指纹')
  assert.equal(await h.editor.submit(), false, '重新读取前禁止重放共享引用拒绝的写入')
  assert.equal(h.calls.length, 2)
  assert.equal(h.editor.retryKind, 'read')
  assert.equal(await h.editor.retry(), true, '重试只读新版本，不重放写入')
  assert.deepEqual(h.calls[2], { expectedModuleId: 'module-a' })
  assert.equal(h.draft.errorCode, undefined)
  assert.deepEqual(h.draft.entries[0].value, changed)
  h.switchModule()
  assert.equal(await h.editor.submit(), false)
  assert.equal(h.calls.length, 3)
})

test('新建条件与空白规则留在草稿；无效字段不提交，后台读取不删除，修正后完整保存', async () => {
  const h = harness(async body => ({ ok: true, value: body.edits
    ? snapshot(body.edits.map(edit => edit.rule).filter(Boolean), 'saved') : snapshot() }))
  await h.editor.load()
  const entry = h.draft.entries[0]
  const condition = { scope: { audience: 'main' } }
  h.editor.patch(entry.key, { ...entry.value, if: condition })
  h.draft.fields.set(entry.key + ':if', { source: '{}', text: '{', error: '未完成 JSON' })
  assert.equal(await h.editor.submit(), false)
  assert.equal(h.calls.length, 1, '无效输入只留草稿，不发保存请求')
  await h.editor.load(true)
  assert.deepEqual(h.draft.entries[0].value.if, condition)
  assert.equal(h.draft.fields.get(entry.key + ':if').text, '{', '刷新不删除未完成条件')
  h.draft.fields.clear()
  assert.equal(await h.editor.submit(), true)
  assert.deepEqual(h.calls.at(-1).edits[0].rule.if, condition, '新条件跟随完整规则提交')
  const blank = { id: '', then: [] }, key = h.editor.add(blank)
  h.draft.fields.set(key + ':id', { source: '', text: '', error: '请输入规则标识' })
  assert.equal(await h.editor.submit(), false)
  await h.editor.load(true)
  assert.deepEqual(h.draft.entries.find(item => item.key === key).value, blank, '未完成的新规则不会被远端列表隐藏')
})

test('rules bridge: conflict recovery reads remote, preserves local input and never repeats an old write', async () => {
  let reads = 0
  const remote = { ...alpha, name: 'remote change' }
  const h = harness(async body => {
    if (body.edits) return { ok: false, code: 'rules-conflict', message: 'revision changed' }
    reads++
    if (reads === 2) return { ok: false, message: 'offline' }
    return { ok: true, value: reads === 1 ? snapshot() : snapshot([remote, beta], 'remote') }
  })
  await h.editor.load()
  h.editor.patch(h.draft.entries[0].key, { ...alpha, name: 'keep local' })
  await h.editor.submit()
  assert.equal(await h.editor.retry(), false)
  assert.equal(await h.editor.submit(), false)
  assert.equal(await h.editor.retry(), false, 'remote change requires explicit conflict handling')
  assert.equal(h.draft.entries[0].value.name, 'keep local')
  assert.equal(h.draft.remote.rules[0].name, 'remote change')
  assert.equal(h.calls.filter(call => call.edits).length, 1)
  h.editor.discard()
  assert.equal(h.draft.entries[0].value.name, 'remote change')
  assert.equal(h.draft.revisions.rules.alpha, 'remote')
})

test('rules bridge: first creation stores the complete result without an active view and retries only publication', async () => {
  const created = { id: 'first', enabled: false, then: [] }
  let pending = true
  const h = harness(async body => ({ ok: true, value: { ...snapshot([created], pending ? 'created' : 'published'),
    ...(body.createRule ? { createdRuleId: 'first', publicationError: 'publish failed' } : {}), publicationPending: pending,
  } }))
  const result = await h.editor.create(created, false)
  assert.equal(result.ok, true)
  assert.deepEqual(h.calls[0], { expectedModuleId: 'module-a', expectedRulesAbsent: true, createRule: created })
  assert.equal(h.draft.loaded, true)
  assert.equal(h.draft.entries[0].value.id, 'first')
  assert.equal(h.draft.entries[0].value.enabled, false)
  assert.equal(h.editor.retryKind, 'publish')
  assert.equal(h.draft.publicationError, 'publish failed')
  assert.equal(await h.editor.submit(), false, 'a refresh receipt can still be pending')
  assert.equal(h.draft.publicationError, undefined)
  pending = false
  h.editor.patch(h.draft.entries[0].key, { ...created, name: 'unsaved' })
  assert.equal(await h.editor.retry(), true)
  assert.deepEqual(h.calls.slice(1), Array(2).fill({ expectedModuleId: 'module-a', refreshOnly: true }))
  assert.equal(h.calls.filter(call => call.createRule).length, 1)
  assert.equal(h.draft.publicationPending, false)
  assert.equal(h.draft.revisions.rules.first, 'published')
  assert.equal(h.draft.entries[0].value.name, 'unsaved')
})

test('rules bridge: unknown creation can be retried only after readback confirms it did not write', async (t) => {
  const created = { id: 'first', then: [{ id: 'text', kind: 'inject-text', config: { text: 'body' } }] }
  const drafts = createWorkspaceDrafts(), calls = [], effects = [], receipts = []
  const draft = getRulesDraft(drafts, 'module-a')
  let readable = false
  t.mock.method(globalThis, 'fetch', async (_url, { body }) => {
    const request = JSON.parse(body)
    calls.push(request)
    return Response.json(request.createRule && readable
      ? { ok: true, value: { ...snapshot([created]), createdRuleId: created.id } }
      : { ok: false, code: readable ? 'module-not-declared' : 'bridge-response-unknown' })
  })
  const enqueue = async task => task()
  const writer = createTemplateRuleWriter({ drafts, modules: () => [], changed() {}, enqueue,
    markDeclared: (id, section) => effects.push([id, section]),
    actions: { enable: async (id, enabled) => {
      effects.push([id, 'enable', enabled])
      return { ok: false, message: 'enable failed' }
    } },
  })
  const editor = createRuleEditor('module-a', draft, { isCurrent: () => true, changed() {},
    request: body => bridgeCall('rules', body, 'module-a'),
    enqueue: (_id, task) => enqueue(task),
  })
  const result = await writer('module-a', created, true, receipt => receipts.push(receipt))
  assert.equal(result.ok, false)
  assert.equal(draft.pending !== undefined, true)
  assert.equal(await editor.retry(), false)
  assert.equal(draft.retryCreate, undefined)
  assert.equal(calls.filter(call => call.createRule).length, 1)
  readable = true
  assert.equal(await editor.retry(), false)
  assert.equal(draft.pending, undefined)
  assert.equal(editor.retryKind, 'save')
  assert.equal(calls.filter(call => call.createRule).length, 1)
  assert.deepEqual(effects, [])
  assert.equal(await editor.retry(), true)
  assert.deepEqual(calls.filter(call => call.createRule), [calls[0], calls[0]])
  assert.deepEqual(effects, [['module-a', 'rules'], ['module-a', 'enable', true]])
  assert.deepEqual(receipts.map(receipt => [receipt.value.createdRuleId, receipt.moduleEnableError]), [['first', 'enable failed']])
  assert.equal(draft.entries[0].value.id, created.id)
})

test('rules bridge: queued save and in-flight read survive leaving the view without losing input', async () => {
  let finish
  let dispatch
  const pending = new Promise(resolve => { finish = resolve })
  const h = harness(async body => body.edits ? pending : { ok: true, value: snapshot() },
    (_id, task) => new Promise(resolve => { dispatch = () => resolve(task()) }))
  await h.editor.load()
  const key = h.draft.entries[0].key
  h.editor.patch(key, { ...alpha, name: 'sent' })
  const saving = h.editor.submit()
  await Promise.resolve()
  h.editor.patch(key, { ...alpha, name: 'typed later' })
  h.switchModule()
  dispatch()
  finish({ ok: true, value: snapshot([{ ...alpha, name: 'sent' }, beta], 'saved') })
  assert.equal(await saving, true)
  assert.equal(h.draft.saved[0].name, 'sent')
  assert.equal(h.draft.entries[0].value.name, 'typed later')
  assert.equal(h.draft.revisions.rules.alpha, 'saved')
  assert.equal(h.draft.entries[0].key, key)
  let readDone
  const delayed = harness(() => new Promise(resolve => { readDone = resolve }))
  const loading = delayed.editor.load()
  delayed.switchModule()
  readDone({ ok: true, value: snapshot([alpha], 'read-after-leave') })
  assert.equal(await loading, true)
  assert.equal(delayed.draft.loaded, true)
  assert.equal(delayed.draft.revisions.rules.alpha, 'read-after-leave')
})
