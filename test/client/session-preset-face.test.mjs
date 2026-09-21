import { test } from 'node:test'
import assert from 'node:assert/strict'
// lib/client.js 是宿主 ModuleLoader 注册格式（不可 import）；Node 26 直接类型剥离加载 .ts 源。
import { createSessionPresetFace } from '../../src/client/data/session-preset-face.ts'

/** 构造结构 mock：当前会话来源 + 该会话的 agentPreset 投影。 */
function mockSessions() {
  const state = { current: undefined }
  const currentListeners = new Set()
  const projections = new Map()
  return {
    state,
    projections,
    currentSessionId: () => state.current,
    subscribeCurrent: (listener) => { currentListeners.add(listener); return () => currentListeners.delete(listener) },
    binding: (id) => projections.has(id)
      ? { session: { projections: { faceOf: (key) => { if (key !== 'agentPreset') throw new Error(`unknown projection ${key}`); return projections.get(id) } } } }
      : undefined,
    emitCurrentChange: () => { for (const listener of currentListeners) listener() },
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

test('session-preset-face：无会话、无记录或投影值非字符串都读作 undefined', () => {
  const sessions = mockSessions()
  const face = createSessionPresetFace(sessions)
  assert.equal(face.snapshot(), undefined, '无当前会话')
  sessions.state.current = 's1'
  assert.equal(face.snapshot(), undefined, '会话没有绑定（列表快照尚未包含）')
  sessions.projections.set('s1', mockProjection(null))
  assert.equal(face.snapshot(), undefined, '投影 null = 未记录预设')
  sessions.projections.set('s1', mockProjection(''))
  assert.equal(face.snapshot(), undefined, '空串不当作预设 id')
  sessions.projections.set('s1', mockProjection(42))
  assert.equal(face.snapshot(), undefined, '非字符串不当作预设 id')
  sessions.projections.set('s1', mockProjection('pt-standard'))
  assert.equal(face.snapshot(), 'pt-standard')
})

test('session-preset-face：投影不存在或读取抛错时按无记录处理（宿主未装 agent-presets）', () => {
  const throwing = {
    currentSessionId: () => 's1',
    subscribeCurrent: () => () => {},
    binding: () => ({ session: { projections: { faceOf: () => { throw new Error('unknown projection') } } } }),
  }
  assert.doesNotThrow(() => createSessionPresetFace(throwing).snapshot())
  assert.equal(createSessionPresetFace(throwing).snapshot(), undefined)
})

test('session-preset-face：订阅覆盖会话切换与该会话投影帧；旧会话退订，退订后静默', () => {
  const sessions = mockSessions()
  sessions.state.current = 's1'
  sessions.projections.set('s1', mockProjection('a'))
  sessions.projections.set('s2', mockProjection('b'))
  const face = createSessionPresetFace(sessions)
  let fired = 0
  const unsubscribe = face.subscribe(() => { fired += 1 })
  sessions.projections.get('s1').push('a2')
  assert.equal(fired, 1, '当前会话投影帧触发')
  assert.equal(face.snapshot(), 'a2', '读取同一投影的最新值')
  sessions.state.current = 's2'
  sessions.emitCurrentChange()
  assert.equal(fired, 2, '会话切换触发')
  assert.equal(sessions.projections.get('s1').listenerCount(), 0, '旧会话投影必须退订')
  sessions.projections.get('s2').push('b2')
  assert.equal(fired, 3, '新会话投影帧触发')
  unsubscribe()
  sessions.projections.get('s2').push('b3')
  sessions.emitCurrentChange()
  assert.equal(fired, 3, '退订后全部静默')
})
