import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { isolatedHome } from '../fixtures/host-harness.mjs'
import { compileRules } from '../../engine/rule-spec.mjs'
import { readModuleRules, editModuleRules } from '../../src/host/module-rules.ts'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as nativeExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { createAgentAssembly } from '../../src/runtime/agent-assembly.ts'

const { moduleRoot } = isolatedHome('pt-process-defaults-')
const processRule = { id: 'future-policy', executionScope: 'process', then: [
  { id: 'default', kind: 'host-control', capability: 'approval-config-default', value: 'never' },
] }

test('process scope and independent defaults survive the public module rule transaction and slices', () => {
  const dir = join(moduleRoot, 'process-module')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'module.yml'), JSON.stringify({ id: 'process-module', modules: ['rule-engine'], rules: [processRule] }))
  const before = readModuleRules(dir)
  const changed = { ...processRule, name: 'Future approval', enabled: false }
  const saved = editModuleRules(dir, { edits: [{ previousId: processRule.id, rule: changed, settingsChanged: true }], expectedRevisions: before.revisions })
  assert.deepEqual(saved.rules[0], changed)
  const stored = parse(readFileSync(join(dir, 'module.yml'), 'utf8'))
  assert.deepEqual(stored.rules[0], changed)
  assert.equal(readModuleRules(dir).rules[0].executionScope, 'process')
})

test('process rejects Agent facts and Agent delivery actions; missing scope remains Agent', () => {
  const agentRule = { id: 'ordinary', then: [{ id: 'text', kind: 'inject-text', config: { layer: 'system-section', text: 'ordinary' } }] }
  assert.equal(compileRules([agentRule])[0].executionScope, 'agent')
  assert.throws(() => compileRules([{ ...processRule, executionScope: undefined }]), /executionScope process/)
  assert.throws(() => compileRules([{ ...processRule, if: { scope: { audience: 'main' } } }]), /process.*Agent conditions/)
  assert.throws(() => compileRules([{ ...agentRule, executionScope: 'process' }]), /only process actions/)
  assert.throws(() => compileRules([{ ...processRule, then: [{ if: { session: { count: 1 } }, then: processRule.then }] }]), /process|session/)
})

test('process publication without Agents exposes constructor unavailability through existing diagnostics', async () => {
  const id = 'process-diagnostics', dir = join(moduleRoot, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'module.yml'), JSON.stringify({ id, modules: ['rule-engine'], rules: [processRule] }))
  const root = new Context()
  await root.plugin(SystemPrompt)
  await root.plugin(ToolRuntime)
  await root.plugin(nativeExecutor)
  root.provide('llm', {})
  root.provide('agents', { list: () => [] })
  let enabled = [id]
  const runtime = createAgentAssembly(root, { moduleRoot, enabledModules: () => enabled })
  try {
    await runtime.settled()
    assert.deepEqual(runtime.publicationFailures(), [])
    const records = runtime.ruleDiagnostics().records
    assert.equal(records.length, 1)
    assert.equal(records[0].moduleId, id)
    assert.equal(records[0].agentId, undefined)
    assert.equal(records[0].identityOutcome, 'condition-unavailable')
    assert.match(records[0].reason, /early entry|cached|constructor unavailable/)
    writeFileSync(join(dir, 'module.yml'), 'rules: [')
    await assert.rejects(runtime.refresh(id), /更新失败/)
    assert.ok(runtime.publicationFailures().length > 0)
    enabled = []
    await runtime.refresh()
    assert.deepEqual(runtime.publicationFailures(), [])
  } finally { await runtime.dispose(); await root.fiber.dispose() }
  assert.deepEqual(runtime.ruleDiagnostics(), { records: [], dropped: 0 })
})
