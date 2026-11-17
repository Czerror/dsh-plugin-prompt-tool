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
  const editor = createToolsEditor('module-a', draft, {
    reader: { load: () => request({ expectedModuleId: 'module-a' }) },
    request: async body => { calls.push(structuredClone(body)); return request(body) },
    isCurrent: () => true,
    changed: () => {},
  })
  return { draft, editor, calls }
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

test('tools owner：发布重试只发 refreshOnly，不重写工具定义', async () => {
  const h = harness(async () => ok([]))
  h.draft.loaded = true
  h.draft.publicationPending = true
  const result = await h.editor.retryPublication()
  assert.equal(result.ok, true)
  assert.deepEqual(h.calls.at(-1), { expectedModuleId: 'module-a', refreshOnly: true })
  assert.equal(h.draft.publicationPending, false)
})

test('tools owner：保存与发布重试跨视图完成，读取与模板不抢提交序号', async () => {
  const draft = draftOf('module-a')
  let active = true
  let oldNotices = 0
  let currentNotices = 0
  let reads = 0
  let resolveRead
  let resolveWrite
  let rejectWrite
  const deps = {
    reader: { load: () => { reads += 1; return new Promise(resolve => { resolveRead = resolve }) } },
    request: () => new Promise((resolve, reject) => { resolveWrite = resolve; rejectWrite = reject }),
    isCurrent: () => active,
    changed: () => { oldNotices += 1 },
  }
  const editor = createToolsEditor('module-a', draft, deps)
  const loading = editor.load()
  editor.mutate([tool('mine')])
  const saving = editor.save()
  active = false
  draft.refresh = () => { currentNotices += 1 }
  const remounted = createToolsEditor('module-a', draft, { ...deps, isCurrent: () => true })
  const noticesBefore = oldNotices
  const reloading = remounted.load()
  const inserting = remounted.insertTemplate(tool('template'))
  resolveRead(ok([tool('stale')]))
  resolveWrite({ ok: true, value: { persisted: true, publicationPending: true, publicationError: 'publish failed' } })
  const result = await saving
  assert.equal(draft.saving, false)
  assert.equal(result.ok, true)
  assert.equal(reads, 1, '重挂不启动抢序读取')
  await reloading
  assert.equal(await inserting, 'failed')
  assert.equal(await loading, false, '保存前的在途读已失效')
  assert.deepEqual(draft.saved, [tool('mine')])
  assert.equal(draft.publicationPending, true)
  assert.equal(draft.publicationError, 'publish failed')
  assert.equal(oldNotices, noticesBefore, '旧视图不再收到通知')
  assert.ok(currentNotices > 0, '完成结果通知当前视图')

  const retry = editor.retryPublication()
  await remounted.load()
  assert.equal(await remounted.insertTemplate(tool('template')), 'failed')
  resolveWrite(ok([]))
  assert.equal((await retry).ok, true)
  assert.equal(draft.saving, false)
  assert.equal(draft.publicationPending, false)
  assert.equal(draft.publicationError, undefined)

  for (const rejected of [false, true]) {
    editor.mutate([tool('kept')])
    const attempt = editor.save()
    if (rejected) rejectWrite(new Error('transport failed'))
    else resolveWrite(fail('write failed'))
    if (rejected) await assert.rejects(attempt, /transport failed/)
    else assert.equal((await attempt).ok, false)
    assert.equal(draft.saving, false, '失败与 rejection 均释放 busy')
    assert.deepEqual(draft.tools, [tool('kept')])
    assert.deepEqual(draft.saved, [tool('mine')], '失败不推进基线')
  }
})
