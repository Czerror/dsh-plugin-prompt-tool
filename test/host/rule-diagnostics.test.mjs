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

test('身份实际观测经只读诊断端点返回版本，目标失配不污染条件计数', async () => {
  const { moduleRoot } = isolatedHome('pt-identity-observation-')
  const { registerSettingsBridge } = await import('../../src/runtime/settings-bridge.ts')
  const ledger = createRuleDiagnosticsLedger()
  ledger.record({ moduleId: 'm', ruleId: 'identity', channel: 'persona:identity:preset', outcome: 'hit', identityOutcome: 'matched', definitionRevision: 'R1' })
  ledger.record({ moduleId: 'm', ruleId: 'identity', channel: 'persona:identity:preset', outcome: 'unavailable', identityOutcome: 'target-mismatch', definitionRevision: 'R2' })
  const host = makeHostContext()
  registerSettingsBridge(host.ctx, { ns: 'prompt-tool', models: () => ({ available: false, providers: [] }), moduleDirectory: () => moduleRoot, ruleDiagnostics: () => ledger.snapshot() })
  const first = await host.call('/rule-diagnostics')
  assert.equal(first.status, 200)
  assert.deepEqual(first.value.records, [{ moduleId: 'm', ruleId: 'identity', channel: 'persona:identity:preset', hit: 0, miss: 0, unavailable: 0, error: 0, identityOutcome: 'target-mismatch', definitionRevision: 'R2' }])
  assert.deepEqual((await host.call('/rule-diagnostics')).value.records, first.value.records)
})
