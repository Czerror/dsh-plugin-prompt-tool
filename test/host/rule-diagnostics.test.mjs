import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRuleDiagnosticsLedger } from '../../src/runtime/rule-diagnostics.ts'

const report = (ruleId, outcome = 'hit') => ({ moduleId: 'm', ruleId, channel: 'agent/pre-step', outcome })

test('rule diagnostics ledger：两个实例互不串账，disabled 不入账', () => {
  const a = createRuleDiagnosticsLedger()
  const b = createRuleDiagnosticsLedger()
  a.record(report('r1'))
  a.record(report('r1', 'disabled'))
  assert.deepEqual(a.snapshot().records, [
    { moduleId: 'm', ruleId: 'r1', channel: 'agent/pre-step', hit: 1, miss: 0, unavailable: 0, error: 0 },
  ])
  assert.deepEqual(b.snapshot(), { records: [], dropped: 0 }, '第二个装配实例从空开始')
})
