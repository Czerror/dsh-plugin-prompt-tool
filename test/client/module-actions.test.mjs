import test from 'node:test'
import assert from 'node:assert/strict'
import { createModuleActions } from '../../src/client/data/module-actions.ts'
import { createSerialTaskQueue } from '../../src/client/data/save-queue.ts'
import { EDIT_TARGET_HEADER } from '../../src/shared/bridge-contract.ts'

async function harness(run, refreshResult = true) {
  const original = globalThis.fetch, calls = [], events = []
  let response = { ok: true, value: { id: 'blank', enabled: ['blank'], name: '新名', revision: 'v2' } }
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), headers: init.headers }); events.push(url.split('/').at(-1))
    return new Response(JSON.stringify(response))
  }
  const queue = createSerialTaskQueue()
  const actions = createModuleActions({ enqueue: task => queue.enqueue(task), refresh: async () => { events.push('refresh'); return refreshResult } })
  try { await run({ actions, calls, events, respond: value => { response = value } }) } finally { globalThis.fetch = original }
}

test('模块操作：创建/复制/启停/改名/删除各自保持公开载荷，串行完成后才刷新', async () => {
  await harness(async ({ actions, calls, events }) => {
    const creating = actions.create()
    const repeated = actions.create()
    await Promise.all([creating, repeated, actions.duplicate('source'), actions.enable('source', true), actions.enable('source', false)])
    await actions.rename('source', '新名', 'v1')
    await actions.remove('source')
    assert.deepEqual(calls.map(call => call.body), [
      { id: 'blank', autoSuffix: true }, { id: 'source' }, { id: 'source', enabled: true }, { id: 'source', enabled: false },
      { name: '新名', expectedRevision: 'v1', expectedModuleId: 'source' }, { id: 'source' },
    ])
    assert.equal(calls[4].headers[EDIT_TARGET_HEADER], 'source')
    assert.deepEqual(events, ['module-clone', 'refresh', 'module-duplicate', 'refresh', 'module-enable', 'refresh', 'module-enable', 'refresh', 'module-name', 'refresh', 'module-delete', 'refresh'])
  })
})

test('模块操作：写入拒绝不刷新，后续操作继续；只读名称和打开目录不触发重载', async () => {
  await harness(async ({ actions, respond, events }) => {
    respond({ ok: false, code: 'module-name-conflict', message: 'stale' })
    assert.equal((await actions.rename('module-a', 'new', 'old')).code, 'module-name-conflict')
    assert.deepEqual(events, ['module-name'])
    respond({ ok: true, value: { name: '名称', revision: 'v1' } })
    assert.equal((await actions.readName('module-a')).ok, true)
    assert.equal((await actions.open('module-a')).ok, true)
    assert.equal(events.includes('refresh'), false)
    assert.equal((await actions.clone('builtin')).ok, true)
    assert.equal(events.at(-1), 'refresh')
  })
})

test('模块操作：已写入但刷新失败保留成功结果，不能重复创建；已保存发布错误完整保留', async () => {
  await harness(async ({ actions, calls, respond }) => {
    const created = await actions.create()
    assert.equal(created.ok, true)
    assert.equal(created.value.id, 'blank')
    assert.equal(typeof created.refreshError, 'string')
    assert.equal(calls.length, 1)
    respond({ ok: true, value: { name: '新名', revision: 'v2', persisted: true, publicationPending: true, publicationError: 'pending' } })
    const renamed = await actions.rename('blank', '新名', 'v1')
    assert.equal(renamed.ok, true)
    assert.deepEqual(renamed.publication, { pending: true, error: 'pending' })
    assert.equal(typeof renamed.refreshError, 'string')
    assert.equal(calls.length, 2)
    respond({ ok: true, value: { id: 'blank', enabled: ['blank'], persisted: true, publicationPending: true, publicationError: '更改已保存，但发布失败' } })
    const pending = await actions.enable('blank', true)
    assert.equal(pending.ok, true, '已写盘的发布失败不再伪装成整体失败')
    assert.deepEqual(pending.publication, { pending: true, error: '更改已保存，但发布失败' })
    assert.equal(typeof pending.refreshError, 'string')
    assert.equal(calls.length, 3)
  }, false)
})

test('模块操作：refreshOnly 重试只发重建意图，不重跑写入', async () => {
  await harness(async ({ actions, calls }) => {
    await actions.retryEnable()
    await actions.retryClone('source')
    await actions.retryDelete('source')
    await actions.retryName('source')
    assert.deepEqual(calls.map(call => call.body), [
      { refreshOnly: true },
      { id: 'source', refreshOnly: true },
      { id: 'source', refreshOnly: true },
      { refreshOnly: true, expectedModuleId: 'source' },
    ])
    assert.equal(calls[3].headers[EDIT_TARGET_HEADER], 'source')
  })
})
