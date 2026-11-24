import SessionProjections from '@deepseek-ai/dsh-session-projection'
// 自建模块验证真实装配的主子隔离、热更新和故障恢复，不固定内置模块内容。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createScope, scopeTarget } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as nativeExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { isolatedHome, fixtureRule } from '../fixtures/host-harness.mjs'

const { moduleRoot } = isolatedHome('pt-assembly-')
const { prepareAssembly, createAgentAssembly } = await import('../../src/runtime/agent-assembly.ts')
const { installPreStepCoordinator } = await import('../../src/runtime/pre-step-coordinator.ts')
const { mountRuleSources } = await import('../../engine/rule-runtime.mjs')
const { commitModuleDefinition, loadModuleDefinition, materializeModuleDefinition } = await import('../../src/host/module-slices.ts')
const { MODULE_LOCAL_COMMIT_FILE } = await import('../../src/host/module-local-state.ts')
const { editModuleRuleContent, readModuleRules } = await import('../../src/host/module-rules.ts')
const { migrateLegacyModules } = await import('../../src/host/module-catalog.ts')

/** 装配能力探针：装配只问「宿主是否提供该服务」，这里全部视为提供。 */
const hasEveryService = () => true

/** 只替代 Agent/模型驱动；注册、scope 路由与注入执行器使用真实实现。 */
async function liveAssembly(t, enabledModules) {
  const root = new Context()
  await root.plugin(SessionProjections)
  await root.plugin(SystemPrompt)
  await root.plugin(ToolRuntime)
  await root.plugin(nativeExecutor)
  root.provide('llm', {})
  const agents = []
  root.provide('agents', { list: () => agents })
  installPreStepCoordinator(root)
  const warnings = []
  const runtime = createAgentAssembly(root, { moduleRoot, enabledModules, warn: (message) => warnings.push(message) })
  t.after(async () => { await runtime.dispose(); await root.fiber.dispose() })
  const makeAgent = async (id, depth = 0) => {
    const events = []
    const agent = { id, options: {}, session: { id, header: { delegationDepth: depth }, snapshotEvents: () => events } }
    agent.ctx = createScope(root, agent).ctx
    agents.push(agent)
    await root.serial(scopeTarget(agent, agent), 'agent/created', { agent, source: 'startup' })
    return agent
  }
  const inject = (agent, wait = async () => {}) => root.waterfall(scopeTarget(agent, agent), 'agent/pre-step', { agent, signal: new AbortController().signal }, async () => (await wait(), {
    kind: 'continue', messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'USER' }] }],
  }))
  const assemble = async agent => {
    const request = agent.ctx.plugin({ inject: ['systemPrompt'], async apply(ctx) { await ctx.systemPrompt.assemble({ agent, scope: agent }) } })
    try { await request } finally { await request.dispose() }
  }
  return { root, runtime, makeAgent, inject, assemble, warnings }
}

test('真实注入：启用配置进入主/子会话正确位置，关闭项不注入，释放后不再贡献', async (t) => {
  const installed = writeModuleFixture('live-injection', {
    modules: ['prompt-config-engine'],
    promptConfigs: [
      { id: 'main', text: 'MAIN', audience: 'main', position: 'before-all' },
      { id: 'child', text: 'CHILD', audience: 'subagent', position: 'after-user' },
      { id: 'off', text: 'OFF', enabled: false },
      { id: 'system', layer: 'system-section', text: 'SYSTEM' },
      { id: 'promoted', text: 'PROMOTED', promotion: 'main', audience: 'main', position: 'after-user' },
    ],
  })
  writeFileSync(join(installed, 'module.yml'), 'rules: [')
  const h = await liveAssembly(t, () => ['live-injection'])
  const busyRead = readFileSync
  let ruleObjectsRead = 0
  const processRule = { id: 'process-fixture', executionScope: 'process', then: [{ id: 'control', kind: 'host-control', capability: 'command-confine-passthrough', value: true }] }
  const source = structuredClone(loadModuleDefinition(installed).source)
  t.mock.method(fs, 'readFileSync', (file, ...args) => {
    if (String(file).startsWith(join(installed, 'rules', '.objects'))) ruleObjectsRead++
    return busyRead(file, ...args)
  })
  syncBuiltinESMExports()
  try {
    await h.runtime.refresh()
    assert.equal(ruleObjectsRead, 0, '没有 Agent 或进程贡献时只读提交索引')
    commitModuleDefinition(loadModuleDefinition(installed), JSON.stringify({ ...source, rules: [...source.rules, processRule] }))
    ruleObjectsRead = 0
    await h.runtime.refresh()
    assert.ok(ruleObjectsRead > 0, '进程规则仍走完整编译')
    assert.ok(JSON.stringify(h.runtime.ruleDiagnostics()).includes('process-fixture'), '没有 Agent 时仍发布进程规则')
    commitModuleDefinition(loadModuleDefinition(installed), JSON.stringify(source))
    await h.runtime.refresh()
    ruleObjectsRead = 0
    await h.runtime.refresh()
    assert.equal(ruleObjectsRead, 0, '撤回进程规则后恢复只读索引')
  } finally {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  }
  h.root.systemPrompt.context({ name: 'test:context', order: 0, text: 'CONTEXT' })
  const main = await h.makeAgent('main-live')
  const child = await h.makeAgent('child-live', 1)
  await h.runtime.settled()
  const texts = (result) => result.messages.flatMap((message) => message.content.map((block) => block.text))
  assert.deepEqual(texts(await h.inject(main)), ['MAIN', 'USER'])
  assert.deepEqual(texts(await h.inject(child)), ['USER', 'CHILD'])
  const entered = Promise.withResolvers(), finish = Promise.withResolvers()
  const inFlight = h.inject(main, async () => { entered.resolve(); await finish.promise })
  await entered.promise
  const before = readModuleRules(installed)
  const next = structuredClone(before.rules.find(rule => rule.id === 'main'))
  next.then[0].config.text = 'NEXT REQUEST'
  const edited = editModuleRuleContent(installed, { previousId: next.id, rule: next }, before.revisions)
  assert.equal(edited.deferUntilRequest, true)
  assert.equal(h.runtime.adoptAtNextRequest('live-injection', edited.definitionRevision), true)
  await h.runtime.settled()
  assert.equal(h.runtime.moduleGenerations('live-injection').find(item => item.agentId === main.id)?.generation, before.definitionRevision)
  assert.deepEqual(texts(await h.inject(main)), ['NEXT REQUEST', 'USER'])
  assert.equal(h.runtime.moduleGenerations('live-injection').find(item => item.agentId === main.id)?.generation, edited.definitionRevision)
  finish.resolve()
  assert.deepEqual(texts(await inFlight), ['MAIN', 'USER'])
  const system = await h.root.systemPrompt.assemble({ agent: main, scope: main })
  assert.ok(system.sections.some((section) => section.text === 'SYSTEM'))
  assert.ok(system.contexts.some((context) => context.text === 'CONTEXT'))
  const record = (type) => {
    const events = main.session.snapshotEvents()
    const event = { seq: events.length + 1, type, data: {} }
    events.push(event)
    h.root.emit(scopeTarget(main.session, main), 'session/event', main.session, event)
  }
  record('assistant/message')
  assert.deepEqual(texts(await h.inject(main)), ['NEXT REQUEST', 'USER', 'PROMOTED'])
  record('compaction/end')
  assert.deepEqual(texts(await h.inject(main)), ['NEXT REQUEST', 'USER'])
  record('assistant/message')
  assert.deepEqual(texts(await h.inject(main)), ['NEXT REQUEST', 'USER', 'PROMOTED'])
  const chainDir = join(moduleRoot, 'managed-chain')
  mkdirSync(chainDir)
  installFixture('managed-chain', { id: 'managed-chain', modules: ['rule-engine'], configOrder: { chain: 1000 }, rules: [{
    id: 'chain', layer: 'pre-step', if: { all: [{ scope: { audience: 'main' } }, { phase: { promoted: true } }] },
    then: [
      { id: 'a', kind: 'inject-text', config: { id: 'chain-a', layer: 'pre-step', sourceKind: 'plugin', text: 'CHAIN-A', position: 'after-user' } },
      { id: 'filter', kind: 'pre-step-filter', blockPlugins: ['chain-a'] },
      { id: 'b', kind: 'inject-text', config: { id: 'chain-b', layer: 'pre-step', sourceKind: 'plugin', text: 'CHAIN-B', position: 'after-user' } },
    ],
  }] })
  const checks = { main: 0, child: 0 }
  const releases = []
  for (const [key, agent] of [['main', main], ['child', child]]) {
    const prepared = await prepareAssembly(moduleRoot, 'managed-chain', hasEveryService)
    releases.push(mountRuleSources(agent.ctx, [{ moduleId: 'managed-chain', rules: prepared.rules }]))
    // 计数注入在挂载缝绑定之后：含 `phase` 的规则会在挂载时重绑（订阅模式从挂载缝的追踪器池
    // 取实例），绑定之前放进产物里的 when 会被覆盖。
    const evaluate = prepared.rules[0].when
    prepared.rules[0].when = Object.assign(subject => { checks[key]++; return evaluate(subject) }, evaluate)
  }
  assert.deepEqual(texts(await h.inject(main)), ['NEXT REQUEST', 'USER', 'PROMOTED', 'CHAIN-B'], '受管批次逐动作执行 A→过滤A→B')
  assert.deepEqual(texts(await h.inject(child)), ['USER', 'CHILD'])
  assert.deepEqual(checks, { main: 1, child: 1 }, '同一执行帧每规则只判断一次')
  record('compaction/end')
  assert.deepEqual(texts(await h.inject(main)), ['NEXT REQUEST', 'USER'])
  record('assistant/message')
  assert.deepEqual(texts(await h.inject(main)), ['NEXT REQUEST', 'USER', 'PROMOTED', 'CHAIN-B'])
  assert.equal(checks.main, 3, '压缩后同一规则重判、重晋升，仍每批一次')
  for (const release of releases) release()
  assert.deepEqual(h.warnings, [])
  await h.runtime.dispose()
  assert.deepEqual(texts(await h.inject(main)), ['USER'])
  const after = await h.root.systemPrompt.assemble({ agent: main, scope: main })
  assert.equal(after.sections.some((section) => section.text === 'SYSTEM'), false)
  assert.ok(after.contexts.some((context) => context.text === 'CONTEXT'))
})

test('首次装配跳过坏模块，健康模块在主子会话继续注入，修复后恢复且释放干净', async (t) => {
  const write = (id, text, strategy = 'static') => writeModuleFixture(id, {
    modules: ['rule-engine'], promptConfigs: [{ id, text, strategy, position: 'after-user' }],
  })
  mkdirSync(join(moduleRoot, 'isolated-broken'), { recursive: true })
  const healthy = writeModuleFixture('isolated-healthy', { modules: ['rule-engine'], promptConfigs: [
    { id: 'isolated-healthy', templateFile: 'body.txt', position: 'after-user' },
  ] }, { 'body.txt': 'HEALTHY' })
  const legacy = join(moduleRoot, 'disabled-legacy')
  mkdirSync(legacy)
  writeFileSync(join(legacy, 'module.yml'), 'id: disabled-legacy\nrules: []\n')
  migrateLegacyModules(moduleRoot)
  const legacyPointer = readFileSync(join(legacy, 'rules', MODULE_LOCAL_COMMIT_FILE))
  writeFileSync(join(legacy, 'module.yml'), 'id: disabled-legacy\nname: stale\nrules: []\n')
  migrateLegacyModules(moduleRoot)
  assert.deepEqual(readFileSync(join(legacy, 'rules', MODULE_LOCAL_COMMIT_FILE)), legacyPointer)
  const template = join(healthy, 'body.txt')
  const h = await liveAssembly(t, () => ['isolated-broken', 'isolated-healthy'])
  const agents = [await h.makeAgent('isolated-main'), await h.makeAgent('isolated-child', 1)]
  assert.deepEqual(h.runtime.moduleGenerations('disabled-legacy'), [])
  assert.deepEqual(h.runtime.moduleGenerations('isolated-broken'), agents.map(agent => ({ agentId: agent.id })))
  const texts = async agent => (await h.inject(agent)).messages.flatMap(message => message.content.map(block => block.text))
  for (const agent of agents) {
    assert.deepEqual(await texts(agent), ['USER', 'HEALTHY'])
    assert.deepEqual(h.runtime.moduleIds(agent.id), ['isolated-healthy'])
  }
  assert.ok(h.warnings.some(message => message.includes('isolated-broken')), '诊断标识故障模块')
  writeFileSync(template, 'TEMPLATE-CHANGED')
  await h.assemble(agents[0])
  for (const agent of agents) assert.deepEqual(await texts(agent), ['USER', 'TEMPLATE-CHANGED'], '已启用来源按实际模板更新')
  write('isolated-broken', 'RECOVERED')
  await h.runtime.refresh('isolated-broken')
  await h.runtime.refresh('isolated-broken')
  for (const agent of agents) {
    assert.deepEqual(await texts(agent), ['USER', 'RECOVERED', 'TEMPLATE-CHANGED'])
    assert.deepEqual(h.runtime.moduleIds(agent.id), ['isolated-broken', 'isolated-healthy'])
  }
  const section = h.root.systemPrompt.section
  let rejectedMounts = 0
  t.mock.method(h.root.systemPrompt, 'section', function (config) {
    if (config.name.includes('isolated-broken') && rejectedMounts === 0) {
      rejectedMounts++
      throw new Error('HOST-SECTION-REJECTED')
    }
    return section.call(this, config)
  })
  const oldGeneration = h.runtime.moduleGenerations('isolated-broken')[0].generation
  const brokenDir = writeModuleFixture('isolated-broken', { modules: ['rule-engine'], promptConfigs: [
    { id: 'isolated-broken-section', layer: 'system-section', text: 'REJECTED' },
  ] })
  const newGeneration = loadModuleDefinition(brokenDir).revision
  write('isolated-healthy', 'HEALTHY-AFTER-RULE-FAILURE')
  await assert.rejects(h.runtime.refresh('isolated-broken'), /HOST-SECTION-REJECTED/)
  const generations = h.runtime.moduleGenerations('isolated-broken')
  assert.deepEqual(new Set(generations.map(item => item.generation)), new Set([oldGeneration, newGeneration]))
  for (const agent of agents) {
    const used = generations.find(item => item.agentId === agent.id).generation
    assert.deepEqual(await texts(agent), ['USER', ...(used === oldGeneration ? ['RECOVERED'] : []), 'HEALTHY-AFTER-RULE-FAILURE'])
  }
  assert.equal(rejectedMounts, 1)
  h.runtime.schedule('isolated-broken')
  await h.assemble(agents[0])
  assert.equal(rejectedMounts, 1, '普通发布保留拒绝标记，避免同坏版本重新挂载')
  await assert.rejects(h.runtime.refresh('isolated-broken', oldGeneration), { code: 'rules-conflict' })
  assert.equal(rejectedMounts, 1, '过期代不触发运行发布')
  h.root.systemPrompt.section.mock.restore()
  const committedPointer = readFileSync(join(brokenDir, 'rules', MODULE_LOCAL_COMMIT_FILE))
  await h.runtime.refresh('isolated-broken', newGeneration)
  assert.deepEqual(readFileSync(join(brokenDir, 'rules', MODULE_LOCAL_COMMIT_FILE)), committedPointer, '重试只发布')
  assert.ok(h.runtime.moduleGenerations('isolated-broken').every(item => item.generation === newGeneration))
  await h.runtime.dispose()
  for (const agent of agents) {
    assert.deepEqual(await texts(agent), ['USER'])
    assert.deepEqual(h.runtime.moduleIds(agent.id), [])
  }
})

test('热更新：空启用表到多模块、配置启停与拒绝后重试都更新同一个 Agent，重复刷新不重复注入', async (t) => {
  const { setModuleEnabled, enabledModuleIds } = await import('../../src/host/config-store.ts')
  for (const id of ['hot-a', 'hot-b']) writeModuleFixture(id, {
    modules: ['prompt-config-engine'],
    variables: { label: id },
    promptConfigs: [{ id, text: '{{label}}', position: 'after-user' }],
  })
  const h = await liveAssembly(t, () => enabledModuleIds(moduleRoot))
  const agent = await h.makeAgent('hot-agent')
  const injected = async () => (await h.inject(agent)).messages.flatMap(message => message.content.map(block => block.text))
  assert.deepEqual(await injected(), ['USER'])
  const child = await h.makeAgent('hot-child', 1)
  const childText = async () => (await h.inject(child)).messages.flatMap(message => message.content.map(block => block.text))
  const count = { id: 'hot-count', if: { count: { of: 'assistant-message', min: 1 } }, then: [
    { id: 'count-text', kind: 'inject-text', config: { layer: 'pre-step', text: 'COUNT', position: 'after-user' } },
  ] }
  installFixture('hot-a', { id: 'hot-a', modules: ['rule-engine'], rules: [count] })
  setModuleEnabled(moduleRoot, 'hot-a', true)
  await h.runtime.refresh()
  assert.deepEqual(await injected(), ['USER'])
  assert.deepEqual(await childText(), ['USER'])
  const assistant = { seq: 1, type: 'assistant/message', data: {} }
  agent.session.snapshotEvents().push(assistant)
  h.root.emit(scopeTarget(agent.session, agent), 'session/event', agent.session, assistant)
  assert.deepEqual(await injected(), ['USER', 'COUNT'])
  assert.deepEqual(await childText(), ['USER'], '共享定义的计数按 Agent 隔离')
  setModuleEnabled(moduleRoot, 'hot-b', true)
  await h.runtime.refresh()
  await h.runtime.refresh()
  assert.deepEqual(await injected(), ['USER', 'COUNT', 'hot-b'])
  writeModuleFixture('hot-a', {
    modules: ['prompt-config-engine'],
    promptConfigs: [{ id: 'hot-a', text: 'CHANGED', enabled: false, position: 'after-user' }],
  })
  await h.runtime.refresh('hot-a')
  assert.deepEqual(await injected(), ['USER', 'hot-b'])
  writeModuleFixture('hot-a', {
    modules: ['prompt-config-engine'],
    promptConfigs: [{ id: 'hot-a', text: 'CHANGED', position: 'after-user' }],
  })
  await h.runtime.refresh('hot-a')
  assert.deepEqual(await injected(), ['USER', 'CHANGED', 'hot-b'])
  const pointer = join(moduleRoot, 'hot-b', 'rules', MODULE_LOCAL_COMMIT_FILE)
  const savedPointer = readFileSync(pointer)
  const oldGeneration = h.runtime.moduleGenerations('hot-b')[0].generation
  writeModuleFixture('hot-b', {
    modules: ['rule-engine'], promptConfigs: [{ id: 'hot-b', text: 'NEW-B', position: 'after-user' }],
  })
  const nextCommit = JSON.parse(readFileSync(pointer, 'utf8'))
  await h.runtime.refresh('hot-b')
  assert.equal(h.runtime.moduleGenerations('hot-b')[0].generation, nextCommit.generation)
  assert.deepEqual(await injected(), ['USER', 'CHANGED', 'NEW-B'])
  writeFileSync(join(moduleRoot, 'hot-b', 'rules', '.objects', nextCommit.members['hot-b.yml']), 'corrupt rule')
  await h.runtime.refresh('hot-b')
  assert.equal(h.runtime.moduleGenerations('hot-b')[0].generation, oldGeneration)
  assert.deepEqual(await injected(), ['USER', 'CHANGED', 'hot-b'], '损坏当前成员时完整回退到上一代')
  writeFileSync(pointer, '{}')
  migrateLegacyModules(moduleRoot)
  assert.equal(readFileSync(pointer, 'utf8'), '{}', '启动不使用旧定义覆盖受损的本地代')
  writeModuleFixture('hot-a', {
    modules: ['rule-engine'], promptConfigs: [{ id: 'hot-a', text: 'HEALTHY-UPDATE', position: 'after-user' }],
  })
  await assert.rejects(h.runtime.refresh('hot-b'), /运行时配装更新失败/)
  assert.deepEqual(await injected(), ['USER', 'HEALTHY-UPDATE'], '损坏提交无上一代时撤回贡献，健康模块更新')
  writeModuleFixture('hot-a', {
    modules: ['rule-engine'], promptConfigs: [{ id: 'hot-a', text: 'HEALTHY-AFTER-PARSE-ERROR', position: 'after-user' }],
  })
  await assert.rejects(h.runtime.refresh(), /运行时配装更新失败/)
  assert.deepEqual(await injected(), ['USER', 'HEALTHY-AFTER-PARSE-ERROR'], '坏指针不阻止其他模块更新')
  assert.ok(h.runtime.publicationFailures().some(failure => failure.moduleId === undefined), '全量失败有诊断')
  writeFileSync(pointer, savedPointer)
  writeModuleFixture('hot-b', {
    modules: ['rule-engine'], promptConfigs: [{ id: 'hot-b', text: 'RECOVERED-B', position: 'after-user' }],
  })
  await h.runtime.refresh('hot-b')
  assert.deepEqual(await injected(), ['USER', 'HEALTHY-AFTER-PARSE-ERROR', 'RECOVERED-B'])
  assert.deepEqual(h.runtime.publicationFailures(), [], '定向重试验证全部存活 Agent 后清除旧全量诊断')
  setModuleEnabled(moduleRoot, 'hot-b', false)
  await h.runtime.refresh()
  assert.deepEqual(await injected(), ['USER', 'HEALTHY-AFTER-PARSE-ERROR'])
  setModuleEnabled(moduleRoot, 'hot-a', false)
  await h.runtime.refresh()
  assert.deepEqual(await injected(), ['USER'])
  assert.deepEqual(h.runtime.moduleIds(agent.id), [])
})

test('模块启用在预检后遇到另一提交时拒绝互斥集合，保留原配置', async () => {
  const { setModuleEnabled, enabledModuleIds, enableTablePath } = await import('../../src/host/config-store.ts')
  for (const id of ['race-a', 'race-b']) {
    installFixture(id, {
      id, modules: ['rule-engine'], rules: [{
        ...fixtureRule({ id, text: id }), group: 'race', groupScope: 'cross-module', exclusive: true,
      }],
    })
  }
  const config = enableTablePath(moduleRoot)
  writeFileSync(config, '# keep comment\nschemaVersion: 3\nenabled: []\ncustom: stay\n')
  const original = fs.readFileSync
  let reads = 0
  let interleaved = false
  fs.readFileSync = function (file, ...args) {
    if (String(file) === config && ++reads === 2) {
      fs.readFileSync = original
      syncBuiltinESMExports()
      setModuleEnabled(moduleRoot, 'race-a', true)
      interleaved = true
    }
    return original.call(this, file, ...args)
  }
  syncBuiltinESMExports()
  try {
    assert.throws(() => setModuleEnabled(moduleRoot, 'race-b', true), /跨模块互斥组/)
  } finally {
    fs.readFileSync = original
    syncBuiltinESMExports()
  }
  assert.equal(interleaved, true, '另一提交发生在预检与锁内读取之间')
  assert.deepEqual(enabledModuleIds(moduleRoot), ['race-a'])
  assert.match(original(config, 'utf8'), /^# keep comment\n/)
  assert.match(original(config, 'utf8'), /custom: stay/)
  setModuleEnabled(moduleRoot, 'race-a', true)
  setModuleEnabled(moduleRoot, 'race-b', false)
  assert.deepEqual(enabledModuleIds(moduleRoot), ['race-a'])
})

function installFixture(id, definition, files = {}) {
  const dir = join(moduleRoot, id)
  mkdirSync(dir, { recursive: true })
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body)
  const text = JSON.stringify(definition)
  let snapshot
  try { snapshot = loadModuleDefinition(dir) } catch { /* 尚未安装的夹具从完整定义物化。 */ }
  if (snapshot) commitModuleDefinition(snapshot, text)
  else {
    writeFileSync(join(dir, 'module.yml'), text)
    materializeModuleDefinition(dir)
  }
  return dir
}

function writeModuleFixture(id, { modules, promptConfigs = [], variables }, files) {
  return installFixture(id, {
    id, name: id, modules: [...new Set(modules.map(name => ['prompt-config-engine', 'declared-triggers'].includes(name) ? 'rule-engine' : name))],
    rules: promptConfigs.map(config => fixtureRule(config)),
    ...(variables === undefined ? {} : { variables }),
  }, files)
}
