import test from 'node:test'
import assert from 'node:assert/strict'
import { createSerialTaskQueue } from '../../src/client/data/save-queue.ts'

test('save queue：任务严格串行', async () => {
  const queue = createSerialTaskQueue()
  const events = []
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const first = queue.enqueue(async () => { events.push('a:start'); await gate; events.push('a:end') })
  const second = queue.enqueue(async () => { events.push('b') })
  await Promise.resolve()
  assert.deepEqual(events, ['a:start'])
  release()
  await Promise.all([first, second])
  assert.deepEqual(events, ['a:start', 'a:end', 'b'])
})

test('save queue：失败任务不阻断后续任务', async () => {
  const queue = createSerialTaskQueue()
  const first = queue.enqueue(async () => { throw new Error('boom') })
  let ran = false
  const second = queue.enqueue(async () => { ran = true })
  await assert.rejects(first, /boom/)
  await second
  assert.equal(ran, true)
})
