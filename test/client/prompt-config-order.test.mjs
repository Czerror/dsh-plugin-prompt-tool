import test from 'node:test'
import assert from 'node:assert/strict'
import { moveToView, moveWithinLayer, viewOrderedIds } from '../../src/client/features/prompts/prompt-config-order.ts'

const layers = ['pre-step', 'system-section']
const configs = [
  { id: 'b', layer: 'pre-step', order: 20 },
  { id: 'x', layer: 'system-section', order: 0 },
  { id: 'a', layer: 'pre-step', order: 10 },
]

test('prompt ordering：显示顺序按层、order、声明序稳定排序', () => {
  assert.deepEqual(viewOrderedIds(configs, undefined, layers), ['a', 'b', 'x'])
})

test('prompt ordering：键盘移动同步交换数组位置与 order', () => {
  const moved = moveWithinLayer(configs, 0, -1, 'pre-step', layers)
  assert.deepEqual(viewOrderedIds(moved, 'pre-step', layers), ['b', 'a'])
  assert.equal(moved.find((item) => item.id === 'b').order, 10)
})

test('prompt ordering：拖拽只在当前筛选视图内移动', () => {
  const moved = moveToView(configs, 'a', 'b', false, 'pre-step', layers)
  assert.deepEqual(viewOrderedIds(moved, 'pre-step', layers), ['b', 'a'])
  assert.equal(moved.find((item) => item.id === 'x').order, 0)
})
