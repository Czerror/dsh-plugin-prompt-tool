import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRuleDiagnosticsLedger } from '../../src/runtime/rule-diagnostics.ts'
import { isolatedHome, makeHostContext } from '../fixtures/host-harness.mjs'

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

test('身份可用性通过既有只读诊断端点返回最近目标观测，读取不推进状态', async () => {
  const { moduleRoot } = isolatedHome('pt-identity-diagnostics-')
  const { registerSettingsBridge } = await import('../../src/runtime/settings-bridge.ts')
  const ledger = createRuleDiagnosticsLedger()
  const observation = { moduleId: 'limit-breaker', ruleId: 'purge-25', channel: 'persona:identity:harness' }
  ledger.record({ ...observation, outcome: 'hit', identityOutcome: 'matched', definitionRevision: 'R1' })
  ledger.record({ ...observation, outcome: 'hit', identityOutcome: 'target-mismatch', definitionRevision: 'R1' })
  const host = makeHostContext()
  registerSettingsBridge(host.ctx, { ns: 'prompt-tool', models: () => ({ available: false, providers: [] }), moduleDirectory: () => moduleRoot, ruleDiagnostics: () => ledger.snapshot() })
  const first = await host.call('/rule-diagnostics')
  assert.equal(first.status, 200)
  assert.deepEqual(first.value.records, [{ ...observation, hit: 0, miss: 0, unavailable: 0, error: 0, identityOutcome: 'target-mismatch', definitionRevision: 'R1' }])
  assert.deepEqual((await host.call('/rule-diagnostics')).value.records, first.value.records)
})

test('身份目标失配不写入公开条件unavailable计数，保留独立目标观测', async () => {
  const ledger = createRuleDiagnosticsLedger()
  ledger.record({ moduleId: 'limit-breaker', ruleId: 'purge-4', channel: 'persona:identity:preset', outcome: 'hit', identityOutcome: 'target-mismatch', definitionRevision: 'R1' })
  const record = ledger.snapshot().records[0]
  assert.equal(record.unavailable, 0)
  assert.equal(record.identityOutcome, 'target-mismatch')
  assert.equal(record.definitionRevision, 'R1')
})
