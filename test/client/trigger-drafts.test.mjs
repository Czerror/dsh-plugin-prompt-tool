import test from 'node:test'
import assert from 'node:assert/strict'
import { createTriggerEditor, getTriggerDraft, triggerDraftDirty } from '../../src/client/data/trigger-drafts.ts'
import { createWorkspaceDrafts, hasWorkspaceDrafts } from '../../src/client/data/workspace-drafts.ts'
import { createSerialTaskQueue } from '../../src/client/data/save-queue.ts'

const rules = (id) => [{ id, channel: 'agent/request', do: { kind: 'request-params', patch: { maxTokens: 20 } } }]
const meta = { predicates: [], actions: [], composites: [], waterfallPositions: [] }
const success = (id = 'saved', revision = 'r1') => ({ ok: true, value: { triggers: rules(id), revision, meta } })
const deferred = () => Promise.withResolvers()
function setup() {
  const drafts = createWorkspaceDrafts()
  const draft = getTriggerDraft(drafts, 'a')
  const queue = createSerialTaskQueue()
  const calls = []
  const env = { current: 'a', response: async () => success(), changes: 0 }
  const deps = {
    request: async (body) => { calls.push(body); return env.response(body) },
    enqueue: (_, task) => queue.enqueue(task),
    isCurrent: () => env.current === 'a',
    changed: () => { env.changes++ },
  }
  return { drafts, draft, queue, calls, env, deps, editor: createTriggerEditor('a', draft, deps) }
}

test('规则草稿按预设持有；切页复用，未加载不写入，读取失败不成为空白基线', async () => {
  const h = setup()
  assert.equal(await h.editor.submit(), false)
  h.env.response = async () => ({ ok: false, code: 'unavailable' })
  assert.equal(await h.editor.load(), false)
  assert.equal(h.draft.loaded, false)
  assert.equal(h.draft.error.code, 'unavailable')
  h.env.response = async () => success()
  assert.equal(await h.editor.load(), true)
  assert.equal(getTriggerDraft(h.drafts, 'a'), h.draft)
  assert.notEqual(getTriggerDraft(h.drafts, 'b'), h.draft)
  assert.equal(hasWorkspaceDrafts(h.drafts, 'a'), false)
  h.editor.patch(rules('local'))
  const remounted = createTriggerEditor('a', getTriggerDraft(h.drafts, 'a'), h.deps)
  await remounted.load()
  assert.equal(h.draft.value[0].id, 'local')
  assert.equal(hasWorkspaceDrafts(h.drafts, 'a'), true)
  assert.equal(hasWorkspaceDrafts(h.drafts, 'b'), false)
  assert.equal(h.draft.saved[0].id, 'saved')
})

test('保存只确认提交快照；保存期间继续编辑保留，空数组可显式保存', async () => {
  const h = setup()
  await h.editor.load()
  h.editor.patch(rules('first'))
  const pending = deferred()
  h.env.response = () => pending.promise
  const writing = h.editor.submit()
  await Promise.resolve()
  assert.equal(hasWorkspaceDrafts(h.drafts, 'a'), true)
  assert.deepEqual(h.calls.at(-1), { expectedPresetId: 'a', expectedRevision: 'r1', triggers: rules('first') })
  h.editor.patch(rules('second'))
  pending.resolve(success('first', 'r2'))
  assert.equal(await writing, true)
  assert.equal(h.draft.value[0].id, 'second')
  assert.equal(h.draft.saved[0].id, 'first')
  assert.equal(h.draft.revision, 'r2')
  assert.equal(triggerDraftDirty(h.draft), true)
  h.env.response = async () => ({ ok: true, value: { triggers: [], revision: 'r3', meta } })
  h.editor.patch([])
  assert.equal(await h.editor.submit(), true)
  assert.deepEqual(h.calls.at(-1).triggers, [])
  assert.equal(hasWorkspaceDrafts(h.drafts, 'a'), false)
})

test('失败与版本冲突保留输入及旧基线；其他预设字段变化允许重新读取版本', async () => {
  const h = setup()
  await h.editor.load()
  h.editor.patch(rules('local'))
  h.env.response = async () => ({ ok: false, code: 'preset-version-conflict', message: 'changed' })
  assert.equal(await h.editor.submit(), false)
  assert.equal(h.draft.value[0].id, 'local')
  assert.equal(h.draft.saved[0].id, 'saved')
  assert.equal(h.draft.revision, 'r1')
  assert.equal(h.draft.error.code, 'preset-version-conflict')
  h.env.response = async () => success('saved', 'r2')
  assert.equal(await h.editor.load(), true)
  assert.equal(h.draft.value[0].id, 'local')
  assert.equal(h.draft.revision, 'r2')
  h.env.response = async () => { throw new Error('network') }
  assert.equal(await h.editor.submit(), false)
  assert.equal(h.draft.error.message, 'network')
  assert.equal(h.draft.busy, undefined)
})

test('规则正文冲突不推进可写版本；用户明确丢弃后才接纳远端', async () => {
  const h = setup()
  await h.editor.load()
  h.editor.patch(rules('local'))
  h.env.response = async () => success('external', 'r2')
  assert.equal(await h.editor.load(), false)
  assert.equal(h.draft.value[0].id, 'local')
  assert.equal(h.draft.revision, 'r1')
  assert.equal(h.draft.error.code, 'trigger-rules-changed')
  const count = h.calls.length
  assert.equal(await h.editor.submit(), false)
  assert.equal(h.calls.length, count)
  h.editor.discard()
  assert.equal(h.draft.value[0].id, 'external')
  assert.equal(h.draft.revision, 'r2')
  assert.equal(hasWorkspaceDrafts(h.drafts, 'a'), false)
})

test('迟到读取不能覆盖后续读取或读取期间的新输入', async () => {
  const h = setup()
  const pending = deferred()
  h.env.response = () => pending.promise
  const old = h.editor.load()
  h.env.response = async () => success('new', 'r2')
  await h.editor.load()
  h.editor.patch(rules('typing'))
  pending.resolve(success('old'))
  assert.equal(await old, false)
  assert.equal(h.draft.value[0].id, 'typing')
  assert.equal(h.draft.saved[0].id, 'new')
  assert.equal(h.draft.revision, 'r2')
})

test('预设切换使队列中的写请求和迟到应答失效，不污染另一份草稿', async () => {
  const h = setup()
  await h.editor.load()
  h.editor.patch(rules('local'))
  const gate = deferred()
  const preceding = h.queue.enqueue(() => gate.promise)
  const writing = h.editor.submit()
  h.env.current = 'b'
  const other = getTriggerDraft(h.drafts, 'b')
  gate.resolve()
  await preceding
  assert.equal(await writing, false)
  assert.equal(h.calls.length, 1, '排队期间切换，不能发送旧写请求')
  h.env.current = 'a'
  const response = deferred()
  h.env.response = () => response.promise
  const late = h.editor.submit()
  await Promise.resolve()
  h.env.current = 'b'
  response.resolve(success('local', 'r2'))
  assert.equal(await late, false)
  assert.equal(h.draft.revision, 'r1')
  assert.equal(h.draft.value[0].id, 'local')
  assert.deepEqual(other.value, [])
  assert.equal(other.loaded, false)
})

test('只校验不确认保存；校验期间继续编辑不会显示陈旧成功', async () => {
  const h = setup()
  await h.editor.load()
  h.editor.patch(rules('local'))
  const response = deferred()
  h.env.response = () => response.promise
  const checking = h.editor.submit(true)
  await Promise.resolve()
  assert.equal(h.calls.at(-1).validateOnly, true)
  h.editor.patch(rules('later'))
  response.resolve(success('local'))
  assert.equal(await checking, true)
  assert.equal(h.draft.validated, false)
  assert.equal(h.draft.saved[0].id, 'saved')
  assert.equal(hasWorkspaceDrafts(h.drafts, 'a'), true)
})

test('规则输入与提示词字段互不覆盖；无效高级字段也阻止切换', async () => {
  const h = setup()
  await h.editor.load()
  h.draft.fields.set('rule:0', { source: '{}', text: '{', error: 'json' })
  h.drafts.fields.set('a:config:x', { source: 'before', text: 'after', error: '' })
  assert.equal(hasWorkspaceDrafts(h.drafts, 'a'), true)
  assert.equal(await h.editor.submit(), false)
  h.env.response = async () => success('external', 'r2')
  assert.equal(await h.editor.load(), false, '未完成 JSON 也属于草稿，不可用远端规则覆盖')
  assert.equal(h.draft.fields.get('rule:0').text, '{')
  h.editor.discard()
  assert.deepEqual(h.drafts.fields.get('a:config:x'), { source: 'before', text: 'after', error: '' })
  assert.equal(h.draft.fields.size, 0)
  assert.equal(h.draft.value[0].id, 'external')
})
