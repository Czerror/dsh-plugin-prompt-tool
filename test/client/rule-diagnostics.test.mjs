import test from 'node:test'
import assert from 'node:assert/strict'

const response = (identityOutcome = 'matched', dropped) => new Response(JSON.stringify({ ok: true, value: { records: [{ moduleId: 'm', ruleId: 'r', channel: 'persona:identity:preset', hit: 0, miss: 0, unavailable: 0, error: 0, identityOutcome }], ...(dropped === undefined ? {} : { dropped }) } }))

test('手动诊断只执行一次，忙时重复调用复用在途请求', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const pending = [], oldFetch = globalThis.fetch
  globalThis.fetch = async () => new Promise(resolve => pending.push(resolve))
  try {
    const { createRuleDiagnosticsSession } = await import('../../src/client/data/rule-diagnostics-session.ts')
    const session = createRuleDiagnosticsSession()
    const unsubscribe = session.subscribe(() => {})
    session.invalidate()
    t.mock.timers.tick(10_000)
    assert.equal(pending.length, 0, '挂载、订阅和配置变化都不能自动诊断')
    const first = session.run(), second = session.run()
    assert.equal(pending.length, 1)
    pending[0](response()); assert.equal(await first, true); assert.equal(await second, true)
    assert.equal(session.getSnapshot().status, 'ready')
    assert.equal(session.getSnapshot().configs, undefined, '缺配置段不是零配置')
    assert.equal(session.getSnapshot().dropped, 0)
    t.mock.timers.tick(10_000)
    assert.equal(pending.length, 1, '完成后不安排轮询或补发')
    const combined = session.run('session-a')
    assert.equal(pending.length, 3, '一次操作读取规则与当前会话上下文各一次')
    pending[1](response())
    pending[2](new Response(JSON.stringify({ ok: true, value: { records: [{ id: 'context-a', stage: 'selected', reason: 'match' }], truncated: false } })))
    await combined
    assert.equal(session.getSnapshot().context.sessionId, 'session-a')
    assert.equal(session.getSnapshot().context.records[0].id, 'context-a')
    const partial = session.run('session-a')
    pending[3](response())
    pending[4](new Response(JSON.stringify({ ok: false, message: 'context unavailable' })))
    assert.equal(await partial, false, '任一诊断失败都不把统一操作报告为全成功')
    assert.equal(session.getSnapshot().context.records[0].id, 'context-a')
    assert.equal(session.getSnapshot().context.error, 'context unavailable')
    const other = session.run('session-b')
    pending[5](response())
    pending[6](new Response(JSON.stringify({ ok: false, message: 'not ready' })))
    assert.equal(await other, false)
    assert.equal(session.getSnapshot().context.sessionId, 'session-b')
    assert.deepEqual(session.getSnapshot().context.records, [], '另一会话不能继承旧上下文结果')
    unsubscribe(); session.dispose()
  } finally { globalThis.fetch = oldFetch }
})

test('诊断失败保留成功时间和记录，释放后不接纳迟到结果', async () => {
  const oldFetch = globalThis.fetch
  let resolve
  try {
    const { createRuleDiagnosticsSession } = await import('../../src/client/data/rule-diagnostics-session.ts')
    const session = createRuleDiagnosticsSession()
    globalThis.fetch = async () => response('matched', 3)
    assert.equal(await session.run(), true)
    const previous = session.getSnapshot()
    assert.equal(previous.dropped, 3, '三条被截断记录必须在诊断快照中保留')
    globalThis.fetch = async () => new Response(JSON.stringify({ ok: false, message: 'offline' }))
    assert.equal(await session.run(), false)
    assert.equal(session.getSnapshot().status, 'error')
    assert.equal(session.getSnapshot().diagnosedAt, previous.diagnosedAt)
    assert.deepEqual(session.getSnapshot().records, previous.records)
    assert.equal(session.getSnapshot().dropped, 3)
    globalThis.fetch = () => new Promise(done => { resolve = done })
    const request = session.run()
    session.dispose()
    resolve(response('late'))
    assert.equal(await request, false)
    assert.deepEqual(session.getSnapshot().records, previous.records)
  } finally { globalThis.fetch = oldFetch }
})

test('失效后迟到诊断结果不生效', async () => {
  const pending = [], oldFetch = globalThis.fetch
  globalThis.fetch = async () => new Promise(resolve => pending.push(resolve))
  try {
    const { createRuleDiagnosticsSession } = await import('../../src/client/data/rule-diagnostics-session.ts')
    const session = createRuleDiagnosticsSession(), first = session.run()
    pending.shift()(response()); await first
    const stale = session.run(); session.invalidate()
    assert.equal(session.getSnapshot().busy, true)
    assert.equal(session.run(), stale)
    assert.equal(pending.length, 1)
    pending.shift()(response('late')); await stale
    assert.equal(session.getSnapshot().busy, false)
    assert.equal(session.getSnapshot().status, 'stale'); assert.equal(session.getSnapshot().records[0].identityOutcome, 'matched'); session.dispose()
  } finally { globalThis.fetch = oldFetch }
})
