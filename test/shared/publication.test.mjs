import { test } from 'node:test'
import assert from 'node:assert/strict'
import { published, readPublication } from '../../src/shared/publication.ts'

test('publication：成功只发 persisted 与 pending:false，不带 error', () => {
  assert.deepEqual(published(), { persisted: true, publicationPending: false })
})

test('publication：失败同时带 pending:true 与原样 error', () => {
  assert.deepEqual(published('人设已保存，但运行发布失败：boom'), {
    persisted: true,
    publicationPending: true,
    publicationError: '人设已保存，但运行发布失败：boom',
  })
})

test('publication：客户端把显式 pending 或任意 error 都读成待发布', () => {
  assert.deepEqual(readPublication(undefined), { pending: false })
  assert.deepEqual(readPublication({}), { pending: false })
  assert.deepEqual(readPublication({ publicationPending: false }), { pending: false })
  assert.deepEqual(readPublication({ publicationPending: true }), { pending: true })
  assert.deepEqual(readPublication({ publicationError: 'failed' }), { pending: true, error: 'failed' })
  assert.deepEqual(readPublication({ publicationPending: false, publicationError: 'failed' }), {
    pending: true,
    error: 'failed',
  })
})

test('publication：host 生成的结果经客户端解读仍为待发布', () => {
  assert.deepEqual(readPublication(published('refresh failed')), { pending: true, error: 'refresh failed' })
  assert.deepEqual(readPublication(published()), { pending: false })
})
