import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { compileRules } from '../../engine/rule-spec.mjs'
import { rulePromptConfigOptions } from '../../src/host/module-slices.ts'
import { runModuleManifest } from '../../src/host/module-manifest.ts'
import { MODULE_TOOL_CAPABILITIES, MODULE_TOOL_NAMES } from '../../src/shared/engine-capabilities.ts'
import { isolatedHome } from '../fixtures/host-harness.mjs'
import { readModuleFacts } from '../../src/host/module-params.ts'
import { loadModuleSpec } from '../../src/host/module-spec.ts'
import { previewModuleDataImport, applyModuleDataImport } from '../../src/host/module-data-import.ts'
import { refreshSoulSelf, renderSoulSelf } from '../../src/host/soul-self.ts'
import { createModuleRetrieval } from '../../src/host/module-retrieval.ts'

const { moduleRoot } = isolatedHome('pt-soul-complete-')

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const moduleDir = join(repoRoot, 'modules', 'soul')
const spec = parse(readFileSync(join(moduleDir, 'module.yml'), 'utf8'))

test('soul 模块：规则编译、模板存在与变量声明', () => {
  const rules = compileRules(spec.rules, {
    moduleId: 'soul', variables: spec.variables, variablesEnabled: spec.variablesEnabled,
    promptConfigOptions: rulePromptConfigOptions(moduleDir),
  })
  assert.deepEqual(rules.map(rule => rule.id).sort(), [
    'soul-check', 'soul-core', 'soul-core-sub', 'soul-echo', 'soul-layers', 'soul-ledger',
    'soul-ledger-open', 'soul-plan', 'soul-post-compaction', 'soul-scaffold', 'soul-self', 'soul-tick', 'soul-tools', 'soul-vital',
  ])
  for (const file of ['criteria.md', 'core-hard.md', 'layers.md', 'echo.md', 'vital.md', 'ledger.md', 'tools.md']) {
    assert.ok(readFileSync(join(moduleDir, 'assets', file), 'utf8').length > 0)
  }
  const layers = readFileSync(join(moduleDir, 'assets', 'layers.md'), 'utf8')
  assert.match(layers, /L0–L5/)
  assert.doesNotMatch(layers, /L1–L6/)
  for (const file of ['ECHO-权威口径.md', 'ECHO六层与mnemon协同说明书.md']) {
    assert.ok(readFileSync(join(moduleDir, 'assets', 'reference', file), 'utf8').length > 0)
  }
  assert.ok(Object.values(spec.variables).every(value => typeof value === 'string'))
  for (const name of ['module-file-tools', 'module-manifest-tools', 'module-variable-tools']) {
    assert.ok(spec.modules.includes(name), name)
    assert.ok(existsSync(join(repoRoot, 'engine', 'compositions', 'source', 'local', name + '.yml')), `组合行 ${name}`)
  }
  assert.equal(MODULE_TOOL_CAPABILITIES[MODULE_TOOL_NAMES.manifest], 'module-manifest-tools')
  assert.equal(MODULE_TOOL_CAPABILITIES[MODULE_TOOL_NAMES.fileRead], 'module-file-tools')
})

test('soul 模块：manifest 的 next/check 只读，不建目录', () => {
  const next = runModuleManifest(moduleDir, 'next')
  assert.equal(next.ok, false)
  assert.deepEqual(next.entries, [{ kind: 'dir', path: 'data/10-宪章' }])
  const checked = runModuleManifest(moduleDir, 'check')
  assert.equal(checked.ok, false)
  assert.equal(checked.entries[0].path, 'data/02-soul.jsonl')
  assert.equal(checked.entries[0].error, '文件不存在')
})

test('soul完整模块初始化后可用SELF策略与授权检索，默认维护和恢复策略由装配事实提供', async () => {
  const dir = join(moduleRoot, 'soul')
  cpSync(moduleDir, dir, { recursive: true })
  const facts = readModuleFacts(dir)
  assert.deepEqual([facts.effectiveConfigs['generation-recovery'].mainRecoveryLimit, facts.effectiveConfigs['generation-recovery'].subagentRecoveryLimit], [3, 1])
  assert.equal(facts.effectiveConfigs['generation-recovery'].maintenanceCompression, false)
  assert.equal(facts.effectiveConfigs['soul-maintenance'].wake, false)
  assert.equal(facts.effectiveConfigs['soul-maintenance'].intervalMs, 60000)
  const request = { moduleId: 'soul', initialize: true }
  const preview = previewModuleDataImport(dir, request)
  applyModuleDataImport(dir, { ...request, expectedRevision: preview.revision })
  assert.ok(readFileSync(join(dir, 'data', 'SELF.src.md'), 'utf8').length > 0)
  refreshSoulSelf(dir, { state: 'ready', files: 2, sessions: 1, events: 3 }, { expectedRevision: null })
  const source = loadModuleSpec(dir)
  const compiled = compileRules(source.rules, { moduleId: source.id, variables: source.variables,
    promptConfigOptions: rulePromptConfigOptions(dir) })
  const self = compiled.find(rule => rule.id === 'soul-self').actions[0].compiledConfig
  const resolver = await self.resolve({ ctx: { get: name => name === 'promptToolSoulSelf' ? { render: (_moduleId, agent, signal) => renderSoulSelf(dir, agent, signal) } : undefined }, agent: { session: { id: 'actual-session', header: {} } } })
  assert.match(resolver.text, /actual-session/)
  const retrieval = createModuleRetrieval(() => ({ moduleId: 'soul', dir, ...facts.effectiveConfigs.retrieval }))
  writeFileSync(join(dir, 'data', '10-宪章', 'owned.md'), 'AUTHORIZED UNIQUE FACT')
  const hits = await retrieval.search({ query: 'AUTHORIZED UNIQUE FACT' })
  assert.equal(hits.hits.length, 1)
  assert.equal((await retrieval.open(hits.hits[0].reference)).content, 'AUTHORIZED UNIQUE FACT')
  assert.equal((await retrieval.search({ query: '装配时刻' })).hits.length, 0, '派生SELF不进入来源索引')
})
