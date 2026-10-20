import test from 'node:test'
import assert from 'node:assert/strict'
import { createWorkspaceDrafts } from '../../src/client/data/workspace-drafts.ts'
import { createRuleEditor, getRulesDraft, ruleEdits, rulesDirty } from '../../src/client/data/rule-drafts.ts'

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

test('rules bridge: CAS failure and switched module never discard local input', async () => {
  const h = harness(async body => body.edits ? { ok: false, code: 'rules-conflict', message: 'revision changed' } : { ok: true, value: snapshot() })
  await h.editor.load()
  const key = h.draft.entries[0].key
  const changed = { ...structuredClone(alpha), name: 'local draft' }
  h.editor.patch(key, changed)
  assert.equal(await h.editor.submit(), false)
  assert.equal(h.draft.error, 'revision changed')
  assert.deepEqual(h.draft.entries[0].value, changed)
  assert.equal(h.draft.revisions.rules.alpha, 'baseline')
  assert.deepEqual(h.calls[1].expectedRevisions, { rules: { alpha: 'baseline' } }, '正文编辑不提交无关规则或状态指纹')
  assert.equal(await h.editor.submit(), false, '冲突后禁止再次提交旧版本')
  assert.equal(h.calls.length, 2)
  assert.equal(h.editor.retryKind, 'read')
  assert.equal(await h.editor.retry(), true, '重试只读新版本，不重放写入')
  assert.deepEqual(h.calls[2], { expectedModuleId: 'module-a' })
  assert.deepEqual(h.draft.entries[0].value, changed)
  h.switchModule()
  assert.equal(await h.editor.submit(), false)
  assert.equal(h.calls.length, 3)
})

test('rules bridge: 确认关联和兜底字段按草稿增删，不在提交时补回默认值', async () => {
  let saved = structuredClone(alpha)
  const h = harness(async body => {
    if (body.edits) saved = structuredClone(body.edits[0].rule)
    return { ok: true, value: snapshot([saved], body.edits ? 'saved' : 'baseline') }
  })
  await h.editor.load()
  const key = h.draft.entries[0].key
  saved = { ...saved, if: { anchor: { subject: 'assistantReasoning', keys: ['READY'] } } }
  h.editor.patch(key, saved)
  assert.equal(await h.editor.submit(), true)
  assert.deepEqual(h.calls.at(-1).edits[0].rule.if.anchor, { subject: 'assistantReasoning', keys: ['READY'] })
  saved = { ...saved, if: { anchor: { ...saved.if.anchor, after: { action: 'seed' }, fallbackAfter: 2 } } }
  h.editor.patch(key, saved)
  assert.equal(await h.editor.submit(), true)
  assert.deepEqual(h.calls.at(-1).edits[0].rule.if.anchor.after, { action: 'seed' })
  assert.equal(h.calls.at(-1).edits[0].rule.if.anchor.fallbackAfter, 2)
  delete saved.if.anchor.after
  delete saved.if.anchor.fallbackAfter
  h.editor.patch(key, saved)
  assert.equal(await h.editor.submit(), true)
  assert.deepEqual(h.calls.at(-1).edits[0].rule.if.anchor, { subject: 'assistantReasoning', keys: ['READY'] })
})

test('rules bridge: 文本长度增删与流动作完整提交，不把示例默认值写回', async () => {
  let saved = { ...structuredClone(alpha), if: { text: { subject: 'userMessage', minChars: 0, maxChars: 120 } }, then: [{ id: 'output', kind: 'stream-output', mode: 'replace', text: '输出' }] }
  const h = harness(async body => {
    if (body.edits) saved = structuredClone(body.edits[0].rule)
    return { ok: true, value: snapshot([saved], body.edits ? 'saved' : 'baseline') }
  })
  await h.editor.load()
  const key = h.draft.entries[0].key
  const next = structuredClone(saved)
  delete next.if.text.maxChars
  h.editor.patch(key, next)
  assert.equal(await h.editor.submit(), true)
  assert.deepEqual(h.calls.at(-1).edits[0].rule.if, { text: { subject: 'userMessage', minChars: 0 } })
  assert.deepEqual(h.calls.at(-1).edits[0].rule.then, [{ id: 'output', kind: 'stream-output', mode: 'replace', text: '输出' }])
  const withoutLength = { ...saved, if: { text: { subject: 'userMessage', keys: ['完成'] } } }
  h.editor.patch(key, withoutLength)
  assert.equal(await h.editor.submit(), true)
  assert.deepEqual(h.calls.at(-1).edits[0].rule.if, { text: { subject: 'userMessage', keys: ['完成'] } })
})

test('rules bridge: 共享引用被拒后只许重新读取，不重放那一次写', async () => {
  const h = harness(async body => body.edits
    ? { ok: false, code: 'shared-alias', message: 'YAML 共享引用会改变其他定义；请先解除相关引用后再编辑（连带改了 persona）' }
    : { ok: true, value: snapshot() })
  await h.editor.load()
  h.editor.patch(h.draft.entries[0].key, { ...structuredClone(alpha), name: 'local draft' })
  assert.equal(await h.editor.submit(), false)
  assert.match(h.draft.error, /共享引用/)
  assert.equal(h.editor.retryKind, 'read', '共享引用不是「重试保存」能解决的')
  assert.equal(await h.editor.submit(), false, '被拒后禁止再次提交旧版本')
  assert.equal(h.calls.length, 2, '不重放注定失败的写请求')
  assert.equal(await h.editor.retry(), true, '重试走重新读取')
  assert.equal(h.calls.at(-1).edits, undefined, '重试只读，不重放写')
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
  const h = harness(async body => ({ ok: true, value: { ...snapshot([created], body.createRule ? 'created' : 'published'),
    ...(body.createRule ? { createdRuleId: 'first', publicationPending: true, publicationError: 'publish failed' } : {}),
  } }))
  const result = await h.editor.create(created, false)
  assert.equal(result.ok, true)
  assert.deepEqual(h.calls[0], { expectedModuleId: 'module-a', expectedRulesAbsent: true, createRule: created })
  assert.equal(h.draft.loaded, true)
  assert.equal(h.draft.entries[0].value.id, 'first')
  assert.equal(h.draft.entries[0].value.enabled, false)
  assert.equal(h.editor.retryKind, 'publish')
  h.editor.patch(h.draft.entries[0].key, { ...created, name: 'unsaved' })
  assert.equal(await h.editor.retry(), true)
  assert.deepEqual(h.calls[1], { expectedModuleId: 'module-a', refreshOnly: true })
  assert.equal(h.calls.filter(call => call.createRule).length, 1)
  assert.equal(h.draft.publicationPending, false)
  assert.equal(h.draft.revisions.rules.first, 'published')
  assert.equal(h.draft.entries[0].value.name, 'unsaved')
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
