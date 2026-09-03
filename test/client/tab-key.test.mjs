import test from 'node:test'
import assert from 'node:assert/strict'
import { nextTabIndex, tabKeyHandler } from '../../src/client/ui/tab-key.ts'

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

test('tab handler：消费导航键、选择对应值并移动焦点', () => {
  const selected = []
  const focused = []
  let prevented = 0
  const tabs = [0, 1, 2].map((index) => ({ focus: () => focused.push(index) }))
  const event = (key) => ({
    key,
    preventDefault: () => { prevented += 1 },
    currentTarget: { parentElement: { querySelectorAll: () => tabs } },
  })
  const handler = tabKeyHandler(['a', 'b', 'c'], 'b', (value) => selected.push(value))
  handler(event('ArrowRight'))
  handler(event('Enter'))
  assert.deepEqual(selected, ['c'])
  assert.deepEqual(focused, [2])
  assert.equal(prevented, 1)
})
