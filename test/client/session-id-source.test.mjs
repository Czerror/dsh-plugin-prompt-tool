import { test } from 'node:test'
import assert from 'node:assert/strict'
// lib/client.js 是宿主 ModuleLoader 注册格式（不可 import）；Node 26 直接类型剥离加载 .ts 源。
import { readCurrentSessionId, subscribeSessionIdChange } from '../../src/client/data/session-id-source.ts'

/**
 * 防复发回归：官方在 0.1.6-alpha.2 删除了 `SessionListState.current`
 * （sessions/service.d.ts 的接口只剩 ids／byId／phase／subagentsByParent／jobsBySession），
 * 客户端因此只能从 ui-session 的作用域绑定读取当前会话。
 *
 * 本文件的 mock **刻意不提供任何 list.current**：旧实现（读列表快照的 current）
 * 在这里必然拿不到会话，从而在修复前先红。
 */

/** ui-session 适配器 mock：当前作用域绑定 + 切换通知。 */
function mockAdapter(initial = {}) {
  const listeners = new Set()
  let binding = initial
  return {
    current: {
      getSnapshot: () => binding,
      subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
    },
    push(next) { binding = next; for (const listener of listeners) listener() },
  }
}

/** sessions mock：本模块只消费 scopeOf。 */
function mockSessions(resolve = () => undefined) {
  return { scopeOf: resolve }
}

test('会话 id 来源：从作用域 ctx 反查，不读列表快照', () => {
  const scopeCtx = { kind: 'agent-scope' }
  const adapter = mockAdapter({ key: 'session-abc', ctx: scopeCtx })
  const sessions = mockSessions((ctx) => (ctx === scopeCtx ? 'session-abc' : undefined))
  assert.equal(readCurrentSessionId(adapter, sessions), 'session-abc')
})

test('会话 id 来源：scopeOf 未命中时退回绑定的作用域 key', () => {
  const adapter = mockAdapter({ key: 'session-from-key', ctx: {} })
  assert.equal(readCurrentSessionId(adapter, mockSessions()), 'session-from-key')
})

test('会话 id 来源：root 绑定（无作用域 ctx 且 key 为空）返回 undefined', () => {
  assert.equal(readCurrentSessionId(mockAdapter({ key: undefined }), mockSessions()), undefined)
  assert.equal(readCurrentSessionId(mockAdapter({ key: '' }), mockSessions()), undefined)
  assert.equal(readCurrentSessionId(mockAdapter({}), mockSessions()), undefined)
})

test('会话 id 来源：绑定的 ctx 非对象时不抛错，退回 key', () => {
  assert.equal(readCurrentSessionId(mockAdapter({ key: 'session-null-ctx', ctx: null }), mockSessions()), 'session-null-ctx')
})

test('防复发：真实 alpha.2 列表快照（无 current）下仍能取到会话 id', () => {
  // 与官方 lib/types/client/sessions/service.d.ts 的 SessionListState 同形。
  const listSnapshot = { ids: [], byId: {}, phase: 'ready', subagentsByParent: {}, jobsBySession: {} }
  assert.equal(Object.hasOwn(listSnapshot, 'current'), false, 'alpha.2 形状不得含 current')
  const scopeCtx = {}
  const adapter = mockAdapter({ key: 'session-x', ctx: scopeCtx })
  const sessions = {
    scopeOf: (ctx) => (ctx === scopeCtx ? 'session-x' : undefined),
    list: { getSnapshot: () => listSnapshot },
  }
  assert.equal(readCurrentSessionId(adapter, sessions), 'session-x', '不得依赖已删除的 current')
})

test('会话 id 订阅：id 就绪时通知一次；绑定换引用与退订后都不再通知', () => {
  // 复现真实时序：工作台打开时作用域绑定还没有会话（主视图尚未 retain），
  // 之后主视图 retain 该会话，绑定才带上 id。缺这次通知，首屏就会一直停在
  // 「只有全局文件」的范围，直到用户关掉工作台重开。
  const scopeCtx = {}
  const adapter = mockAdapter({ key: undefined })
  const sessions = mockSessions((ctx) => (ctx === scopeCtx ? 'session-late' : undefined))
  let fired = 0
  const stop = subscribeSessionIdChange(adapter, sessions, () => { fired += 1 })

  assert.equal(fired, 0, '订阅时不立即通知')
  adapter.push({ key: undefined })
  assert.equal(fired, 0, 'id 未变化不得通知')

  adapter.push({ key: 'session-late', ctx: scopeCtx })
  assert.equal(fired, 1, 'id 就绪必须通知')

  adapter.push({ key: 'session-late', ctx: scopeCtx })
  assert.equal(fired, 1, '绑定换引用不得重复通知')

  adapter.push({ key: undefined })
  assert.equal(fired, 2, '会话关闭时通知')

  stop()
  adapter.push({ key: 'session-other', ctx: scopeCtx })
  assert.equal(fired, 2, '退订后静默')
})
