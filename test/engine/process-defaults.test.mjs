import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
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
import { commandConfineState } from '../../engine/command-confine.mjs'

const { moduleRoot } = isolatedHome('pt-process-defaults-')
const processRule = { id: 'future-policy', executionScope: 'process', then: [
  { id: 'default', kind: 'host-control', capability: 'approval-config-default', value: 'never' },
] }

test('public refresh recovers command confine after an optional package becomes resolvable', async () => {
  const id = 'command-package-recovery', dir = join(moduleRoot, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'module.yml'), JSON.stringify({ id, modules: ['rule-engine'], rules: [
    { id: 'command', executionScope: 'process', then: [{ id: 'call', kind: 'host-control', capability: 'command-confine-passthrough', value: true }] },
  ] }))
  class LocalFixture { confine() { return { refusal: 'original' } } }
  const fixtureKey = Symbol.for('prompt-tool:test:package-recovery')
  globalThis[fixtureKey] = LocalFixture
  let missing = true, providerUrl
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === '@deepseek-ai/dsh-sandbox-local' && missing) throw new Error('fixture: package not installed')
      const result = nextResolve(specifier, context)
      if (specifier === '@deepseek-ai/dsh-sandbox-local') providerUrl = result.url
      return result
    },
    load(url, context, nextLoad) {
      if (url === providerUrl) return { format: 'module', shortCircuit: true,
        source: 'export const LocalSandboxProvider = globalThis[Symbol.for("prompt-tool:test:package-recovery")]' }
      return nextLoad(url, context)
    },
  })
  const root = new Context()
  await root.plugin(SystemPrompt)
  await root.plugin(ToolRuntime)
  await root.plugin(nativeExecutor)
  root.provide('llm', {})
  root.provide('agents', { list: () => [] })
  root.provide('sandbox', new LocalFixture())
  let enabled = [id]
  const runtime = createAgentAssembly(root, { moduleRoot, enabledModules: () => enabled })
  try {
    await runtime.settled()
    assert.deepEqual(runtime.publicationFailures(), [])
    assert.deepEqual(root.sandbox.confine(['fixture'], {}), { refusal: 'original' })
    assert.equal(runtime.ruleDiagnostics().records.at(-1).identityOutcome, 'condition-unavailable')
    missing = false
    await runtime.refresh(id)
    assert.deepEqual(root.sandbox.confine(['fixture'], {}), { argv: ['fixture'], enforcement: 'full', denialSignatures: [], runnerFailureRules: [] })
    await runtime.refresh(id)
    enabled = []
    await runtime.refresh()
    assert.deepEqual(root.sandbox.confine(['fixture'], {}), { refusal: 'original' })
  } finally {
    await runtime.dispose()
    assert.deepEqual(root.sandbox.confine(['fixture'], {}), { refusal: 'original' })
    await root.fiber.dispose()
    hooks.deregister()
    delete globalThis[fixtureKey]
  }
})

test('public module publication without Agents selects command calls and disabling restores the provider', async () => {
  const id = 'command-publication', dir = join(moduleRoot, id)
  mkdirSync(dir, { recursive: true })
  const rule = { id: 'command', executionScope: 'process', then: [{ id: 'call', kind: 'host-control', capability: 'command-confine-passthrough', value: true }] }
  writeFileSync(join(dir, 'module.yml'), JSON.stringify({ id, modules: ['rule-engine'], rules: [rule] }))
  const before = readModuleRules(dir)
  assert.equal(before.rules[0].executionScope, 'process')
  const root = new Context()
  await root.plugin(SystemPrompt)
  await root.plugin(ToolRuntime)
  await root.plugin(nativeExecutor)
  root.provide('llm', {})
  root.provide('agents', { list: () => [] })
  class LocalFixture { confine() { return { refusal: 'original' } } }
  root.provide('sandbox', new LocalFixture())
  const off = await commandConfineState.install(root, LocalFixture)
  let enabled = [id]
  const runtime = createAgentAssembly(root, { moduleRoot, enabledModules: () => enabled })
  try {
    await runtime.settled()
    assert.deepEqual(runtime.publicationFailures(), [])
    assert.deepEqual(root.sandbox.confine(['fixture'], {}), { argv: ['fixture'], enforcement: 'full', denialSignatures: [], runnerFailureRules: [] })
    enabled = []
    await runtime.refresh()
    assert.deepEqual(root.sandbox.confine(['fixture'], {}), { refusal: 'original' })
  } finally { await runtime.dispose(); await off(); await root.fiber.dispose() }
})

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
