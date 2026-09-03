import test from 'node:test'
import assert from 'node:assert/strict'
import { nextTabIndex, tabKeyHandler } from '../../src/client/tab-key.ts'

test('tab index：左右循环，Home/End 跳转，其他键不处理', () => {
  assert.equal(nextTabIndex(3, 0, 'ArrowRight'), 1)
  assert.equal(nextTabIndex(3, 2, 'ArrowRight'), 0)
  assert.equal(nextTabIndex(3, 0, 'ArrowLeft'), 2)
  assert.equal(nextTabIndex(3, 1, 'Home'), 0)
  assert.equal(nextTabIndex(3, 1, 'End'), 2)
  assert.equal(nextTabIndex(3, 1, 'Enter'), undefined)
  assert.equal(nextTabIndex(0, 0, 'ArrowRight'), undefined)
  assert.equal(nextTabIndex(3, -1, 'ArrowRight'), undefined)
})

test('tab handler：只消费导航键并选择对应值', () => {
  const selected = []
  let prevented = 0
  const handler = tabKeyHandler(['a', 'b', 'c'], 'b', (value) => selected.push(value))
  handler({ key: 'ArrowRight', preventDefault: () => { prevented += 1 } })
  handler({ key: 'Enter', preventDefault: () => { prevented += 1 } })
  assert.deepEqual(selected, ['c'])
  assert.equal(prevented, 1)
})
