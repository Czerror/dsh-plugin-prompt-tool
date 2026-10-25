import test from 'node:test'
import assert from 'node:assert/strict'
import { runPreStepPipeline } from '../../src/runtime/pre-step-coordinator.ts'

test('pre-step 管线：filter 先于 batch，batch 收到过滤后的 messages', async () => {
  const calls = []
  const decision = { kind: 'continue', messages: [{ id: 'official' }, { id: 'user' }] }
  const result = await runPreStepPipeline(
    decision,
    (messages) => {
      calls.push('filter')
      return messages.filter((message) => message.id !== 'official')
    },
    async (filtered) => {
      calls.push('batch:' + filtered.messages.map((message) => message.id).join(','))
      return { ...filtered, injected: true }
    },
  )
  assert.deepEqual(calls, ['filter', 'batch:user'])
  assert.equal(result.injected, true)
  assert.deepEqual(result.messages.map((message) => message.id), ['user'])
})

test('pre-step 管线：reject 或无 messages 直接交给 batch，不调用 filter', async () => {
  const calls = []
  const batch = async (decision) => { calls.push(decision.kind ?? 'none'); return decision }
  await runPreStepPipeline({ kind: 'reject' }, () => { calls.push('filter'); return [] }, batch)
  await runPreStepPipeline({ kind: 'continue' }, () => { calls.push('filter'); return [] }, batch)
  assert.deepEqual(calls, ['reject', 'continue'])
})
