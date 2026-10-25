import test from 'node:test'
import assert from 'node:assert/strict'
import { createWorkspaceDrafts } from '../../src/client/data/workspace-drafts.ts'
import { createToolsEditor } from '../../src/client/data/tools-editor.ts'

const tool = (id, extra = {}) => ({ id, name: id, description: '', execute: { kind: 'shell', command: '' }, ...extra })
const ok = (customTools) => ({ ok: true, value: { customTools } })
const fail = (message) => ({ ok: false, code: 'custom-tools-rejected', message })

function draftOf(moduleId) {
  const drafts = createWorkspaceDrafts()
  const draft = { tools: [], saved: [], expanded: new Set(), fields: new Map(), loaded: false, error: '', saving: false, latest: 0 }
  drafts.tools.set(moduleId, draft)
  return draft
}

function harness(request) {
  const draft = draftOf('module-a')
  const calls = []
  let current = true
  const editor = createToolsEditor('module-a', draft, {
    reader: { load: () => request({ expectedModuleId: 'module-a' }) },
    request: async body => { calls.push(structuredClone(body)); return request(body) },
    isCurrent: () => current,
    changed: () => {},
  })
  return { draft, editor, calls, leave: () => { current = false } }
}

test('tools owner：读取落地草稿，迟到应答不落地也不改状态', async () => {
  const pending = []
  const h = harness(() => new Promise(resolve => pending.push(resolve)))
  const slow = h.editor.load()
  const fast = h.editor.load()
  assert.equal(pending.length, 2, '两次读都已发出（loaded 仍为 false）')
  pending[1](ok([tool('second')]))
  assert.equal(await fast, true)
  assert.deepEqual(h.draft.tools.map(item => item.id), ['second'])
  assert.equal(h.draft.loaded, true)
  pending[0](ok([tool('first')]))
  assert.equal(await slow, false)
  assert.deepEqual(h.draft.tools.map(item => item.id), ['second'], '迟到的应答不覆盖已落地的读数')
})

test('tools owner：读期间用户改过草稿时不覆盖；读失败保草稿并写错误', async () => {
  let resolveLoad
  const draft = draftOf('module-a')
  const editor = createToolsEditor('module-a', draft, {
    reader: { load: () => new Promise(resolve => { resolveLoad = resolve }) },
    request: async () => fail('unused'),
    isCurrent: () => true,
    changed: () => {},
  })
  const loading = editor.load()
  editor.mutate([tool('mine')])
  resolveLoad(ok([tool('server')]))
  assert.equal(await loading, true)
  assert.deepEqual(draft.tools.map(item => item.id), ['mine'], '读期间的用户输入优先')

  const failing = draftOf('module-b')
  const editorB = createToolsEditor('module-b', failing, {
    reader: { load: () => Promise.resolve(fail('模块未声明')) },
    request: async () => fail('unused'),
    isCurrent: () => true,
    changed: () => {},
  })
  assert.equal(await editorB.load(), false)
  assert.equal(failing.error, '模块未声明')
  assert.deepEqual(failing.tools, [], '读失败不改草稿')
})

test('tools owner：保存做空 key 清理；失败保草稿且不污染 error', async () => {
  const h = harness(async (body) => ok(body.customTools === undefined ? [tool('server')] : [tool('saved')]))
  await h.editor.load()
  h.editor.mutate([tool('draft', { parameters: { '': '待编辑行', keep: 1 } })])
  h.editor.applyPatch(0, { id: 'renamed' })
  assert.equal(h.draft.tools[0].id, 'renamed', 'applyPatch 改草稿')
  const saved = await h.editor.save()
  assert.equal(saved.ok, true)
  assert.deepEqual(h.calls[0].customTools, [tool('renamed', { name: 'draft', parameters: { keep: 1 } })], '空 key 待编辑行在保存前清理')
  assert.equal(h.draft.saving, false, '保存结束清 saving')

  const failing = harness(async (body) => body.customTools === undefined ? ok([]) : fail('写失败'))
  failing.draft.tools = [tool('kept')]
  failing.draft.loaded = true
  const rejected = await failing.editor.save()
  assert.equal(rejected.ok, false)
  assert.equal(failing.draft.error, '', '保存失败不写草稿 error（提示由调用方给）')
  assert.deepEqual(failing.draft.tools.map(item => item.id), ['kept'], '保存失败保住草稿')
  assert.equal(failing.draft.saving, false, '保存失败也要清 saving')
})

test('tools owner：已卸载（isCurrent 为假）时应答不落地', async () => {
  let resolveLoad
  const draft = draftOf('module-a')
  const editor = createToolsEditor('module-a', draft, {
    reader: { load: () => new Promise(resolve => { resolveLoad = resolve }) },
    request: async () => ok([]),
    isCurrent: () => false,
    changed: () => {},
  })
  const loading = editor.load()
  resolveLoad(ok([tool('late')]))
  assert.equal(await loading, false)
  assert.deepEqual(draft.tools, [], '卸载后应答不落地')
  assert.equal(draft.loaded, false, '卸载后不改 loaded')
})
test('tools owner：发布重试只发 refreshOnly，不重写工具定义', async () => {
  const h = harness(async () => ok([]))
  h.draft.loaded = true
  h.draft.publicationPending = true
  const result = await h.editor.retryPublication()
  assert.equal(result.ok, true)
  assert.deepEqual(h.calls.at(-1), { expectedModuleId: 'module-a', refreshOnly: true })
  assert.equal(h.draft.publicationPending, false)
})

test('tools owner：insertTemplate 走同一读守卫，失败写 error，重复不插入', async () => {
  const failingDraft = draftOf('module-a')
  let changed = 0
  const failing = createToolsEditor('module-a', failingDraft, {
    reader: { load: () => Promise.resolve(fail('读失败')) },
    request: async () => fail('unused'),
    isCurrent: () => true,
    changed: () => { changed += 1 },
  })
  assert.equal(await failing.insertTemplate({ id: 'tpl' }), 'failed')
  assert.equal(failingDraft.error, '读失败', '模板入口与卡内 load 共用错误落点')
  assert.ok(changed > 0, '错误落点触发视图 refresh')

  const draft = draftOf('module-a')
  let reads = 0
  const editor = createToolsEditor('module-a', draft, {
    reader: { load: () => { reads += 1; return Promise.resolve(ok([tool('server')])) } },
    request: async () => fail('unused'),
    isCurrent: () => true,
    changed: () => {},
  })
  assert.equal(await editor.insertTemplate({ id: 'tpl' }), 'inserted')
  assert.deepEqual(draft.tools.map(item => item.id), ['server', 'tpl'])
  assert.equal(await editor.insertTemplate({ id: 'tpl' }), 'duplicate')
  assert.equal(reads, 1, '重复插入不再读')
  assert.deepEqual(draft.tools.map(item => item.id), ['server', 'tpl'])
})
