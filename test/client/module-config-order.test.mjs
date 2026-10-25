import test from 'node:test'
import assert from 'node:assert/strict'
import { createModuleConfigOrderSession } from '../../src/client/data/use-module-config-order.ts'

test('排序会话：发布失败后 refreshOnly 只重试重建，不重写排序', async () => {
  const calls = []
  const session = createModuleConfigOrderSession({
    t: (key) => key,
    request: async (body) => {
      calls.push(body)
      if (body?.refreshOnly === true) {
        return { ok: true, value: { entries: [], revision: 'r3', persisted: true, publicationPending: false } }
      }
      if (body !== undefined) {
        return { ok: true, value: { entries: [], revision: 'r2', persisted: true, publicationPending: true, publicationError: 'publish failed' } }
      }
      return { ok: true, value: { entries: [], revision: 'r1' } }
    },
  })
  await session.load()
  await session.save([])
  assert.equal(session.state.publication?.pending, true)
  const retried = await session.retryPublication()
  assert.equal(retried, true)
  assert.deepEqual(calls, [
    undefined,
    { expectedRevision: 'r1', entries: [] },
    { refreshOnly: true },
  ])
  assert.deepEqual(session.state.publication, { pending: false })
  assert.equal(session.state.error, '')
})
