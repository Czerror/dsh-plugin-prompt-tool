/**
 * B4 T1 —— `shared.sessionState()` 会话态统一访问接口（**步骤一：零行为变更**）。
 *
 * 本文件只钉住一件事：**把某个模块现有的会话态容器换成 `sessionState` 之后，读写结果与
 * 被清空的时机逐例不变**。因此每条用例都拿「既有写法」当 oracle 对拍，而不是断言
 * 我期望的语义——后者会把接口的错误一起固化成"预期"。
 *
 * 覆盖 PLAN 里逐条列出的三处现状差异：键类型（id / 对象身份）、淘汰策略
 * （`clear()` 全清 / `delete(最旧)` / 无上限）、复位语义（显式订阅 / 不订阅）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_TRACKED_SESSIONS, sessionMapGet, sessionState } from '../../engine/shared.mjs'

const session = (id) => ({ id, header: { delegationDepth: 0 } })
const fresh = () => ({ n: 0 })

/** 记录型 ctx：只有声明了 reset 才应出现 session/event 监听。 */
function recordingCtx() {
  const events = []
  const effects = []
  return {
    ctx: {
      on(event, handler) {
        events.push({ event, handler })
        return () => events.splice(events.findIndex((entry) => entry.handler === handler), 1)
      },
      effect(callback, label) {
        const disposer = callback()
        effects.push({ label, disposer })
        return disposer
      },
    },
    events,
    effects,
  }
}

test('按 id 索引 + 超限全清：与 sessionMapGet 的既有写法逐例一致', () => {
  // oracle：B1 收敛后的既有实现（模块里现在就是这么写的）。
  const legacyMap = new Map()
  const legacyOf = (s) => sessionMapGet(legacyMap, s.id, fresh)

  const state = sessionState(undefined, fresh)
  const migratedOf = (s) => state.get(s)

  const a = session('a')
  const b = session('b')
  for (const s of [a, b, a, b]) {
    assert.deepEqual(migratedOf(s), legacyOf(s), `读写结果须一致（${s.id}）`)
  }
  // 同一会话必须拿到同一对象（缓存的全部意义）。
  assert.equal(migratedOf(a), migratedOf(a), '同会话同条目')
  assert.notEqual(migratedOf(a), migratedOf(b), '不同会话不同条目')

  migratedOf(a).n = 7
  assert.equal(legacyOf(a).n, 0, '两条路径互不共享底层容器（各自独立实例）')
  assert.equal(migratedOf(a).n, 7)

  // 工厂只在首次取条目时执行。
  let created = 0
  const counted = sessionState(undefined, () => { created += 1; return fresh() })
  counted.get(a)
  counted.get(a)
  counted.get(b)
  assert.equal(created, 2, 'create 只在新会话首次取条目时执行')
})

test('按 id 索引：第 MAX_TRACKED_SESSIONS 个会话触发全清（与既有上限语义一致）', () => {
  for (const make of [
    () => { const map = new Map(); return { map, get: (s) => sessionMapGet(map, s.id, fresh) } },
    () => { const state = sessionState(undefined, fresh); return { map: state, get: (s) => state.get(s) } },
  ]) {
    const { get } = make()
    const first = session('first')
    get(first).n = 42
    // 填到上限：最后一条写入前 size 已达上限 → 全清后重建。
    const other = []
    for (let index = 0; index < MAX_TRACKED_SESSIONS; index += 1) {
      const s = session(`s-${index}`)
      get(s).n = index
      other.push(s)
    }
    // 未超过上限时机上仍看得到既有条目。
    assert.equal(other.length, MAX_TRACKED_SESSIONS)
    // 第 limit+1 个会话：写入前 size === limit → 全清（`first` 的 42 也没了）。
    const overflow = session('overflow')
    const entry = get(overflow)
    assert.equal(entry.n, 0, '新条目是全新的')
    assert.equal(get(first).n, 0, '全清后旧会话的条目被重建（不再保留 42）')
  }
})

test('无上限档：weak / limit:null / evict:null 三档都不淘汰，且互不串味', () => {
  for (const options of [{ weak: true }, { limit: null }, { evict: null }]) {
    const state = sessionState(undefined, fresh, options)
    const first = session('same-id')
    const second = session('same-id')   // 同 id 不同对象：只有 weak 档能区分
    state.get(first).n = 1
    state.get(second).n = 2
    assert.equal(state.get(first).n, options.weak ? 1 : 2,
      options.weak ? 'weak 按对象身份，同 id 不同对象互不影响' : '按 id 索引时同 id 共享条目（既有语义）')
    assert.equal(state.limit, null, '未声明上限时 limit 为 null（可被诊断读到）')
  }
})

test('evict: oldest 与 clear 是两档不同语义，绝不互相降级', () => {
  const oldest = sessionState(undefined, fresh, { limit: 3, evict: 'oldest' })
  const keys = ['a', 'b', 'c', 'd'].map(session)
  for (const s of keys) oldest.get(s)
  assert.equal(oldest.size(), 3, 'oldest 档只删一条，容量恒定')
  assert.equal(oldest.peek(keys[0]), undefined, '最旧的一条被删')
  assert.notEqual(oldest.peek(keys[3]), undefined, '最新的一条保留')
  assert.notEqual(oldest.peek(keys[1]), undefined, '中间条目不受影响')

  const cleared = sessionState(undefined, fresh, { limit: 3, evict: 'clear' })
  for (const s of keys) cleared.get(s)
  assert.equal(cleared.size(), 1, 'clear 档全清后只剩最后写入的一条')
  assert.equal(cleared.peek(keys[3])?.n, 0, '最后写入的是新条目')
  assert.equal(cleared.peek(keys[1]), undefined, 'clear 档连中间条目也没了（与 oldest 不等价）')
})

test('复位：缺省不订阅；声明后只删 reset 返回 true 的会话，且按字段而非按模块', () => {
  const quiet = recordingCtx()
  sessionState(quiet.ctx, fresh)
  assert.deepEqual(quiet.events.map((entry) => entry.event), [], '未声明 reset 时不注册任何监听（零开销）')

  const wired = recordingCtx()
  const state = sessionState(wired.ctx, fresh, {
    // 字段级：只有成功的压缩才复位本字段。
    reset: (_session, event) => event?.type === 'compaction/end' && event?.data?.ok === true,
  })
  assert.deepEqual(wired.events.map((entry) => entry.event), ['session/event'], '声明后注册一条')
  assert.equal(wired.effects.length, 1, 'disposer 交 keepDisposer（随 fiber 释放）')

  const s = session('s-1')
  state.get(s).n = 5
  const handler = wired.events[0].handler
  handler(s, { type: 'compaction/end', data: { ok: false } })
  assert.equal(state.peek(s).n, 5, '失败压缩不复位（既有纪律）')
  handler(s, { type: 'assistant/message', data: {} })
  assert.equal(state.peek(s).n, 5, '无关事件不复位')
  handler(s, { type: 'compaction/end', data: { ok: true } })
  assert.equal(state.peek(s), undefined, '成功压缩后条目被删除（下次取值走冷扫重建）')

  // reset 抛错不得影响事件流上的其它监听器。
  const boom = recordingCtx()
  const broken = sessionState(boom.ctx, fresh, { reset: () => { throw new Error('reset blew up') } })
  const target = session('s-2')
  broken.get(target)
  assert.doesNotThrow(() => boom.events[0].handler(target, { type: 'compaction/end' }), '复位抛错被吞掉')
  assert.notEqual(broken.peek(target), undefined, '抛错时不做删除（不猜测复位是否发生）')
})

test('弱化键：weak 档不暴露 size/keys（无上限的容器没有这两个概念）', () => {
  const weak = sessionState(undefined, fresh, { weak: true })
  assert.equal(Number.isNaN(weak.size()), true, 'size 返回 NaN 而不是假装有界')
  assert.deepEqual(weak.keys(), [], 'keys 为空数组')
  assert.doesNotThrow(() => weak.clear(), 'clear 是空操作而不是抛错（调用方不必分档）')
})

test('无 id 的会话不记账（与 predicates 的既有决定一致），每次都是新条目', () => {
  const state = sessionState(undefined, fresh)
  const anonymous = { header: {} }
  assert.equal(state.peek(anonymous), undefined, '无 id 不缓存')
  assert.equal(state.get(anonymous), undefined, '无 id 取不到条目（调用方须自行兜底，见 predicates:343）')
  assert.equal(state.set(anonymous, fresh()), undefined, '无 id 写不进容器')
  assert.equal(state.size(), 0, '无 id 的会话不写入容器')
  assert.equal(state.delete(anonymous), false, '删除同样不记账')
  assert.equal(state.get(undefined), undefined, 'undefined 会话不抛错')
})

test('无 id 的会话在 weak 档同样不记账（键是会话对象本身，但对象缺失仍不写）', () => {
  const state = sessionState(undefined, fresh, { weak: true })
  assert.equal(state.get(undefined), undefined, 'undefined 不抛错')
  const anonymous = { header: {} }
  // weak 档按对象身份：没有 id 也能记账（这正是 weak 与 id 档的语义差异）。
  assert.deepEqual(state.get(anonymous), { n: 0 }, 'weak 档不需要 session.id')
})
