import test from 'node:test'
import assert from 'node:assert/strict'
import { createWorkspaceDrafts } from '../../src/client/data/workspace-drafts.ts'
import { createPersonaEditors } from '../../src/client/data/persona-editor.ts'

const ok = (persona, revision = 'rev-1') => ({ ok: true, value: { persona, revision } })
const fail = (message) => ({ ok: false, code: 'module-persona-rejected', message })
const t = (key) => key

/** 主语固定为 `mod-a`（`sources` 空 ⇒ `getModuleId` 回落到首选模块）。 */
function harness(request, options = {}) {
  const drafts = createWorkspaceDrafts()
  const calls = []
  let current = true
  let composing = false
  const owners = createPersonaEditors(drafts, {
    request: async (body, moduleId) => { calls.push({ body: structuredClone(body), moduleId }); return request(body, moduleId) },
    getModuleId: () => options.moduleId ?? 'mod-a',
    isCurrentSubject: (_audience, id) => (options.moduleId ?? 'mod-a') === id,
    declares: () => options.declares,
    isCurrent: () => current,
    isComposing: () => composing,
    t,
    changed: () => {},
  })
  return {
    drafts, owners, calls,
    draft: (id = options.moduleId ?? 'mod-a') => owners.editorOf(id).draft,
    leave: () => { current = false },
    setComposing: (value) => { composing = value },
  }
}

test('persona owner：读取落地草稿，迟到应答不落地也不清 loading', async () => {
  const pending = []
  const h = harness(() => new Promise(resolve => pending.push(resolve)))
  const owner = h.owners.editorOf('mod-a')
  // 第一次读：先落地（`loading` 会挡住「未完成时再发一次」，所以迟到要在它落地之后发生）。
  const first = owner.load('main')
  pending[0](ok({ main: { prefix: 'FIRST' } }, 'rev-1'))
  await first
  assert.deepEqual(h.draft().value, { main: { prefix: 'FIRST' } })
  // 第二次读（`discard` 绕过「脏就不读」）先发出，此时它才是最新的。
  const second = owner.load('main', true)
  assert.equal(h.draft().loading, true)
  // 第三次读又把序号推进一格 —— 第二次的那次应答回来时已经不是最新。
  h.draft().loading = false
  const third = owner.load('main', true)
  pending[2](ok({ main: { prefix: 'THIRD' } }, 'rev-3'))
  await third
  assert.deepEqual(h.draft().value, { main: { prefix: 'THIRD' } })
  pending[1](ok({ main: { prefix: 'SECOND' } }, 'rev-2'))
  await second
  assert.deepEqual(h.draft().value, { main: { prefix: 'THIRD' } }, '迟到的应答不覆盖已落地的读数')
  assert.equal(h.draft().revision, 'rev-3')
})

test('persona owner：读期间草稿被换过就不覆盖；已卸载不清 loading', async () => {
  const pending = []
  const h = harness(() => new Promise(resolve => pending.push(resolve)))
  const owner = h.owners.editorOf('mod-a')
  const reading = owner.load('main')
  owner.patch('main', 'prefix', 'MINE')
  pending[0](ok({ main: { prefix: 'SERVER' } }))
  await reading
  assert.deepEqual(h.draft().value, { main: { prefix: 'MINE' } }, '读期间的用户输入优先')

  const late = harness(() => new Promise(resolve => pending.push(resolve)))
  const lateOwner = late.owners.editorOf('mod-a')
  const loading = lateOwner.load('main')
  late.leave()
  pending[1](ok({ main: { prefix: 'IGNORED' } }))
  await loading
  assert.deepEqual(late.draft().value, {}, '卸载后应答不落地')
  assert.equal(late.draft().loading, true, '卸载后不清 loading（清理权归最新那次请求）')
})

test('persona owner：只改本次受众；创建模式不带 expectedRevision', async () => {
  const declared = harness(async () => ok({ main: { prefix: 'SAVED' }, subagent: { prefix: 'SUB' } }, 'rev-9'))
  const declaredOwner = declared.owners.editorOf('mod-a')
  await declaredOwner.load('main')
  declaredOwner.patch('main', 'prefix', 'EDITED')
  await declaredOwner.save('main')
  assert.deepEqual(declared.calls[1].body, { persona: { main: { prefix: 'EDITED' }, subagent: { prefix: 'SUB' } }, expectedModuleId: 'mod-a', expectedRevision: 'rev-9' }, '只覆盖本次受众，其余受众原样带上；已声明带版本')

  // 未声明 persona：首写＝创建，请求里**不能**带 expectedRevision（空版本会被服务端当非法版本拒绝）。
  const creating = harness(async () => ok({ main: { prefix: 'NEW' } }, 'rev-1'), { declares: false })
  const creatingOwner = creating.owners.editorOf('mod-a')
  await creatingOwner.load('main')
  assert.equal(creating.calls.length, 0, '未声明：这次读不构造请求')
  assert.equal(creating.draft().loaded, true, '未声明也标记 loaded（空草稿就是真值）')
  creatingOwner.patch('main', 'prefix', 'NEW')
  await creatingOwner.save('main')
  assert.equal('expectedRevision' in creating.calls[0].body, false, '创建模式不带 expectedRevision')
  assert.equal(creating.calls[0].body.persona.main.prefix, 'NEW')
})

test('persona owner：删除受众失败要抛错；续存可取消、组合期间不落盘', async () => {
  const h = harness(async (body) => body.refreshOnly === true ? ok(null) : fail('写失败'))
  const owner = h.owners.editorOf('mod-a')
  owner.draft.loaded = true
  owner.draft.saved = { main: { prefix: 'A' } }
  await assert.rejects(() => owner.save('main', true), /写失败/, '删除失败要抛错（调用方据此提示）')

  const auto = harness(async () => ok({ main: { prefix: 'AUTO' } }))
  const autoOwner = auto.owners.editorOf('mod-a')
  autoOwner.draft.loaded = true
  autoOwner.patch('main', 'prefix', 'AUTO')
  autoOwner.cancelAutoSave()
  await new Promise(resolve => setTimeout(resolve, 700))
  assert.equal(auto.calls.length, 0, '取消后续存不发请求')

  autoOwner.patch('main', 'prefix', 'AUTO2')
  await new Promise(resolve => setTimeout(resolve, 700))
  assert.equal(auto.calls.length, 1, '未取消时 600ms 后自动续存一次')

  const composing = harness(async () => ok({ main: { prefix: 'X' } }))
  const composingOwner = composing.owners.editorOf('mod-a')
  composingOwner.draft.loaded = true
  composing.setComposing(true)
  composingOwner.patch('main', 'prefix', 'COMPOSING')
  await new Promise(resolve => setTimeout(resolve, 700))
  assert.equal(composing.calls.length, 0, '输入法组合期间不自动落盘')
})
