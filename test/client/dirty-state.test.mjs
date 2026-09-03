import test from 'node:test'
import assert from 'node:assert/strict'
import { EMPTY_FIELDS } from '../../src/client/data/prompt-tool-fields.ts'
import { deepEqual, promptConfigsDirty, snapshotSwitches, switchesEqual } from '../../src/client/data/dirty-state.ts'

test('dirty state：record 键序不影响比较，数组顺序仍有意义', () => {
  assert.equal(deepEqual({ a: 1, b: [2, 3] }, { b: [2, 3], a: 1 }), true)
  assert.equal(deepEqual([1, 2], [2, 1]), false)
})

test('dirty state：两个独立空配置数组不误判脏', () => {
  assert.equal(promptConfigsDirty([], []), false)
  const config = { id: 'x' }
  assert.equal(promptConfigsDirty([config], [config]), true)
})

test('dirty state：snapshot 深拷贝可变集合并比较全字段', () => {
  const fields = { ...EMPTY_FIELDS, stages: [{ name: 'a', tools: 'read' }], skillOrder: ['a'] }
  const snapshot = snapshotSwitches(fields)
  fields.stages[0].name = 'changed'
  fields.skillOrder.push('b')
  assert.deepEqual(snapshot.stages, [{ name: 'a', tools: 'read' }])
  assert.deepEqual(snapshot.skillOrder, ['a'])
  assert.equal(switchesEqual(snapshot, snapshotSwitches({ ...EMPTY_FIELDS, stages: [{ name: 'a', tools: 'read' }], skillOrder: ['a'] })), true)
})
