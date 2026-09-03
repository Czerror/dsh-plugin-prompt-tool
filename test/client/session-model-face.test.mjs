import { test } from 'node:test'
import assert from 'node:assert/strict'
// lib/client.js 是宿主 ModuleLoader 注册格式（不可 import）；Node 26 直接类型剥离加载 .ts 源。
import { createSessionModelFace } from '../../src/client/session-model-face.ts'

/** 构造结构 mock：list 快照 + binding 投影 + 子代理地址 + selectModel 记录。 */
function mockSessions() {
  const state = { current: undefined }
  const listListeners = new Set()
  const projections = new Map()
  return {
    state,
    projections,
    list: {
      getSnapshot: () => ({ current: state.current }),
      subscribe: (listener) => { listListeners.add(listener); return () => listListeners.delete(listener) },
    },
    binding: (id) => projections.has(id)
      ? { session: { projections: { faceOf: () => projections.get(id) } } }
      : undefined,
    subagentAddress: (id) => (id === 'sub-1' ? { parent: 'p' } : undefined),
    emitList: () => { for (const listener of listListeners) listener() },
  }
}

function mockProjection(initial) {
  const listeners = new Set()
  return {
    value: initial,
    getSnapshot() { return this.value },
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
    push(next) { this.value = next; for (const listener of listeners) listener() },
    listenerCount: () => listeners.size,
  }
}

test('session-model-face：无活动会话不可切换，select 直接抛错', async () => {
  const sessions = mockSessions()
  const calls = []
  const face = createSessionModelFace(sessions, (request) => { calls.push(request); return Promise.resolve({ ok: true }) })
  assert.deepEqual(face.snapshot(), { selectable: false })
  await assert.rejects(() => face.select({ provider: 'p', model: 'm' }), /没有活动会话/)
  assert.equal(calls.length, 0, '无会话不得发 selectModel')
})

test('session-model-face：显示 = 投影 next；子代理会话 selectable=false', () => {
  const sessions = mockSessions()
  sessions.state.current = 's1'
  sessions.projections.set('s1', mockProjection({ next: { provider: 'deepseek', model: 'v4-flash', reasoningEffort: 'high' } }))
  const face = createSessionModelFace(sessions, () => Promise.resolve({ ok: true }))
  assert.deepEqual(face.snapshot(), {
    sessionId: 's1',
    selectable: true,
    selection: { provider: 'deepseek', model: 'v4-flash', reasoningEffort: 'high' },
  })
  sessions.state.current = 'sub-1'
  sessions.projections.set('sub-1', mockProjection(undefined))
  const view = face.snapshot()
  assert.equal(view.sessionId, 'sub-1')
  assert.equal(view.selectable, false, '子代理会话不支持会话级切换')
  assert.equal(view.selection, undefined, '投影缺省时 selection 为 undefined（调用方回退宿主默认）')
})

test('session-model-face：投影 next 缺 provider/model 视为无会话级选择', () => {
  const sessions = mockSessions()
  sessions.state.current = 's1'
  sessions.projections.set('s1', mockProjection({ next: { provider: 'deepseek' } }))
  const face = createSessionModelFace(sessions, () => Promise.resolve({ ok: true }))
  assert.equal(face.snapshot().selection, undefined)
})

test('session-model-face：快照引用稳定（值不变复用旧引用，uSES 不死循环）', () => {
  const sessions = mockSessions()
  sessions.state.current = 's1'
  sessions.projections.set('s1', mockProjection({ next: { provider: 'p', model: 'm' } }))
  const face = createSessionModelFace(sessions, () => Promise.resolve({ ok: true }))
  const first = face.snapshot()
  assert.equal(face.snapshot(), first, '值不变必须复用同一引用')
  sessions.projections.get('s1').value = { next: { provider: 'p', model: 'm', reasoningEffort: 'max' } }
  const second = face.snapshot()
  assert.notEqual(second, first, '值变化必须换引用')
  assert.equal(second.selection.reasoningEffort, 'max')
})

test('session-model-face：订阅覆盖会话切换与投影帧；退订后全部静默', () => {
  const sessions = mockSessions()
  sessions.state.current = 's1'
  sessions.projections.set('s1', mockProjection(undefined))
  sessions.projections.set('s2', mockProjection(undefined))
  const face = createSessionModelFace(sessions, () => Promise.resolve({ ok: true }))
  let fired = 0
  const unsubscribe = face.subscribe(() => { fired += 1 })
  sessions.projections.get('s1').push({ next: { provider: 'p', model: 'm' } })
  assert.equal(fired, 1, '当前会话投影帧触发')
  sessions.state.current = 's2'
  sessions.emitList()
  assert.equal(fired, 2, '会话切换触发')
  assert.equal(sessions.projections.get('s1').listenerCount(), 0, '旧会话投影必须退订')
  sessions.projections.get('s2').push({ next: { provider: 'p', model: 'm2' } })
  assert.equal(fired, 3, '新会话投影帧触发')
  unsubscribe()
  sessions.projections.get('s2').push({ next: { provider: 'p', model: 'm3' } })
  sessions.emitList()
  assert.equal(fired, 3, '退订后全部静默')
})

test('session-model-face：select 透传会话与选择；remote 失败抛出 code:message', async () => {
  const sessions = mockSessions()
  sessions.state.current = 's1'
  const calls = []
  const ok = createSessionModelFace(sessions, (request) => { calls.push(request); return Promise.resolve({ ok: true }) })
  await ok.select({ provider: 'p', model: 'm', reasoningEffort: 'low' })
  assert.deepEqual(calls, [{ sessionId: 's1', provider: 'p', model: 'm', reasoningEffort: 'low' }])
  const failing = createSessionModelFace(sessions, () => Promise.resolve({ ok: false, error: { code: 'session/model-unavailable', message: 'no such route' } }))
  await assert.rejects(() => failing.select({ provider: 'p', model: 'm' }), /session\/model-unavailable: no such route/)
})
