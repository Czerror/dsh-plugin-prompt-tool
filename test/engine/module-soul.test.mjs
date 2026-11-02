import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { Context } from '@deepseek-ai/cordis'
import { createScope, scopeTarget } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { compileRules } from '../../engine/rule-spec.mjs'
import { mountRuleSources } from '../../engine/rule-runtime.mjs'
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

test('soul常驻账本触发覆盖主子与压缩后，每12轮自检补一问且释放撤回', async t => {
  const root = new Context()
  await root.plugin(SystemPrompt)
  t.after(() => root.fiber.dispose())
  const actor = (id, depth) => {
    const events = Array.from({ length: 11 }, (_, seq) => ({ seq, type: 'turn/start', data: { turn: seq + 1 } }))
    return { id, options: {}, session: { id, header: { delegationDepth: depth }, snapshotEvents: () => events } }
  }
  const main = actor('ledger-main', 0), child = actor('ledger-child', 1)
  createScope(root, main)
  createScope(root, child, { parent: main })
  const rules = compileRules(spec.rules.filter(rule => ['soul-tools', 'soul-tick'].includes(rule.id)), {
    moduleId: 'soul', promptConfigOptions: rulePromptConfigOptions(moduleDir),
  })
  const dispose = mountRuleSources(root, [{ moduleId: 'soul', rules }])
  t.after(dispose)
  const assembled = agent => root.systemPrompt.assemble({ agent, scope: agent })
  const tools = result => result.contexts.filter(entry => entry.name.includes('soul-tools') && entry.text)
  const ticks = result => result.sections.filter(entry => entry.name.includes('soul-tick') && entry.text)
  for (const agent of [main, child]) {
    const first = await assembled(agent)
    assert.equal(tools(first).length, 1)
    for (const text of ['完成跨回合任务', '重要且难以回头的决定', '踩坑', '退场', 'container', '不必等用户专门要求', '唯一归属', '过程流水', '可重建事实', '无出处断言']) {
      assert.ok(tools(first)[0].text.includes(text), text)
    }
    assert.equal(ticks(first).length, 0, '第11轮不触发')
    const events = agent.session.snapshotEvents()
    const record = event => { events.push(event); root.emit(scopeTarget(agent.session, agent), 'session/event', agent.session, event) }
    record({ seq: events.length, type: 'turn/start', data: { turn: 12 } })
    const twelfth = await assembled(agent)
    assert.equal(ticks(twelfth).length, 1)
    assert.match(ticks(twelfth)[0].text, /自检四问.*本轮有什么值得进账本/)
    record({ seq: events.length, type: 'compaction/end', data: {} })
    const compacted = await assembled(agent)
    assert.equal(tools(compacted).length, 1, '压缩后常驻提示不重复')
    assert.equal(ticks(compacted).length, 1, '压缩不清空真实轮计数')
    record({ seq: events.length, type: 'turn/start', data: { turn: 13 } })
    assert.equal(ticks(await assembled(agent)).length, 0, '第13轮撤回周期提示')
  }
  dispose()
  for (const agent of [main, child]) assert.equal(tools(await assembled(agent)).length, 0)
})

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
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'module.yml'), readFileSync(join(moduleDir, 'module.yml')))
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
  writeFileSync(join(dir, 'data', '10-宪章', 'synonym.md'), 'compact SOURCE')
  const synonym = await retrieval.search({ query: '压缩' })
  assert.ok(synonym.hits.some(hit => hit.content === 'compact SOURCE' && hit.match === 'synonym'))
  assert.equal(existsSync(join(dir, 'assets')), false, '初始化与检索不物化包内资产')
  const stale = previewModuleDataImport(dir, request)
  const original = readFileSync(join(dir, 'data', 'SELF.src.md'))
  mkdirSync(join(dir, 'assets', 'templates'), { recursive: true })
  writeFileSync(join(dir, 'assets', 'templates', 'self-template.md'), 'USER TEMPLATE OVERRIDE')
  assert.throws(() => applyModuleDataImport(dir, { ...request, expectedRevision: stale.revision }), /预览已过期/)
  assert.deepEqual(readFileSync(join(dir, 'data', 'SELF.src.md')), original, '初始化来源切换后旧凭据不能写盘')
})
