import test from 'node:test'
import assert from 'node:assert/strict'
import { createTemplateRuleWriter } from '../../src/client/data/template-rule-writer.ts'
import { createModuleActions } from '../../src/client/data/module-actions.ts'
import { createWorkspaceDrafts } from '../../src/client/data/workspace-drafts.ts'
import { createRuleEditor, getRulesDraft } from '../../src/client/data/rule-drafts.ts'
import { EDIT_TARGET_HEADER } from '../../src/shared/bridge-contract.ts'

const rule = { id: 'budget', enabled: false, then: [] }
const snapshot = (rules = [rule], extras = {}) => ({ rules, revisions: { rules: {}, settings: 's1', variables: 'v1' }, meta: { predicates: [], composites: [], actions: [], waterfallPositions: [] }, createdRuleId: rules.at(-1)?.id, ...extras })
const ok = value => new Response(JSON.stringify({ ok: true, value }))
const failure = (code, message) => new Response(JSON.stringify({ ok: false, code, message }), { status: 409 })
const module = (id, declares) => ({ id, user: true, renderable: true, enabled: false, facts: { editable: true }, ...(declares === undefined ? {} : { declares }) })
function setup(modules = []) {
  const drafts = createWorkspaceDrafts(), marks = []; let refreshes = 0
  const actions = createModuleActions({ enqueue: task => task(), refresh: async () => { refreshes++; return true } })
  const writer = createTemplateRuleWriter({ drafts, modules: () => modules, changed() {}, markDeclared: (...args) => marks.push(args), enqueue: task => task(), actions })
  return { drafts, writer, marks, get refreshes() { return refreshes } }
}
async function withFetch(responses, run) {
  const original = globalThis.fetch, calls = []
  globalThis.fetch = async (url, init) => { calls.push({ url, init, body: JSON.parse(init.body) }); return responses.shift() }
  try { await run(calls) } finally { globalThis.fetch = original }
}

test('模板首写无视图依赖：先保存关闭规则、再启用本次新模块，返回结果进入共享草稿', async () => {
  const h = setup()
  await withFetch([ok(snapshot()), ok({ enabled: ['blank'] }), ok(snapshot([{ ...rule, id: 'budget-2' }]))], async calls => {
    const result = await h.writer('blank', rule, true)
    assert.equal(result.ok, true)
    assert.equal(result.moduleEnabled, true)
    assert.equal(h.refreshes, 1)
    assert.deepEqual(calls[0].body, { expectedModuleId: 'blank', expectedRulesAbsent: true, createRule: rule })
    assert.equal(calls[0].init.headers[EDIT_TARGET_HEADER], 'blank')
    assert.match(calls[1].url, /\/module-enable$/)
    assert.deepEqual(calls[1].body, { id: 'blank', enabled: true })
    const draft = h.drafts.rules.get('blank')
    assert.equal(draft.loaded, true)
    assert.equal(draft.entries[0].value.enabled, false)
    const second = createTemplateRuleWriter({ drafts: h.drafts, modules: () => [module('blank', [])], changed() {}, markDeclared() {}, enqueue: task => task(), actions: createModuleActions({ enqueue: task => task(), refresh: async () => true }) })
    assert.equal((await second('blank', rule)).ok, true)
    assert.equal(Object.hasOwn(calls[2].body, 'expectedRulesAbsent'), false, '首写事实跨调用方保留，不信陈旧声明')
    assert.equal(calls.length, 3)
  })
})

test('模板拒绝与启用失败：失败不启用，成功不重放，既有关闭/未知声明目标保持原策略', async () => {
  const h = setup([module('existing'), { ...module('readonly', []), facts: { editable: false } }])
  await withFetch([failure('rules-conflict', '首写冲突'), ok(snapshot()), failure('module-enable-rejected', '启用失败'), ok(snapshot())], async calls => {
    assert.equal((await h.writer('readonly', rule)).ok, false)
    assert.equal(calls.length, 0)
    assert.equal((await h.writer('blank', rule, true)).ok, false)
    assert.equal(calls.length, 1)
    const result = await h.writer('blank', rule, true)
    assert.equal(result.ok, true)
    assert.equal(result.moduleEnableError, '启用失败')
    assert.equal(calls[1].body.expectedRulesAbsent, true)
    assert.equal(h.refreshes, 0)
    assert.equal((await h.writer('existing', rule)).ok, true)
    assert.equal(Object.hasOwn(calls[3].body, 'expectedRulesAbsent'), false)
    assert.equal(calls.filter(call => call.url.endsWith('/module-enable')).length, 1)
  })
  const existing = setup([module('later-existing', [])])
  await withFetch([failure('rules-conflict', 'first failed'), ok(snapshot())], async calls => {
    assert.equal((await existing.writer('later-existing', rule, true)).ok, false)
    assert.equal((await existing.writer('later-existing', rule)).ok, true)
    assert.equal(calls.length, 2, '新的选择意图把它当既有目标，不能继承上次失败的新建启用意图')
  })
})

test('模板已保存但发布待处理：离页后仍保留结果和原输入，重试仅发布不重复创建', async () => {
  const h = setup([module('module-a', ['rules'])])
  const draft = getRulesDraft(h.drafts, 'module-a')
  draft.loaded = true; draft.saved = [rule]; draft.revisions = snapshot().revisions
  draft.entries = [{ key: 'stable', previousId: 'budget', value: { ...rule, name: 'local edit' } }]
  draft.fields.set('stable:raw', { source: '', text: 'incomplete', error: 'keep' })
  const next = { ...rule, id: 'new' }
  await withFetch([ok(snapshot([rule, next], { publicationPending: true, publicationError: 'publish failed' }))], async calls => {
    const result = await h.writer('module-a', next)
    assert.equal(result.ok, true, '持久化成功不可伪报失败导致重复创建')
    assert.equal(result.localConflict, true, '成功保存但未接纳本地草稿须另行提示')
    assert.equal(draft.entries[0].value.name, 'local edit')
    assert.equal(draft.fields.get('stable:raw').text, 'incomplete')
    assert.equal(draft.remote.rules[1].id, 'new')
    assert.equal(draft.publicationPending, true)
    assert.equal(calls.length, 1)
  })
  const requests = []
  const editor = createRuleEditor('module-a', draft, { changed() {}, isCurrent: () => true, enqueue: (_id, task) => task(), request: async body => { requests.push(body); return { ok: true, value: snapshot([rule, next]) } } })
  assert.equal(await editor.retryPublication(), true)
  assert.deepEqual(requests, [{ expectedModuleId: 'module-a', refreshOnly: true }])
  assert.equal(draft.entries[0].value.name, 'local edit')
})
