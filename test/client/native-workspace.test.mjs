import test from 'node:test'
import assert from 'node:assert/strict'
import { createNativeWorkspaceState } from '../../src/client/app/workbench/native-workspace-state.ts'
import { createWorkspaceStoreHolder } from '../../src/client/data/workspace-state.ts'
import { renderElement, withSsr } from './support/ssr-render.mjs'

const { usePromptToolStore } = await withSsr([new URL('../../src/client/data/use-prompt-tool-store.ts', import.meta.url).href])
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

test('原生入口共用会话浏览状态，关闭保留草稿导航且后台会话不接管', () => {
  const state = createNativeWorkspaceState()
  const closeLeft = state.mount(Symbol(), 'a')
  const view = state.view('a')
  view.select('modules')
  view.browse.tools.query = 'tool'
  const closeRight = state.mount(Symbol(), 'a')
  closeLeft()
  assert.deepEqual(state.getSnapshot(), { active: true, sessionId: 'a' })
  closeRight()
  assert.equal(state.getSnapshot().active, false)
  const closeB = state.mount(Symbol(), 'b')
  assert.equal(state.view('b').getSnapshot(), 'features')
  closeB()
  state.mount(Symbol(), 'a')
  assert.equal(state.view('a').getSnapshot(), 'modules')
  assert.equal(state.view('a').browse.tools.query, 'tool')
  state.dispose()
})

test('共享工作台只读一次且视图退订不丢原始草稿、在途保存结果', async () => {
  const original = globalThis.fetch
  const response = deferred(), saving = deferred()
  let reads = 0
  globalThis.fetch = async () => { reads++; await response.promise; return { status: 200, text: async () => JSON.stringify({ ok: true, value: { value: { modulesEnabled: false }, base: {}, revision: 1 }, meta: { meta: { layers: [], modules: [] } } }) } }
  try {
    const calls = []
    const settings = {
      ensure: async () => {},
      scope: { getSnapshot: () => ({ status: 'ready', revision: 1 }), subscribe: () => () => {} },
      mutate: async ops => { calls.push(ops); await saving.promise },
    }
    let store
    function Owner({ active }) { store = usePromptToolStore({ currentSessionId: () => 'a' }, settings, active); return null }
    renderElement(Owner, { active: false })
    await store.load()
    assert.equal(reads, 0, '未展示的owner不读取配置')
    renderElement(Owner, { active: true })
    const holder = createWorkspaceStoreHolder()
    holder.publish(store)
    const stop = holder.subscribe(() => {})
    const left = holder.getSnapshot(), right = holder.getSnapshot()
    const a = left.load(), b = right.load()
    assert.equal(reads, 1, '两个入口只有一个bootstrap')
    response.resolve()
    await Promise.all([a, b])
    left.editorDrafts.fields.set('m:param:x', { source: '1', text: '{', error: 'unfinished' })
    left.patch({ modulesEnabled: true })
    const saved = left.persistSwitches()
    stop()
    saving.resolve()
    assert.equal(await saved, true)
    assert.deepEqual(calls, [[{ op: 'set', path: ['modulesEnabled'], value: true }]])
    assert.equal(holder.getSnapshot().editorDrafts.fields.get('m:param:x').text, '{')
    assert.equal(holder.getSnapshot().getFields().modulesEnabled, true)
    holder.dispose()
  } finally { globalThis.fetch = original }
})
