import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTargetQueue } from '../../src/shared/target-queue.ts'

const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

test('target queue：同 key 严格按提交顺序执行', async () => {
  const queue = createTargetQueue()
  const gate = deferred()
  const order = []
  const first = queue.run('same', async () => {
    order.push('first-start')
    await gate.promise
    order.push('first-end')
    return 'first'
  })
  const second = queue.run('same', () => {
    order.push('second-start')
    return 'second'
  })
  const third = queue.run('same', () => {
    order.push('third-start')
    return 'third'
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(order, ['first-start'], '后续任务不得在第一个完成前开始')
  gate.resolve()
  assert.equal(await first, 'first')
  assert.equal(await second, 'second')
  assert.equal(await third, 'third')
  assert.deepEqual(order, ['first-start', 'first-end', 'second-start', 'third-start'])
})

test('target queue：前一个任务失败不毒化后一个任务', async () => {
  const queue = createTargetQueue()
  const first = queue.run('same', async () => { throw new Error('boom') })
  const second = queue.run('same', async () => 'ok')
  await assert.rejects(first, /boom/)
  assert.equal(await second, 'ok')
})

test('target queue：不同 key 互不阻塞', async () => {
  const queue = createTargetQueue()
  const gate = deferred()
  const blocked = queue.run('a', async () => { await gate.promise; return 'a' })
  const free = queue.run('b', async () => 'b')
  assert.equal(await free, 'b', 'b 不应等待 a 的 gate')
  gate.resolve()
  assert.equal(await blocked, 'a')
})

test('target queue：任务结束后同 key 仍可继续排队', async () => {
  const queue = createTargetQueue()
  assert.equal(await queue.run('same', () => 'first'), 'first')
  assert.equal(await queue.run('same', () => 'second'), 'second')
})
