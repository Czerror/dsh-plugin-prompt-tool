/**
 * T4 —— `engine/history.mjs` 的两个历史视图（`historyEvents` / `currentEvents`）。
 *
 * 钉住的语义：
 *  - 视图②（完整历史）= `snapshotEvents()` 的全量快照；缺接口 / 快照非数组一律降级为空日志；
 *  - 视图①（当前上下文）按 surface `nodes` 序返回对应事件，`nodes` 空数组 = 空上下文（不降级）；
 *  - 视图①在无 surface / `nodes` 非数组 / 节点越界时退回视图②（等价旧行为）；
 *  - 两个视图都是纯函数：不缓存、不改写输入。
 *
 * 真值源：DSH `packages/core/session/src/index.ts:631`（`eventAt(seq)` 即 `log[seq]`）与
 * `:645`（`snapshotEvents()` 返回 [0, seq) 的完整切片）—— seq 就是 log 下标；
 * 期望值全部是手算字面量。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { historyEvents, currentEvents } from '../../engine/history.mjs'

const log = [
  { type: 'turn/start' },
  { type: 'user/message' },
  { type: 'assistant/message' },
  { type: 'tool/call' },
]

/** 桩：`log[seq]` 是 seq → 事件的真值源；`surfaceNodes` 为 undefined 表示宿主无 surface。 */
const stub = ({ log: events = log, surfaceNodes, surface } = {}) => {
  const hostSurface = surface ?? (surfaceNodes === undefined ? undefined : { nodes: surfaceNodes })
  return { ...(hostSurface === undefined ? {} : { surface: hostSurface }), snapshotEvents: () => events }
}

test('完整历史：按字面期望逐例返回（缺接口 / 非数组快照降级为空日志）', () => {
  const cases = [
    ['无会话', undefined, []],
    ['空对象', {}, []],
    ['非数组快照', { snapshotEvents: () => 'not-an-array' }, []],
    ['空日志', { snapshotEvents: () => [] }, []],
    ['正常日志', stub(), log],
  ]
  for (const [name, session, expected] of cases) {
    assert.deepEqual(historyEvents(session), expected, name)
  }
  assert.equal(historyEvents(stub()), log, '返回值即快照本身（只读，不复制）')
})

test('当前上下文：按 surface nodes 的顺序返回对应事件（含替换后的重复 seq 与乱序 nodes）', () => {
  assert.deepEqual(
    currentEvents(stub({ surfaceNodes: [3, 1, 1] })).map((event) => event.type),
    ['tool/call', 'user/message', 'user/message'],
    '按 nodes 顺序，不按 log 序；nodes 里重复的 seq 重复出现（位置替换后同一事件占多个位置）',
  )
  assert.deepEqual(
    currentEvents(stub({ surfaceNodes: [2] })).map((event) => event.type),
    ['assistant/message'],
    '遮蔽掉的节点不出现',
  )
})

test('当前上下文：nodes 为空数组 = 当前上下文为空（不降级到完整历史）', () => {
  assert.deepEqual(currentEvents(stub({ surfaceNodes: [] })), [], '空 surface 是合法状态，不是降级')
})

test('当前上下文：surface 缺失 / nodes 非数组 / 节点越界时退回完整历史', () => {
  const degraded = [
    ['无 surface', stub()],
    ['nodes 非数组', stub({ surface: { nodes: 'not-an-array' } })],
    ['nodes 为 undefined', stub({ surface: {} })],
    ['节点越界', stub({ surfaceNodes: [1, 4] })],
  ]
  for (const [name, session] of degraded) {
    assert.equal(currentEvents(session), log, `${name} → 完整历史（等价旧行为）`)
  }
})

test('两个视图都是纯函数：不缓存跨会话状态、不改写输入，重挂后同桩同结果', () => {
  const session = stub({ surfaceNodes: [1, 2] })
  const before = JSON.stringify(session)
  const first = currentEvents(session)
  assert.deepEqual(first, [log[1], log[2]], '当前上下文 = nodes 指向的事件')
  assert.deepEqual(currentEvents(session), first, '同一桩重复读取结果不变')
  assert.deepEqual(currentEvents(stub({ surfaceNodes: [1, 2] })), first, '重挂后的同形桩结果一致')
  assert.equal(JSON.stringify(session), before, '读取不改写输入')
  assert.deepEqual(historyEvents(session), log, '两个视图并存：完整历史仍看全量')
})
