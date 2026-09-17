/** 技能状态刷新策略回归：文件系统事件必须无条件失效清单缓存。
 *
 *  这里锁住的是一次真实缺陷：watcher 同时监听状态文件与用户引用的技能目录，而刷新回调
 *  在「状态快照没变」时提前返回，于是引用目录里新增或删除的技能永远留在清单缓存里，
 *  同一个 cwd 反复拿到旧清单。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSkillsRefresh } from '../../lib/index.mjs'

/** 最小依赖替身：记录 accept / rewatch / invalidate 的调用，模拟内存状态与磁盘状态的差异。 */
function makeRefresh(initial, readState) {
  const calls = { accepted: [], rewatch: 0, invalidate: 0 }
  let state = initial
  let snapshot = JSON.stringify(initial)
  const refresh = createSkillsRefresh({
    read: () => {
      const next = readState()
      return { state: next, snapshot: JSON.stringify(next) }
    },
    currentSnapshot: () => snapshot,
    accept: (next, nextSnapshot) => {
      state = next
      snapshot = nextSnapshot
      calls.accepted.push(next)
    },
    rewatch: () => { calls.rewatch += 1 },
    invalidate: () => { calls.invalidate += 1 },
  })
  return { refresh, calls, state: () => state, snapshot: () => snapshot }
}

const stateOf = (folders = [], blocked = []) => ({ version: 3, folders, blocked })

test('刷新策略：状态未变（引用目录内的文件变化）也必须失效清单缓存', () => {
  const current = stateOf(['D:/refs'])
  const { refresh, calls } = makeRefresh(current, () => current)
  refresh()
  assert.equal(calls.invalidate, 1, '这正是曾经的缺陷：快照没变就提前返回，缓存永不失效')
  assert.equal(calls.rewatch, 0, '状态没变不需要重挂 watcher')
  assert.deepEqual(calls.accepted, [], '状态没变不替换内存状态')
})

test('刷新策略：状态变化时替换状态、重挂 watcher，且每次事件都失效缓存', () => {
  const before = stateOf(['D:/refs'])
  const after = stateOf(['D:/refs', 'D:/more'], [{ name: 'demo', at: '2026-09-17T00:00:00.000Z' }])
  let current = before
  const { refresh, calls, state, snapshot } = makeRefresh(before, () => current)
  current = after
  refresh()
  assert.deepEqual(calls.accepted, [after], '新状态进入内存')
  assert.deepEqual(state(), after)
  assert.equal(snapshot(), JSON.stringify(after), '快照随状态更新，下一次同样内容不会重复重挂')
  assert.equal(calls.rewatch, 1, '引用目录集合可能变了，必须重挂')
  assert.equal(calls.invalidate, 1)

  refresh()
  assert.equal(calls.accepted.length, 1, '同一状态不重复替换')
  assert.equal(calls.rewatch, 1, '同一状态不重复重挂')
  assert.equal(calls.invalidate, 2, '每次事件都要失效缓存，即使状态没变')

  current = stateOf([])
  refresh()
  assert.equal(calls.rewatch, 2, '引用目录被清空同样重挂')
  assert.equal(calls.invalidate, 3)
})
