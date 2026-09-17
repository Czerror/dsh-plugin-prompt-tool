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

test('prompt ordering：全部视图也不能跨插入点移动', () => {
  assert.equal(moveWithinLayer(configs, 0, 1, undefined, layers), configs)
  assert.equal(moveToView(configs, 'a', 'x', false, undefined, layers), configs)
})

test('prompt ordering：策略与可见受众子集共同约束排序', () => {
  const all = [
    { id: 'a', layer: 'pre-step', strategy: 'world-book', order: 10 },
    { id: 'hidden', layer: 'pre-step', strategy: 'world-book', order: 20 },
    { id: 'static', layer: 'pre-step', strategy: 'static', order: 25 },
    { id: 'b', layer: 'pre-step', strategy: 'world-book', order: 30 },
    { id: 'x', layer: 'system-section', strategy: 'world-book', order: 0 },
  ]
  const visible = ['a', 'b', 'x']
  const moved = moveToView(all, 'b', 'a', true, undefined, layers, 'world-book', visible)
  assert.deepEqual(viewOrderedIds(moved, 'pre-step', layers, 'world-book', visible), ['b', 'a'])
  assert.equal(moved.find((item) => item.id === 'hidden'), all[1])
  assert.equal(moved.find((item) => item.id === 'static'), all[2])
  assert.equal(moved.find((item) => item.id === 'x'), all[4])
  assert.equal(moveToView(all, 'a', 'hidden', false, undefined, layers, 'world-book', visible), all)
})
