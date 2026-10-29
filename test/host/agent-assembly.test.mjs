/**
 * 运行时配装通道回归：装配输入必须与原预设形态逐项同源。
 *
 * 真值源是**预设目录里的字面量**（`module.yml` 的 modules 声明与 `configs/*.yml`），
 * 不是被测实现自己算出的另一份结果——两条路径互相比对会让同一个错误在两边同时通过。
 *
 * 断言落在调用方观察到的装配输入上：切片（层/位置/时机/次数/受众）、引擎模块清单、
 * 受管字段的绝对位置。改装配实现时这些契约不变。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { bindScopeParent, createScope, scopeOf, scopeTarget } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { isolatedHome, fixtureRule } from '../fixtures/host-harness.mjs'

const { moduleRoot } = isolatedHome('pt-assembly-')
const { prepareAssembly, createAgentAssembly } = await import('../../src/runtime/agent-assembly.ts')
const { installPreStepCoordinator, PRE_STEP_COORDINATOR_SERVICE } = await import('../../src/runtime/pre-step-coordinator.ts')
const { instructionFileIdentityOf, readInstructionPolicy, writeInstructionPolicy } = await import('../../src/host/instructions-policy.ts')
const { mountRuleSources } = await import('../../engine/rule-runtime.mjs')
const { installPersonaCapture } = await import('../../src/runtime/persona-registration.ts')
const { loadModuleSpec } = await import('../../src/host/module-spec.ts')
const { readModuleFacts, rowDisabled } = await import('../../src/host/module-params.ts')
const { mountPreStepConfigs: mountConfigs, applyPromptConfigSources } = await import('../fixtures/pre-step.mjs')

/** 装配能力探针：装配只问「宿主是否提供该服务」，这里全部视为提供。 */
const hasEveryService = () => true

/** 只替代 Agent/模型驱动；注册、scope 路由与注入执行器使用真实实现。 */
async function liveAssembly(t, enabledModules, options = {}) {
  // `beforeCoordinator` 只服务「模拟官方监听器先注册」的用例；不透传给装配。
  const { beforeCoordinator, ...assemblyOptions } = options
  const root = new Context()
  await root.plugin(SystemPrompt)
  await root.plugin(ToolRuntime)
  root.provide('llm', {})
  const agents = []
  root.provide('agents', { list: () => agents })
  beforeCoordinator?.(root)
  installPreStepCoordinator(root)
  const warnings = []
  const runtime = createAgentAssembly(root, { moduleRoot, enabledModules, ...assemblyOptions, warn: (message) => warnings.push(message) })
  t.after(async () => { await runtime.dispose(); await root.fiber.dispose() })
  const makeAgent = async (id, depth = 0, surface) => {
    const events = []
    const agent = { id, options: {}, session: { id, header: { delegationDepth: depth }, snapshotEvents: () => events, ...(surface === undefined ? {} : { surface }) } }
    agent.ctx = createScope(root, agent).ctx
    agents.push(agent)
    await root.serial(scopeTarget(agent, agent), 'agent/created', { agent, source: 'startup' })
    return agent
  }
  const inject = (agent) => root.waterfall(scopeTarget(agent, agent), 'agent/pre-step', { agent, signal: new AbortController().signal }, async () => ({
    kind: 'continue', messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'USER' }] }],
  }))
  return { root, runtime, makeAgent, inject, warnings }
}

test('官方 assemble 自动采用最新有效本地定义，坏定义保旧并在修复后恢复', async (t) => {
  const id = 'live-system-definition'
  const write = text => writeModuleFixture(id, { modules: ['prompt-config-engine'], promptConfigs: [{ id: 'live-system', layer: 'system-section', text }] })
  write('LIVE-A')
  const h = await liveAssembly(t, () => [id])
  const main = await h.makeAgent('live-system-main')
  const child = await h.makeAgent('live-system-child', 1)
  const readers = new Map()
  for (const agent of [main, child]) await agent.ctx.plugin({ inject: ['systemPrompt'], apply(ctx) {
    readers.set(agent, () => ctx.systemPrompt.assemble({ agent, scope: agent }))
  } })
  const texts = async agent => (await readers.get(agent)()).sections.map(section => section.text)
  for (const agent of [main, child]) assert.ok((await texts(agent)).includes('LIVE-A'))
  write('LIVE-B')
  for (const agent of [main, child]) {
    const actual = await texts(agent)
    assert.ok(actual.includes('LIVE-B'))
    assert.ok(!actual.includes('LIVE-A'))
  }
  writeFileSync(join(moduleRoot, id, 'module.yml'), 'rules: [')
  for (const agent of [main, child]) assert.ok((await texts(agent)).includes('LIVE-B'))
  assert.ok(h.warnings.length > 0)
  write('LIVE-C')
  for (const agent of [main, child]) {
    const actual = await texts(agent)
    assert.ok(actual.includes('LIVE-C'))
    assert.ok(!actual.includes('LIVE-B'))
  }
  const file = join(moduleRoot, id, 'module.yml')
  renameSync(file, file + '.away')
  try { for (const agent of [main, child]) assert.ok((await texts(agent)).includes('LIVE-C'), '读取失败沿用旧贡献') }
  finally { renameSync(file + '.away', file) }
  let registrations = 0
  const off = h.root.on('system-prompt/change', () => { registrations++ })
  for (const agent of [main, child]) await texts(agent)
  assert.equal(registrations, 0, '未改定义不重挂注册')
  off()
  writeModuleFixture(id, { modules: ['prompt-config-engine'], promptConfigs: [
    { id: 'new-step', layer: 'pre-step', text: 'CHILD-STEP', audience: 'subagent', position: 'after-user' },
    { id: 'disabled', layer: 'system-section', text: 'OFF', enabled: false },
  ] })
  for (const agent of [main, child]) {
    const sections = await texts(agent)
    assert.ok(!sections.includes('LIVE-C') && !sections.includes('OFF'))
  }
  const messages = result => result.messages.flatMap(message => message.content.map(block => block.text))
  assert.deepEqual(messages(await h.inject(main)), ['USER'])
  assert.deepEqual(messages(await h.inject(child)), ['USER', 'CHILD-STEP'])
  const { writeGlobalLayerSettings } = await import('../../src/host/config-store.ts')
  writeGlobalLayerSettings(moduleRoot, { modelMaxTokens: '55' })
  await texts(main)
  const request = () => h.root.waterfall(scopeTarget(main, main), 'agent/request', { agent: main }, async () => ({ maxTokens: 999 }))
  assert.equal((await request()).maxTokens, 55, '全局参数变化也更新下一官方请求')
  writeGlobalLayerSettings(moduleRoot, { modelMaxTokens: '' })
  await texts(main)
  assert.equal((await request()).maxTokens, 999, '删除全局覆盖恢复宿主参数')
  writeModuleFixture(id, { modules: ['rule-engine'], promptConfigs: [{ id: 'external', text: 'WATCHED', position: 'after-user' }] })
  const deadline = Date.now() + 2000
  let changed
  do {
    await new Promise(resolve => setTimeout(resolve, 25))
    changed = messages(await h.inject(main))
  } while (!changed.includes('WATCHED') && Date.now() < deadline)
  assert.deepEqual(changed, ['USER', 'WATCHED'], '外部原地改动自动更新下一官方事件，不需要手动刷新')
  await h.runtime.dispose()
  for (const agent of [main, child]) assert.ok(!(await texts(agent)).includes('LIVE-C'))
  assert.deepEqual(messages(await h.inject(child)), ['USER'])
})

test('只改变量值不重挂规则：内容签名剔除 variables', async (t) => {
  const id = 'variables-only'
  const fixture = variables => writeModuleFixture(id, {
    modules: ['prompt-config-engine'],
    variables,
    promptConfigs: [{ id: 'variable-rule', layer: 'system-section', text: 'TEXT' }],
  })
  fixture({ v: 'A' })
  const h = await liveAssembly(t, () => [id])
  const agent = await h.makeAgent('variables-only-agent')
  await h.runtime.settled()
  let registrations = 0
  const off = h.root.on('system-prompt/change', () => { registrations++ })
  fixture({ v: 'B' })
  await h.inject(agent)
  assert.equal(registrations, 0, '只改变量值不重挂')
  off()
})

test('本地人设正文和来源下一次官方装配生效；坏来源保留两类受众的有效内容', async t => {
  const { selectedPersonaModules, writePersonaSources, readPersonaSources } = await import('../../src/host/persona-selection.ts')
  const first = 'live-persona-first', second = 'live-persona-second'
  const write = (id, main, child) => writeModuleFixture(id, { modules: [], persona: { main: { prefix: main }, subagent: { prefix: child } } })
  write(first, 'MAIN-A', 'CHILD-A'); write(second, 'MAIN-B', 'CHILD-B')
  writePersonaSources(moduleRoot, { main: first, subagent: first }, readPersonaSources(moduleRoot).revision)
  const h = await liveAssembly(t, () => [], { personaModules: () => selectedPersonaModules(moduleRoot) })
  const actors = [await h.makeAgent('live-persona-main'), await h.makeAgent('live-persona-child', 1)]
  const readers = []
  for (const agent of actors) await agent.ctx.plugin({ inject: ['systemPrompt'], apply(ctx) {
    readers.push(async () => (await ctx.systemPrompt.assemble({ agent, scope: agent })).sections.map(section => section.text))
  } })
  assert.ok((await readers[0]()).includes('MAIN-A'))
  assert.ok((await readers[1]()).includes('CHILD-A'))
  write(first, 'MAIN-A2', 'CHILD-A2')
  assert.ok((await readers[0]()).includes('MAIN-A2'))
  assert.ok((await readers[1]()).includes('CHILD-A2'))
  writePersonaSources(moduleRoot, { main: second, subagent: first }, readPersonaSources(moduleRoot).revision)
  assert.ok((await readers[0]()).includes('MAIN-B'))
  assert.ok((await readers[1]()).includes('CHILD-A2'))
  writeFileSync(join(moduleRoot, second, 'module.yml'), 'persona: [')
  assert.ok((await readers[0]()).includes('MAIN-B'))
  assert.ok((await readers[1]()).includes('CHILD-A2'))
  assert.ok(h.warnings.length > 0)
  write(second, 'MAIN-C', 'CHILD-C')
  assert.ok((await readers[0]()).includes('MAIN-C'))
  assert.deepEqual(h.runtime.moduleIds(actors[0].id), [], '人设来源不启用该模块规则')
  writePersonaSources(moduleRoot, { main: null, subagent: null }, readPersonaSources(moduleRoot).revision)
})

test('真实注入：启用配置进入主/子会话正确位置，关闭项不注入，释放后不再贡献', async (t) => {
  writeModuleFixture('live-injection', {
    modules: ['prompt-config-engine'],
    promptConfigs: [
      { id: 'main', text: 'MAIN', audience: 'main', position: 'before-all' },
      { id: 'child', text: 'CHILD', audience: 'subagent', position: 'after-user' },
      { id: 'off', text: 'OFF', enabled: false },
      { id: 'system', layer: 'system-section', text: 'SYSTEM' },
      { id: 'promoted', text: 'PROMOTED', promotion: 'main', audience: 'main', position: 'after-user' },
    ],
  })
  const h = await liveAssembly(t, () => ['live-injection'])
  h.root.systemPrompt.context({ name: 'test:context', order: 0, text: 'CONTEXT' })
  const main = await h.makeAgent('main-live')
  const child = await h.makeAgent('child-live', 1)
  await h.runtime.settled()
  const texts = (result) => result.messages.flatMap((message) => message.content.map((block) => block.text))
  assert.deepEqual(texts(await h.inject(main)), ['MAIN', 'USER'])
  assert.deepEqual(texts(await h.inject(child)), ['USER', 'CHILD'])
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
  assert.deepEqual(texts(await h.inject(main)), ['MAIN', 'USER', 'PROMOTED'])
  record('compaction/end')
  assert.deepEqual(texts(await h.inject(main)), ['MAIN', 'USER'])
  record('assistant/message')
  assert.deepEqual(texts(await h.inject(main)), ['MAIN', 'USER', 'PROMOTED'])
  const chainDir = join(moduleRoot, 'managed-chain')
  mkdirSync(chainDir)
  writeFileSync(join(chainDir, 'module.yml'), JSON.stringify({ id: 'managed-chain', modules: ['rule-engine'], configOrder: { chain: 1000 }, rules: [{
    id: 'chain', layer: 'pre-step', if: { all: [{ scope: { audience: 'main' } }, { phase: { promoted: true } }] },
    then: [
      { id: 'a', kind: 'inject-text', config: { id: 'chain-a', layer: 'pre-step', sourceKind: 'plugin', text: 'CHAIN-A', position: 'after-user' } },
      { id: 'filter', kind: 'pre-step-filter', blockPlugins: ['chain-a'] },
      { id: 'b', kind: 'inject-text', config: { id: 'chain-b', layer: 'pre-step', sourceKind: 'plugin', text: 'CHAIN-B', position: 'after-user' } },
    ],
  }] }))
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
  assert.deepEqual(texts(await h.inject(main)), ['MAIN', 'USER', 'PROMOTED', 'CHAIN-B'], '受管批次逐动作执行 A→过滤A→B')
  assert.deepEqual(texts(await h.inject(child)), ['USER', 'CHILD'])
  assert.deepEqual(checks, { main: 1, child: 1 }, '同一执行帧每规则只判断一次')
  record('compaction/end')
  assert.deepEqual(texts(await h.inject(main)), ['MAIN', 'USER'])
  record('assistant/message')
  assert.deepEqual(texts(await h.inject(main)), ['MAIN', 'USER', 'PROMOTED', 'CHAIN-B'])
  assert.equal(checks.main, 3, '压缩后同一规则重判、重晋升，仍每批一次')
  for (const release of releases) release()
  assert.deepEqual(h.warnings, [])
  await h.runtime.dispose()
  assert.deepEqual(texts(await h.inject(main)), ['USER'])
  const after = await h.root.systemPrompt.assemble({ agent: main, scope: main })
  assert.equal(after.sections.some((section) => section.text === 'SYSTEM'), false)
  assert.ok(after.contexts.some((context) => context.text === 'CONTEXT'))
})

test('预设条件在真实挂载scope绑定：正反判断隔离、缺事实不放行、失败刷新保旧贡献', async (t) => {
  const dir = join(moduleRoot, 'preset-conditions')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'module.yml')
  const definition = { id: 'preset-conditions', modules: ['rule-engine'], rules: [
    { id: 'matching', layer: 'agent-request', if: { preset: { presetId: 'target' } }, then: [{ id: 'request', kind: 'request-params', modelScope: 'all', patch: { maxTokens: 111 } }] },
    { id: 'different', layer: 'agent-request', if: { not: { preset: { presetId: 'target' } } }, then: [{ id: 'request', kind: 'request-params', modelScope: 'all', patch: { maxTokens: 222 } }] },
  ] }
  writeFileSync(file, JSON.stringify(definition))
  const h = await liveAssembly(t, () => ['preset-conditions'])
  const selections = new WeakMap()
  let lookups = 0
  const provider = h.root.plugin({ name: 'fixture-preset-registry', apply(ctx) {
    ctx.provide('agentPresets', {
      defaultId: 'target',
      composedPreset(agentCtx) { lookups++; return selections.get(agentCtx) },
    })
  } })
  await provider
  const main = await h.makeAgent('preset-main')
  const child = await h.makeAgent('preset-child', 1)
  selections.set(main.ctx, 'target')
  selections.set(child.ctx, 'other')
  const request = agent => h.root.waterfall(scopeTarget(agent, agent), 'agent/request', { agent }, async () => ({ maxTokens: 999 }))
  assert.equal((await request(main)).maxTokens, 111, '当前预设命中时执行正向动作')
  assert.equal((await request(child)).maxTokens, 222, '已知其他预设才执行否定动作')
  const queries = lookups
  await request(main)
  assert.equal(lookups - queries, 2, '每条条件只读取一次该Agent的真实预设')
  writeFileSync(file, JSON.stringify({ ...definition, rules: [{ id: 'broken', then: [{ id: 'broken', kind: 'unknown' }] }] }))
  await assert.rejects(h.runtime.refresh('preset-conditions'), /运行时配装更新失败/)
  assert.equal((await request(main)).maxTokens, 111, 'prepare失败没有撤销旧scope条件与动作')
  writeFileSync(file, JSON.stringify(definition))
  await h.runtime.refresh('preset-conditions')
  await h.runtime.refresh('preset-conditions')
  const reloadedQueries = lookups
  assert.equal((await request(child)).maxTokens, 222)
  assert.equal(lookups - reloadedQueries, 2, '重挂不复用旧scope闭包或叠加监听器')
  // 动作级 preset 在真实挂载 scope 重绑（T3）：then 嵌套 / 规则级 else / 动作级 else 三组，
  // 各用不同请求字段隔离，target 走 then、other 走 else、缺事实两者都不放行。
  writeFileSync(file, JSON.stringify({ ...definition, rules: [...definition.rules,
    { id: 'nested-then', layer: 'agent-request', then: [
      { if: { preset: { presetId: 'target' } }, then: [{ id: 'nt-hit', kind: 'request-params', modelScope: 'all', patch: { temperature: 0.1 } }], else: [{ id: 'nt-miss', kind: 'request-params', modelScope: 'all', patch: { temperature: 0.9 } }] },
    ] },
    { id: 'rule-else', layer: 'agent-request', if: { preset: { presetId: 'target' } }, then: [{ id: 're-hit', kind: 'request-params', modelScope: 'all', patch: { maxTokens: 333 } }], else: [{ id: 're-miss', kind: 'request-params', modelScope: 'all', patch: { maxTokens: 444 } }] },
    { id: 'action-else', layer: 'agent-request', then: [
      { if: { preset: { presetId: 'target' } }, then: [{ id: 'ae-hit', kind: 'request-params', modelScope: 'all', patch: { stop: ['hit'] } }], else: [{ id: 'ae-miss', kind: 'request-params', modelScope: 'all', patch: { stop: ['miss'] } }] },
    ] },
  ] }))
  await h.runtime.refresh('preset-conditions')
  assert.deepEqual(await request(main), { maxTokens: 333, temperature: 0.1, stop: ['hit'] }, '动作级 preset：target 下三组 then 命中')
  assert.deepEqual(await request(child), { maxTokens: 444, temperature: 0.9, stop: ['miss'] }, '动作级 preset：other 下三组 else 命中')
  const bare = await h.makeAgent('preset-bare')
  assert.deepEqual(await request(bare), { maxTokens: 999 }, '动作级 preset：缺事实时 then/else 都不放行')
  selections.delete(main.ctx)
  main.session.header.agentPreset = 'target'
  assert.equal((await request(main)).maxTokens, 999, '未知当前预设不取header/default，not也不放行')
  await provider.dispose()
  assert.equal((await request(child)).maxTokens, 999, '服务缺失且无挂载事实时否定条件仍不放行')
  await h.runtime.dispose()
  assert.equal((await request(main)).maxTokens, 999, '释放后没有规则贡献')
})

test('动作级 phase 在真实挂载 scope 重绑后仍接收 session/event', async (t) => {
  const dir = join(moduleRoot, 'action-phase')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'module.yml'), JSON.stringify({
    id: 'action-phase', modules: ['rule-engine'], rules: [{
      id: 'phase-branch', layer: 'agent-request', then: [{
        if: { phase: { promoted: true } },
        then: [{ id: 'then-req', kind: 'request-params', modelScope: 'all', patch: { maxTokens: 111 } }],
        else: [{ id: 'else-req', kind: 'request-params', modelScope: 'all', patch: { maxTokens: 222 } }],
      }],
    }],
  }))
  const h = await liveAssembly(t, () => ['action-phase'])
  const agent = await h.makeAgent('action-phase-agent')
  const request = () => h.root.waterfall(scopeTarget(agent, agent), 'agent/request', { agent }, async () => ({ maxTokens: 999 }))
  assert.equal((await request()).maxTokens, 222, '初始未晋升走动作级 else')
  const events = agent.session.snapshotEvents()
  const event = { seq: events.length + 1, type: 'assistant/message', data: {} }
  events.push(event)
  h.root.emit(scopeTarget(agent.session, agent), 'session/event', agent.session, event)
  assert.equal((await request()).maxTokens, 111, '重绑后的动作级 phase 仍收到 session/event')
  await h.runtime.dispose()
})

test('规则诊断：协调器路径按模块/规则/通道分类入账，三类判定各自正确', async (t) => {
  const dir = join(moduleRoot, 'diag-rules')
  mkdirSync(dir, { recursive: true })
  const rule = (id, when) => ({
    id, layer: 'pre-step', ...(when === undefined ? {} : { if: when }),
    then: [{ id: `${id}-action`, kind: 'inject-text', config: { id: `diag-${id}`, layer: 'pre-step', sourceKind: 'plugin', text: id.toUpperCase(), position: 'after-user' } }],
  })
  writeFileSync(join(dir, 'module.yml'), JSON.stringify({
    id: 'diag-rules', modules: ['rule-engine'], rules: [
      rule('hit', { all: [{ scope: { audience: 'main' } }] }),
      rule('miss', { all: [{ scope: { audience: 'subagent' } }] }),
      rule('unavailable', { preset: { presetId: 'target' } }),
    ],
  }))
  const h = await liveAssembly(t, () => ['diag-rules'])
  const main = await h.makeAgent('diag-main')
  await h.runtime.settled()
  const injected = (await h.inject(main)).messages.flatMap(message => message.content.map(block => block.text))
  assert.deepEqual(injected, ['USER', 'HIT'], '命中规则注入正文，其余两支不注入')
  const records = h.runtime.ruleDiagnostics().records
  const byRule = new Map(records.map(record => [record.ruleId, record]))
  assert.deepEqual([...byRule.keys()].sort(), ['hit', 'miss', 'unavailable'], JSON.stringify(records))
  const record = (ruleId, counts) => ({ moduleId: 'diag-rules', ruleId, channel: 'agent/pre-step', hit: 0, miss: 0, unavailable: 0, error: 0, ...counts })
  assert.deepEqual(byRule.get('hit'), record('hit', { hit: 1 }))
  assert.deepEqual(byRule.get('miss'), record('miss', { miss: 1 }))
  assert.deepEqual(byRule.get('unavailable'), record('unavailable', { unavailable: 1 }))
})

test('官方负责人事实：规则来源不再报 false，未观察到即 undefined', async (t) => {
  writeModuleFixture('owner-none', { modules: ['prompt-config-engine'], promptConfigs: [{ id: 'owner-x', text: 'X', position: 'after-user' }] })
  const h = await liveAssembly(t, () => ['owner-none'])
  const agent = await h.makeAgent('owner-session')
  await h.runtime.settled()
  await h.inject(agent)
  const coordinator = h.root.get(PRE_STEP_COORDINATOR_SERVICE)
  assert.equal(coordinator.officialOwnerOf('owner-session'), undefined, '没有官方装配事实时不猜')
  // bridge 载荷 = `observed ?? null`（settings-bridge 的 instructionOwner）。
  assert.equal(coordinator.officialOwnerOf('owner-session') ?? null, null)
})

test('指令身份：坏 baselineIdentity 的项目消息仍放行并告警', async (t) => {
  const h = await liveAssembly(t, () => [])
  const logs = []
  Object.defineProperty(h.root, 'logger', { value: { warn: (message) => logs.push(message) }, configurable: true })
  const current = readInstructionPolicy()
  const written = writeInstructionPolicy({ expectedRevision: current.revision, patch: { files: { 'agents-file-demo': { enabled: false } } } })
  assert.equal(written.ok, true)
  const coordinator = h.root.get(PRE_STEP_COORDINATOR_SERVICE)
  const agent = { session: { id: 'identity-agent', header: { cwd: moduleRoot, delegationDepth: 0 }, snapshotEvents: () => [] } }
  const messages = [{
    id: 'm1',
    source: { kind: 'agent-instructions', changes: [{ path: 'AGENTS.md', action: 'set' }], baselineIdentity: 'not-json' },
    content: [{ type: 'text', text: '<system-reminder>\nInstructions from: AGENTS.md\nBODY\n</system-reminder>' }],
  }]
  assert.equal(coordinator.filterInstructions(agent, messages).length, 1, '身份解析失败时原样放行')
  assert.ok(logs.some(message => message.includes('invalid-baseline')), '按原因告警，不再静默')
})

test('指令身份：可定位且策略关闭时过滤项目消息', async (t) => {
  const h = await liveAssembly(t, () => [])
  const identity = instructionFileIdentityOf('~/.dsh/AGENTS.md')
  assert.ok(identity.fileId)
  const current = readInstructionPolicy()
  const written = writeInstructionPolicy({ expectedRevision: current.revision, patch: { files: { [identity.fileId]: { enabled: false } } } })
  assert.equal(written.ok, true)
  const coordinator = h.root.get(PRE_STEP_COORDINATOR_SERVICE)
  const agent = { session: { id: 'identity-positive', header: { delegationDepth: 0 }, snapshotEvents: () => [] } }
  const messages = [{
    id: 'm2',
    source: { kind: 'agent-instructions', changes: [{ path: '~/.dsh/AGENTS.md', action: 'set' }] },
    content: [{ type: 'text', text: '<system-reminder>\nInstructions from: ~/.dsh/AGENTS.md\nBODY\n</system-reminder>' }],
  }]
  assert.equal(coordinator.filterInstructions(agent, messages).length, 0, '策略关闭的可定位文件被过滤')
})

test('指令身份：项目基线 + cwd 能定位并过滤项目消息', async (t) => {
  const h = await liveAssembly(t, () => [])
  const cwd = moduleRoot
  const baselineIdentity = JSON.stringify({ projectRoot: '.' })
  const identity = instructionFileIdentityOf('AGENTS.md', { baselineIdentity, cwd })
  assert.ok(identity.fileId)
  const current = readInstructionPolicy()
  const written = writeInstructionPolicy({ expectedRevision: current.revision, patch: { files: { [identity.fileId]: { enabled: false } } } })
  assert.equal(written.ok, true)
  const coordinator = h.root.get(PRE_STEP_COORDINATOR_SERVICE)
  const agent = { session: { id: 'identity-project', header: { cwd, delegationDepth: 0 }, snapshotEvents: () => [] } }
  const messages = [{
    id: 'm3',
    source: { kind: 'agent-instructions', changes: [{ path: 'AGENTS.md', action: 'set' }], baselineIdentity },
    content: [{ type: 'text', text: '<system-reminder>\nInstructions from: AGENTS.md\nBODY\n</system-reminder>' }],
  }]
  assert.equal(coordinator.filterInstructions(agent, messages).length, 0, '项目路径按基线根定位后被策略关闭')
})

test('R14：旧生成卡的 agents-file-* 前缀在协调器层跳过，其余配置照常注入', async (t) => {
  writeModuleFixture('legacy-file-cards', {
    modules: ['prompt-config-engine'],
    promptConfigs: [
      { id: 'agents-file-legacy', text: 'LEGACY', position: 'after-user' },
      { id: 'file-card', text: 'FILE', sourceKind: 'instruction-file', position: 'after-user' },
      { id: 'keep-card', text: 'KEEP', position: 'after-user' },
    ],
  })
  const h = await liveAssembly(t, () => ['legacy-file-cards'])
  const agent = await h.makeAgent('legacy-file-agent')
  await h.runtime.settled()
  const texts = (result) => result.messages.flatMap(message => message.content.map(block => block.text))
  // 判据只有 id 前缀：编译后的 sourceKind 恒是 `plugin:instruction-file`（schema.mjs），
  // 声明它的用户配置照常注入——删掉的 `=== 'instruction-file'` 子句本来恒假。
  assert.deepEqual(texts(await h.inject(agent)), ['USER', 'FILE', 'KEEP'])
})

test('协调器：受管规则与直接来源同批注入，释放直接来源后只留受管来源', async (t) => {
  writeModuleFixture('mixed-source', {
    modules: ['prompt-config-engine'],
    promptConfigs: [{ id: 'a-managed', text: 'MANAGED', position: 'after-user' }],
  })
  const h = await liveAssembly(t, () => ['mixed-source'])
  const agent = await h.makeAgent('mixed-source-agent')
  await h.runtime.settled()
  const { createPromptConfigs } = await import('../../engine/schema.mjs')
  const { createPreStepSource } = await import('../../engine/pre-step-source.mjs')
  const [config] = createPromptConfigs([{ id: 'z-direct', text: 'DIRECT', position: 'after-user' }])
  config.sequence = 1000
  const source = createPreStepSource({ sourceId: 'direct:mixed', ctx: agent.ctx, configs: [config] })
  const release = applyPromptConfigSources([source], { agent })
  const texts = async () => (await h.inject(agent)).messages.flatMap(message => message.content.map(block => block.text))
  assert.deepEqual(await texts(), ['USER', 'MANAGED', 'DIRECT'], '同一协调器批里按配置序号合并两个来源')
  release()
  assert.deepEqual(await texts(), ['USER', 'MANAGED'], '释放直接来源不撤回受管来源')
})

test('创建边界：agent/created 返回时首条请求已经能注入，无需额外等待队列', async (t) => {
  writeModuleFixture('first-request', {
    modules: ['prompt-config-engine'],
    promptConfigs: [{ id: 'first', text: 'FIRST', position: 'after-user' }],
  })
  const h = await liveAssembly(t, () => ['first-request'])
  const agent = await h.makeAgent('first-request-agent')
  assert.deepEqual(h.runtime.moduleIds(agent.id), ['first-request'])
  const result = await h.inject(agent)
  assert.equal(result.messages.at(-1).content[0].text, 'FIRST')
})

test('跨模块配置按文件序号交错执行，后序请求覆盖且不受启用表反转影响', async (t) => {
  for (const [moduleId, entries] of [
    ['sequence-a', [
      [10, { id: 'shared-card', text: 'A10', position: 'after-user', order: 900, group: 'shared', exclusive: true }],
      [30, { id: 'tail-card', text: 'A30', position: 'after-user', order: -900 }],
      [40, { id: 'system-a', layer: 'system-section', text: 'SYS-A', order: -50 }],
      [70, { id: 'request', layer: 'agent-request', order: -900, params: { patch: { temperature: 0.7 } } }],
    ]],
    ['sequence-b', [
      [20, { id: 'shared-card', text: 'B20', position: 'after-user', order: 0, group: 'shared', exclusive: true }],
      [50, { id: 'system-b', layer: 'system-section', text: 'SYS-B', order: -100 }],
      [60, { id: 'request', layer: 'agent-request', order: 900, params: { patch: { temperature: 0.6, maxTokens: 512 } } }],
    ]],
  ]) {
    const dir = writeModuleFixture(moduleId, { modules: ['prompt-config-engine'], promptConfigs: entries.map(([, config]) => config), configOrder: Object.fromEntries(entries.map(([sequence, config]) => [config.id, sequence])) })
    mkdirSync(join(dir, 'configs'), { recursive: true })
    for (const [sequence, config] of entries) {
      writeFileSync(join(dir, 'configs', `${String(sequence).padStart(4, '0')}-${config.id}.yml`), JSON.stringify(config), 'utf8')
    }
  }
  let enabled = ['sequence-a', 'sequence-b']
  const h = await liveAssembly(t, () => enabled)
  const agent = await h.makeAgent('sequence-agent')
  for (const reverse of [false, true]) {
    if (reverse) { enabled = [...enabled].reverse(); await h.runtime.refresh() }
    const decision = await h.inject(agent)
    const request = await h.root.waterfall(scopeTarget(agent, agent), 'agent/request', { agent }, async () => ({ temperature: 1 }))
    assert.deepEqual({
      texts: decision.messages.flatMap(message => message.content.map(block => block.text)),
      request,
    }, { texts: ['USER', 'A10', 'B20', 'A30'], request: { temperature: 0.7, maxTokens: 512 } })
    const system = await h.root.systemPrompt.assemble({ agent, scope: agent })
    assert.deepEqual(system.sections.filter(section => section.text.startsWith('SYS-')).map(section => section.text), ['SYS-A', 'SYS-B'],
      '官方 order 只决定初始槽位，configOrder 覆盖跨档位先后')
    assert.deepEqual(h.runtime.moduleIds(agent.id), enabled, '配装记录报告本 Agent 装了哪几层：顺序即启用表顺序，不随配置执行序改写')
  }
  assert.deepEqual(h.warnings, [])
})

test('持久序号调度模板求值，交错模块使用各自的持久变量', async (t) => {
  for (const [id, promptConfigs, configOrder] of [
    ['sequence-macro-a', [
      { id: 'a10', text: 'A10 {{module.set::scope::A}}{{roll::100}}', params: { templateEvaluation: true } },
      { id: 'a30', text: 'A30 {{module.get::scope}} {{roll::100}}', params: { templateEvaluation: true } },
    ], { a10: 10, a30: 30 }],
    ['sequence-macro-b', [
      { id: 'b20', text: 'B20 {{module.set::scope::B}}{{roll::100}}', params: { templateEvaluation: true } },
    ], { b20: 20 }],
  ]) {
    const dir = writeModuleFixture(id, { modules: ['prompt-config-engine'], promptConfigs })
    updateConfigOrder(dir, configOrder)
  }
  const h = await liveAssembly(t, () => ['sequence-macro-b', 'sequence-macro-a'])
  const agent = await h.makeAgent('sequence-macro-agent')
  agent.status = 'running'
  agent.session.snapshotEvents().push({ type: 'turn/start', seq: 0, data: { turn: 1 } })
  const draws = [0.1, 0.2, 0.3]
  const random = t.mock.method(Math, 'random', () => draws.shift())
  const texts = async () => (await h.inject(agent)).messages.flatMap(message => message.content.map(block => block.text))
  assert.deepEqual(await texts(), ['USER', 'A10 11', 'B20 21', 'A30 A 31'])
  assert.deepEqual(await texts(), ['USER', 'A10 11', 'B20 21', 'A30 A 31'], '同帧不重放随机宏')
  assert.equal(random.mock.callCount(), 3)
})

test('交错来源只合并连续段，保留 merged 身份与独立续跑预算', async (t) => {
  for (const [id, first, second] of [['source-a', 10, 30], ['source-b', 20, 21]]) {
    const dir = writeModuleFixture(id, {
      modules: ['prompt-config-engine'],
      promptConfigs: [
        { id: 'same-system-id', layer: 'system-section', text: `${id}-one`, mergeMode: 'merged', order: 5 },
        { id: 'second', layer: 'system-section', text: `${id}-two`, mergeMode: 'merged', order: 5 },
        { id: 'pre-one', text: `${id}-pre-one`, mergeMode: 'merged', position: 'after-user' },
        { id: 'pre-two', text: `${id}-pre-two`, mergeMode: 'merged', position: 'after-user' },
        { id: 'stop', layer: 'turn-stop', text: `${id}-stop` },
      ],
    })
    updateConfigOrder(dir, { 'same-system-id': first, second, 'pre-one': first + 100, 'pre-two': second + 100, stop: first + 200 })
  }
  const h = await liveAssembly(t, () => ['source-b', 'source-a'])
  const agent = await h.makeAgent('source-budget-agent')
  const system = await h.root.systemPrompt.assemble({ agent, scope: agent })
  const decision = await h.inject(agent)
  const messages = decision.messages.filter(message => message.source?.plugin === 'merged:after-user')
  assert.deepEqual({
    sections: system.sections.filter(section => section.text.startsWith('source-')).map(section => section.text),
    messages: messages.map(message => message.content.map(block => block.text)),
  }, {
    sections: ['source-a-one', 'source-b-one\n\nsource-b-two', 'source-a-two'],
    messages: [['source-a-pre-one'], ['source-b-pre-one', 'source-b-pre-two'], ['source-a-pre-two']],
  })
  const steered = []
  agent.steer = message => steered.push(message.content[0].text)
  const stop = () => h.root.emit(scopeTarget(agent, agent), 'agent/turn-stopping', { agent, turn: 1 })
  stop()
  stop()
  assert.deepEqual(steered, ['source-a-stop', 'source-b-stop'], '每个来源各保留一次/轮预算')
  await h.runtime.dispose()
  stop()
  assert.equal(steered.length, 2)
})

test('官方文本层同 order 的默认段按 sequence 排列，显式注册名只保留名字', async (t) => {
  for (const [id, sequence, explicitName] of [['text-order-a', 10000, 'explicit-a'], ['text-order-z', 9990, 'explicit-z']]) {
    const dir = writeModuleFixture(id, {
      modules: ['prompt-config-engine'],
      promptConfigs: [
        { id: 'system', layer: 'system-section', text: `SYSTEM-${id}`, order: 50 },
        { id: 'context', layer: 'runtime-context', text: `CONTEXT-${id}`, order: 50 },
        { id: 'explicit-system', layer: 'system-section', text: `EXPLICIT-${id}`, order: 60, params: { sectionName: explicitName } },
        { id: 'explicit-context', layer: 'runtime-context', text: `EXPLICIT-${id}`, order: 60, params: { contextName: explicitName } },
      ],
    })
    updateConfigOrder(dir, { system: sequence, context: sequence + 1, 'explicit-system': sequence + 2, 'explicit-context': sequence + 3 })
  }
  const h = await liveAssembly(t, () => ['text-order-a', 'text-order-z'])
  const agent = await h.makeAgent('text-order-agent')
  const result = await h.root.systemPrompt.assemble({ agent, scope: agent })
  for (const [kind, prefix] of [['sections', 'SYSTEM'], ['contexts', 'CONTEXT']]) {
    assert.deepEqual(result[kind].filter(entry => entry.text.startsWith(`${prefix}-`)).map(entry => entry.text),
      [`${prefix}-text-order-z`, `${prefix}-text-order-a`])
    assert.deepEqual(result[kind].filter(entry => entry.text.startsWith('EXPLICIT-')).map(entry => entry.name),
      ['explicit-z', 'explicit-a'],
      '显式名字不被改写；先后由 configOrder 覆盖（z 的序号更小）')
  }
  assert.deepEqual(h.warnings, [])
})

test('重复模块身份：跨模块同 rule id 且 dedupe=session 只告警一次，装配照常成功', async (t) => {
  // 复制模块保留 rule id，默认身份（rule:ruleId:actionId）因此跨模块重复。这是合法操作，
  // 只可见化（warnOnce + 诊断），绝不整体拒绝——整体拒绝会让该 Agent 的全部装配失败，
  // 违背「失败不伤会话」。
  for (const id of ['dup-source-a', 'dup-source-b']) {
    writeModuleFixture(id, {
      modules: ['prompt-config-engine'],
      promptConfigs: [{ id: 'shared-hint', text: `${id}-HINT`, dedupe: 'session', position: 'after-user' }],
    })
  }
  // 另一对：id 不同（plugin 身份不撞）但显式声明同一个 sourceKind，是 kind 通道那一笔账。
  for (const id of ['dup-kind-a', 'dup-kind-b']) {
    writeModuleFixture(id, {
      modules: ['prompt-config-engine'],
      promptConfigs: [{ id: `${id}-hint`, text: `${id}-KIND`, dedupe: 'session', sourceKind: 'shared-kind-channel', position: 'after-user' }],
    })
  }
  // 第三对是原 B2 的缺口形态：`config.id` 相同、其中一方显式 `identity` 取值不同。缺省
  // sourceKind 由 id 编成同一个 `plugin:gap-hint`，判据若不带模块维就跨模块互相压制。
  for (const [index, id] of ['dup-gap-a', 'dup-gap-b'].entries()) {
    writeModuleFixture(id, {
      modules: ['prompt-config-engine'],
      promptConfigs: [{ id: 'gap-hint', text: `${id}-GAP`, dedupe: 'session', position: 'after-user',
        ...(index === 0 ? {} : { identity: { field: 'plugin', value: 'dup-gap-b-identity' } }) }],
    })
  }
  const enabled = ['dup-source-a', 'dup-source-b', 'dup-kind-a', 'dup-kind-b', 'dup-gap-a', 'dup-gap-b']
  const h = await liveAssembly(t, () => enabled)
  const agent = await h.makeAgent('duplicate-identity-agent')
  assert.deepEqual(h.runtime.moduleIds(agent.id), enabled, '重复身份不影响装配成功')
  // 同一批内的候选不算「已投递」：六张卡各自注入一次。去重判据自 T5 起带模块维，
  // 复制出的两个副本因此**各自注入**——身份字符串仍逐字相同，模块维落在独立的 source.moduleId。
  const first = (await h.inject(agent)).messages
  assert.deepEqual(first.flatMap(message => message.content.map(block => block.text)).sort(),
    ['USER', 'dup-kind-a-KIND', 'dup-kind-b-KIND', 'dup-source-a-HINT', 'dup-source-b-HINT',
      'dup-gap-a-GAP', 'dup-gap-b-GAP'].sort())
  // 缺口形态的观察面：注入条数与正文。同一条 kind（`plugin:gap-hint`）下两份正文都在，
  // 说明 kind 通道不再跨模块压制；告警数不变则说明「不压制就不报警」——报它才是假警报。
  const gap = first.filter(message => message.content[0].text.endsWith('-GAP'))
  assert.deepEqual(gap.map(message => message.content[0].text).sort(), ['dup-gap-a-GAP', 'dup-gap-b-GAP'],
    '同 config.id 的两份正文都注入')
  assert.equal(new Set(gap.map(message => message.source.kind)).size, 1, '两份走的是同一条 kind（缺口形态成立）')
  assert.deepEqual(gap.map(message => message.source.moduleId).sort(), ['dup-gap-a', 'dup-gap-b'])
  const hints = first.filter(message => message.content[0].text.endsWith('-HINT'))
  assert.deepEqual(hints.map(message => message.source.moduleId).sort(), ['dup-source-a', 'dup-source-b'],
    '真实装配路径把模块维盖进注入消息的 source')
  assert.equal(new Set(hints.map(message => message.source.plugin)).size, 1, '同一份复制的身份字符串仍逐字相同')
  assert.deepEqual(h.warnings.length, 2, `两条通道各一条告警：${JSON.stringify(h.warnings)}`)
  const [identityWarning, kindWarning] = h.warnings
  assert.match(identityWarning, /疑似由复制产生同一个去重身份/)
  assert.match(identityWarning, /dup-source-a、dup-source-b/)
  assert.match(identityWarning, /去重按模块各记一份/)
  assert.match(kindWarning, /显式 sourceKind "plugin:shared-kind-channel"/)
  assert.match(kindWarning, /声明了同一个/)
  assert.match(kindWarning, /dup-kind-a、dup-kind-b/)
  // T19：同一重复身份跨 refresh() 不再重报（reportedDuplicates 是 mount 工厂级集合，刻意不
  // 刷屏；缺口形态那两组同样不因重装冒出新告警）。观察面只有告警次数与内容。
  const reported = [...h.warnings]
  await h.runtime.refresh()
  await h.runtime.refresh()
  assert.deepEqual(h.warnings, reported, `重装不新增告警：${JSON.stringify(h.warnings)}`)
})

test('kind 通道只报显式 sourceKind：缺省按配置 id 编，不按去重身份编', async (t) => {
  // ① 同一 config id、两个模块各写**不同显式 identity**，两侧都没写过 sourceKind：schema 按 **id**
  //    把缺省 kind 编成同一个 `plugin:shared-gap`。基线取去重身份的那版会把它当成显式声明 →
  //    在这一对上假警报（kind 与身份只在 identity 保持缺省时才同值）。
  for (const id of ['kind-id-a', 'kind-id-b']) {
    writeModuleFixture(id, {
      modules: ['prompt-config-engine'],
      promptConfigs: [{ id: 'shared-gap', text: `${id}-GAP`, dedupe: 'session', position: 'after-user',
        identity: { field: 'plugin', value: `${id}-identity` } }],
    })
  }
  // ② 显式声明的 sourceKind 正好等于自己的去重身份：kind 与身份逐字相同，按身份当基线的判据会把它
  //    当缺省 → 漏报。这份身份被两个模块共用，于是两个通道各一笔账。
  for (const id of ['kind-explicit-a', 'kind-explicit-b']) {
    writeModuleFixture(id, {
      modules: ['prompt-config-engine'],
      promptConfigs: [{ id: `${id}-hint`, text: `${id}-KIND`, dedupe: 'session', position: 'after-user',
        identity: { field: 'plugin', value: 'shared-explicit-identity' }, sourceKind: 'plugin:shared-explicit-identity' }],
    })
  }
  const enabled = ['kind-id-a', 'kind-id-b', 'kind-explicit-a', 'kind-explicit-b']
  const h = await liveAssembly(t, () => enabled)
  const agent = await h.makeAgent('kind-baseline-agent')
  assert.deepEqual(h.runtime.moduleIds(agent.id), enabled, '四张卡都装上：下面的告警不是装配失败')
  const kindWarnings = h.warnings.filter(message => message.includes('显式 sourceKind'))
  assert.equal(kindWarnings.length, 1, `只有真声明过的那一对报 kind 通道：${JSON.stringify(h.warnings)}`)
  assert.match(kindWarnings[0], /模块 kind-explicit-a、kind-explicit-b/)
  assert.match(kindWarnings[0], /显式 sourceKind "plugin:shared-explicit-identity"/)
  assert.match(kindWarnings[0], /声明了同一个/)
  assert.equal(h.warnings.length, 2, `①那对一无告警，②那对身份通道另有一笔：${JSON.stringify(h.warnings)}`)
  assert.match(h.warnings.find(message => !message.includes('显式 sourceKind')), /模块 kind-explicit-a、kind-explicit-b 声明了同一个去重身份 "shared-explicit-identity"/)
})

test('kind 通道的压制行为：同模块同身份算已投递，无模块维的外来消息按保守命中', async (t) => {
  // 上一轮把判据改成「模块 + 通道 + 身份」后，跨模块同身份不再互相压制（见上一条用例：T5
  // 起两副本各自注入）。「压制」只剩两种形态，各用一个 Agent 钉一条：
  // ① 同一模块内两卡撞同一显式 sourceKind：同模块才共享这份身份 → 宿主接纳后不再注入。
  //    判重只看**已交付**的消息，同批候选不算，所以首轮两张都注入。
  // ② 与当前上下文里无模块维的旧消息相撞：升级前注入的那条只有 kind、没有 source.moduleId，
  //    判据按保守命中 → 不重复注入；换成别的模块的坐标则不算命中。两条都用第二个 Agent，
  //    为的是让它们走「扫当前上下文」那条判据，而不是被同会话的已投递记账提前拦下。
  const sameKind = 'plugin:shared-same-kind'
  // 旧消息只带一个**别的生产者**的 plugin 名：能认出来的只剩显式 kind 通道。
  const seed = (label, moduleId) => ({
    id: `seed-${label}`, role: 'user', content: [{ type: 'text', text: 'OLD' }],
    source: { kind: 'plugin:shared-legacy-kind', plugin: 'foreign-producer', ...(moduleId === undefined ? {} : { moduleId }) },
  })
  const event = (message, seq) => ({ type: 'user/message', seq, data: { message } })
  writeModuleFixture('kind-suppression', {
    modules: ['prompt-config-engine'],
    promptConfigs: [
      { id: 'same-kind-a', text: 'SAME-A', dedupe: 'session', sourceKind: 'shared-same-kind', position: 'after-user' },
      { id: 'same-kind-b', text: 'SAME-B', dedupe: 'session', sourceKind: 'shared-same-kind', position: 'after-user' },
      { id: 'legacy-kind-hit', text: 'LEGACY', dedupe: 'session', sourceKind: 'shared-legacy-kind', position: 'after-user' },
    ],
  })
  const h = await liveAssembly(t, () => ['kind-suppression'])
  const texts = (result) => result.messages.flatMap((message) => message.content.map(block => block.text))
  const owned = (result) => result.messages.filter(message => message.source?.moduleId === 'kind-suppression')
  // ① 宿主接纳一条注入消息的样子：写进持久事件流，再通知 session/event（已投递由此记账）。
  const agent = await h.makeAgent('kind-suppression-agent')
  await h.runtime.settled()
  const admit = (message) => {
    const events = agent.session.snapshotEvents()
    events.push(event(message, events.length))
    h.root.emit(scopeTarget(agent.session, agent), 'session/event', agent.session, events.at(-1))
  }
  const first = await h.inject(agent)
  const same = first.messages.filter(message => message.content[0].text.startsWith('SAME-'))
  assert.deepEqual(texts(first), ['USER', 'SAME-A', 'SAME-B', 'LEGACY'], '同批候选不算已投递，三张各注入一次')
  assert.deepEqual(same.map(message => message.source.kind), [sameKind, sameKind], '撞的是同一条显式 kind 通道')
  assert.deepEqual(same.map(message => message.source.moduleId), ['kind-suppression', 'kind-suppression'], '同模块才共享这份身份')
  for (const message of owned(first)) admit(message)
  assert.deepEqual(texts(await h.inject(agent)), ['USER'], '同模块同身份：接纳后不再注入')
  // ② 两个 Agent 各放一条「升级前注入」的旧消息（无模块维），正文改写以排除按正文判重。
  const inherited = await h.makeAgent('kind-suppression-inherited')
  inherited.session.snapshotEvents().push(event(seed('inherited'), 0))
  const skipped = await h.inject(inherited)
  assert.equal(skipped.messages.some(message => message.content[0].text === 'LEGACY'), false,
    '无模块维的旧消息按保守命中算已投递')
  assert.deepEqual(texts(skipped), ['USER', 'SAME-A', 'SAME-B'], '只压掉撞身份的那一张，同模块其余卡照常')
  // ③ 同一形态换成别的模块的模块维：身份字符串一样，但这一维不同 → 不算命中，照常注入。
  const foreign = await h.makeAgent('kind-suppression-foreign')
  foreign.session.snapshotEvents().push(event(seed('foreign', 'other-module'), 0))
  const others = await h.inject(foreign)
  assert.deepEqual(texts(others), ['USER', 'SAME-A', 'SAME-B', 'LEGACY'], '别的模块的同 kind 消息不压制本模块')
  await h.runtime.dispose()
  assert.deepEqual(h.warnings, [], '单模块内撞身份不告警：告警只报跨模块那一笔账')
})

test('端到端：真实装配下「注入 → 压缩 → 再判」按当前上下文重新注入', async (t) => {
  // 单点判据（`engine/executor.mjs` 的 `currentEvents` / `contextStamp`）已由
  // `test/engine/prompt-config-engine.test.mjs` 的 T5 三条锁定；这里补的是**整条链路**：
  // 模块目录 → `compileRules` → 真实挂载 → pre-step 协调器 → 注入。压缩用宿主 surface 的
  // 真实形状（`packages/core/session/src/surface.ts:563-585`）：只有 replace 会移除节点，
  // 而成功压缩就是一次 replace（摘要替身是一条 `user/message`），append 只追加。
  writeModuleFixture('e2e-compact', {
    modules: ['prompt-config-engine'],
    promptConfigs: [{ id: 'e2e-notice', text: 'E2E-NOTICE', dedupe: 'session', position: 'after-user' }],
  })
  const h = await liveAssembly(t, () => ['e2e-compact'])
  const nodes = []
  let replaceGeneration = 0
  const agent = await h.makeAgent('e2e-compact-agent', 0, { get nodes() { return nodes }, get replaceGeneration() { return replaceGeneration } })
  await h.runtime.settled()
  const texts = (result) => result.messages.flatMap(message => message.content.map(block => block.text))
  const owned = (result) => result.messages.filter(message => message.source?.moduleId === 'e2e-compact')
  const record = (event) => {
    const events = agent.session.snapshotEvents()
    events.push(event)
    nodes.push(events.length - 1)
    h.root.emit(scopeTarget(agent.session, agent), 'session/event', agent.session, event)
  }
  const admit = (message) => record({ type: 'user/message', seq: agent.session.snapshotEvents().length, data: { message } })
  const compact = (summary) => {
    nodes.length = 0
    // 摘要替身是一条 `user/message`（宿主压缩的落盘形状），`compaction/end` 是 log-only 的复位信号。
    record({ type: 'compaction/end', seq: agent.session.snapshotEvents().length, data: {} })
    record({ type: 'user/message', seq: agent.session.snapshotEvents().length, data: { message: summary } })
    replaceGeneration += 1
  }

  const first = await h.inject(agent)
  assert.deepEqual(texts(first), ['USER', 'E2E-NOTICE'], '首轮按真实装配注入一次')
  assert.deepEqual(owned(first).map(message => message.source.moduleId), ['e2e-compact'],
    '模块维由 compileRules 的 moduleId 一路盖到注入消息')
  for (const message of owned(first)) admit(message)
  assert.deepEqual(texts(await h.inject(agent)), ['USER'], '还在当前可见上下文里 → 不再注入')

  compact({ id: 'summary', role: 'user', content: [{ type: 'text', text: '摘要' }], source: { kind: 'agent-summary' } })
  const after = await h.inject(agent)
  assert.deepEqual(owned(after).map(message => message.content[0].text), ['E2E-NOTICE'],
    '被压缩遮蔽后按当前上下文重新注入（旧判据扫全量日志 → 仍判已投递，这条会红）')
  assert.deepEqual(texts(after), ['USER', 'E2E-NOTICE'])
})

test('首次装配跳过坏模块，健康模块在主子会话继续注入，修复后恢复且释放干净', async (t) => {
  const write = (id, text, strategy = 'static') => writeModuleFixture(id, {
    modules: ['rule-engine'], promptConfigs: [{ id, text, strategy, position: 'after-user' }],
  })
  write('isolated-broken', 'RECOVERED', 'invalid')
  write('isolated-healthy', 'HEALTHY')
  const h = await liveAssembly(t, () => ['isolated-broken', 'isolated-healthy'])
  const agents = [await h.makeAgent('isolated-main'), await h.makeAgent('isolated-child', 1)]
  const texts = async agent => (await h.inject(agent)).messages.flatMap(message => message.content.map(block => block.text))
  for (const agent of agents) {
    assert.deepEqual(await texts(agent), ['USER', 'HEALTHY'])
    assert.deepEqual(h.runtime.moduleIds(agent.id), ['isolated-healthy'])
  }
  assert.ok(h.warnings.some(message => message.includes('isolated-broken')), '诊断标识故障模块')
  write('isolated-broken', 'RECOVERED')
  await h.runtime.refresh('isolated-broken')
  await h.runtime.refresh('isolated-broken')
  for (const agent of agents) {
    assert.deepEqual(await texts(agent), ['USER', 'RECOVERED', 'HEALTHY'])
    assert.deepEqual(h.runtime.moduleIds(agent.id), ['isolated-broken', 'isolated-healthy'])
  }
  const section = h.root.systemPrompt.section
  t.mock.method(h.root.systemPrompt, 'section', function (config) {
    if (config.name.includes('isolated-broken')) throw new Error('HOST-SECTION-REJECTED')
    return section.call(this, config)
  })
  writeModuleFixture('isolated-broken', { modules: ['rule-engine'], promptConfigs: [
    { id: 'isolated-broken-section', layer: 'system-section', text: 'REJECTED' },
  ] })
  write('isolated-healthy', 'HEALTHY-AFTER-RULE-FAILURE')
  await assert.rejects(h.runtime.refresh('isolated-broken'), /HOST-SECTION-REJECTED/)
  for (const agent of agents) {
    assert.deepEqual(await texts(agent), ['USER', 'RECOVERED', 'HEALTHY-AFTER-RULE-FAILURE'], '规则注册失败也只回退所属模块')
  }
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
  setModuleEnabled(moduleRoot, 'hot-a', true)
  await h.runtime.refresh()
  assert.deepEqual(await injected(), ['USER', 'hot-a'])
  setModuleEnabled(moduleRoot, 'hot-b', true)
  await h.runtime.refresh()
  await h.runtime.refresh()
  assert.deepEqual(await injected(), ['USER', 'hot-a', 'hot-b'])
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
  writeModuleFixture('hot-b', {
    modules: ['prompt-config-engine'],
    promptConfigs: [{ id: 'hot-b', strategy: 'invalid', text: 'BROKEN' }],
  })
  writeModuleFixture('hot-a', {
    modules: ['rule-engine'], promptConfigs: [{ id: 'hot-a', text: 'HEALTHY-UPDATE', position: 'after-user' }],
  })
  await assert.rejects(h.runtime.refresh('hot-b'), /运行时配装更新失败/)
  assert.deepEqual(await injected(), ['USER', 'HEALTHY-UPDATE', 'hot-b'], '仅故障模块保旧，健康模块更新')
  writeFileSync(join(moduleRoot, 'hot-b', 'module.yml'), 'rules: [')
  writeModuleFixture('hot-a', {
    modules: ['rule-engine'], promptConfigs: [{ id: 'hot-a', text: 'HEALTHY-AFTER-PARSE-ERROR', position: 'after-user' }],
  })
  await assert.rejects(h.runtime.refresh(), /运行时配装更新失败/)
  assert.deepEqual(await injected(), ['USER', 'HEALTHY-AFTER-PARSE-ERROR', 'hot-b'], '坏文件不通过签名读取阻止其他模块更新')
  assert.ok(h.runtime.publicationFailures().some(failure => failure.moduleId === undefined), '全量失败有诊断')
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

test('模块增量发布：修改 B 只替换 B 的能力和规则，未改 A/C 保持原贡献', async (t) => {
  const ids = ['increment-a', 'increment-b', 'increment-c']
  const write = (id, text) => writeModuleFixture(id, {
    modules: ['rule-engine', 'retrieval'],
    moduleConfigs: { retrieval: { enabled: true } },
    promptConfigs: [{ id: `${id}-text`, layer: 'system-section', text }],
  })
  for (const id of ids) write(id, `${id}-OLD`)
  const applied = [], released = []
  const h = await liveAssembly(t, () => ids, {
    beforeCoordinator: root => root.provide('pt-retrieval', {
      mount(_ctx, _config, options) {
        applied.push(options.sourceModuleId)
        return () => released.push(options.sourceModuleId)
      },
    }),
  })
  const agents = [await h.makeAgent('increment-main'), await h.makeAgent('increment-child', 1)]
  applied.length = released.length = 0
  write('increment-b', 'increment-b-UPDATED')
  await h.runtime.refresh('increment-b')
  assert.deepEqual(applied, ['increment-b', 'increment-b'])
  assert.deepEqual(released, ['increment-b', 'increment-b'])
  for (const agent of agents) {
    const system = await h.root.systemPrompt.assemble({ agent, scope: agent })
    assert.deepEqual(system.sections.filter(section => section.text.startsWith('increment-')).map(section => section.text),
      ['increment-a-OLD', 'increment-b-UPDATED', 'increment-c-OLD'])
  }
  const readers = new Map()
  for (const agent of agents) await agent.ctx.plugin({ inject: ['systemPrompt'], apply(ctx) {
    readers.set(agent, () => ctx.systemPrompt.assemble({ agent, scope: agent }))
  } })
  applied.length = released.length = 0
  write('increment-b', 'increment-b-COALESCED')
  h.runtime.schedule('increment-b')
  h.runtime.schedule('increment-b')
  const system = await readers.get(agents[0])()
  assert.ok(system.sections.some(section => section.text === 'increment-b-COALESCED'), '官方装配提前消费同一待发布集合')
  await h.runtime.settled()
  assert.deepEqual(applied, ['increment-b', 'increment-b'], '提前消费后定时器不重复重挂')
  applied.length = released.length = 0
  write('increment-disabled', 'DISABLED')
  h.runtime.schedule('increment-disabled')
  await readers.get(agents[0])()
  assert.deepEqual(applied, [], '未启用且非人设来源的保存不重挂')
  write('increment-b', 'CANCELED')
  h.runtime.schedule('increment-b')
  await h.runtime.dispose()
  await h.runtime.settled()
  assert.deepEqual(applied, [], '释放取消尚未开始的发布')
  assert.deepEqual(h.warnings, [])
})

test('PTC：主子模式独立进入工具面，刷新与压缩保留受众，释放恢复默认', async (t) => {
  const id = 'audience-presentation'
  const write = (mainMode, subagentMode) => writeModuleFixture(id, {
    modules: ['present-as'], moduleConfigs: { 'present-as': { mainMode, subagentMode } },
  })
  write('ptc', 'native')
  const h = await liveAssembly(t, () => [id])
  h.root.provide('ptcRuntime', { language: 'typescript' })
  h.root.tools.register({ name: 'visible_tool', description: 'visible',
    parameters: { type: 'object', properties: {} }, output: { schema: { type: 'object' }, render: () => [] }, execute: async () => ({}),
  })
  const main = await h.makeAgent('presentation-main')
  const child = await h.makeAgent('presentation-child', 1)
  const names = agent => h.root.tools.wireSchemas(agent).schemas.map(tool => tool.name)
  assert.deepEqual(names(main), ['run_code'])
  assert.deepEqual(names(child), ['visible_tool'])
  for (const agent of [main, child]) {
    const event = { seq: 1, type: 'compaction/end', data: {} }
    agent.session.snapshotEvents().push(event)
    h.root.emit(scopeTarget(agent.session, agent), 'session/event', agent.session, event)
  }
  await h.runtime.refresh(id)
  assert.deepEqual(names(main), ['run_code'])
  assert.deepEqual(names(child), ['visible_tool'])
  write('native', 'ptc')
  await h.runtime.refresh(id)
  assert.deepEqual(names(main), ['visible_tool'])
  assert.deepEqual(names(child), ['run_code'])
  assert.deepEqual(h.warnings, [])
  await h.runtime.dispose()
  for (const agent of [main, child]) assert.deepEqual(names(agent), ['visible_tool'])
})

test('晚到能力初始化失败只撤所属模块，健康模块继续且显式重试可恢复', async (t) => {
  const writeHealthy = text => writeModuleFixture('late-healthy', {
    modules: ['rule-engine'], promptConfigs: [{ id: 'late-healthy', text, position: 'after-user' }],
  })
  writeModuleFixture('late-failed', {
    modules: ['tool-config-engine', 'present-as'], moduleConfigs: { 'present-as': { enabled: true, mode: 'ptc' } },
    customTools: [{ id: 'late_partial_tool', description: 'temporary', output: { schema: { type: 'json' } }, execute: { kind: 'delegate', tool: 'known_tool' } }],
    promptConfigs: [{ id: 'late-failed', text: 'LATE-RULE', position: 'after-user' }],
  })
  writeHealthy('HEALTHY')
  const h = await liveAssembly(t, () => ['late-failed', 'late-healthy'])
  let rejected = true
  let attempts = 0
  const presentAs = h.root.tools.presentAs
  t.mock.method(h.root.tools, 'presentAs', function (mode, ...args) {
    if (mode === 'ptc') { attempts++; if (rejected) throw new Error('LATE-INITIALIZATION-REJECTED') }
    return presentAs.call(this, mode, ...args)
  })
  const agents = [await h.makeAgent('late-main'), await h.makeAgent('late-child', 1)]
  const assemble = new Map()
  for (const agent of agents) await agent.ctx.plugin({ inject: ['systemPrompt'], apply(ctx) {
    assemble.set(agent, () => ctx.systemPrompt.assemble({ agent, scope: agent }))
  } })
  const texts = async agent => (await h.inject(agent)).messages.flatMap(message => message.content.map(block => block.text))
  for (const agent of agents) assert.deepEqual(await texts(agent), ['USER', 'LATE-RULE', 'HEALTHY'], '正常等待服务不误判失败')
  assert.equal(attempts, 0)
  const removePtc = h.root.provide('ptcRuntime', { language: 'typescript' })
  await h.runtime.settled()
  for (const agent of agents) {
    assert.deepEqual(await texts(agent), ['USER', 'HEALTHY'])
    assert.deepEqual(h.runtime.moduleIds(agent.id), ['late-healthy'])
    assert.equal(h.root.tools.schemas(agent).some(tool => tool.name === 'late_partial_tool'), false)
  }
  assert.ok(h.warnings.some(message => message.includes('late-failed') && message.includes('LATE-INITIALIZATION-REJECTED')))
  assert.ok(h.runtime.publicationFailures().some(failure => failure.message.includes('LATE-INITIALIZATION-REJECTED')), '晚到失败进入同一发布诊断')
  const rejectedAttempts = attempts
  writeHealthy('HEALTHY-UPDATED')
  for (const agent of agents) {
    await assemble.get(agent)()
    assert.deepEqual(await texts(agent), ['USER', 'HEALTHY-UPDATED'])
  }
  await h.runtime.settled()
  assert.equal(attempts, rejectedAttempts, '其他模块更新不重试同一失败定义')
  rejected = false
  await removePtc()
  await h.runtime.refresh('late-failed')
  h.root.provide('ptcRuntime', { language: 'typescript' })
  await h.runtime.settled()
  for (const agent of agents) {
    assert.deepEqual(await texts(agent), ['USER', 'LATE-RULE', 'HEALTHY-UPDATED'])
    assert.deepEqual(h.runtime.moduleIds(agent.id), ['late-failed', 'late-healthy'])
    assert.deepEqual(h.root.tools.wireSchemas(agent).schemas.map(tool => tool.name), ['run_code'], '晚到服务成功后真实PTC呈现已生效')
  }
  await h.runtime.dispose()
  for (const agent of agents) {
    assert.deepEqual(await texts(agent), ['USER'])
    assert.deepEqual(h.root.tools.schemas(agent), [])
  }
})

test('连续等待中的新版本失败时回退最后完成初始化的旧模块', async (t) => {
  const write = (text, mode) => writeModuleFixture('late-version', {
    modules: ['present-as'], moduleConfigs: { 'present-as': { enabled: true, mode } },
    promptConfigs: [{ id: 'late-version', text, position: 'after-user' }],
  })
  write('READY-OLD', 'native')
  writeModuleFixture('late-version-persona', { modules: [] })
  let personaPrefix = 'ORIGINAL-PERSONA'
  const h = await liveAssembly(t, () => ['late-version'], { personaModules: () => [{
    moduleId: 'late-version-persona', persona: { main: { prefix: personaPrefix }, subagent: { prefix: personaPrefix } },
  }] })
  const agents = [await h.makeAgent('late-version-main'), await h.makeAgent('late-version-child', 1)]
  const texts = async agent => (await h.inject(agent)).messages.flatMap(message => message.content.map(block => block.text))
  for (const agent of agents) assert.deepEqual(await texts(agent), ['USER', 'READY-OLD'])
  write('PENDING-ONE', 'ptc')
  await h.runtime.refresh('late-version')
  write('PENDING-TWO', 'ptc')
  await h.runtime.refresh('late-version')
  let failOnce = true
  const section = h.root.systemPrompt.section
  t.mock.method(h.root.systemPrompt, 'section', function (value) {
    if (failOnce && scopeOf(this.ctx) === agents[1]) { failOnce = false; throw new Error('PUBLIC-PERSONA-REJECTED') }
    return section.call(this, value)
  })
  write('ABORTED-NEW', 'native')
  personaPrefix = 'ABORTED-PERSONA'
  await assert.rejects(h.runtime.refresh('late-version'), /PUBLIC-PERSONA-REJECTED/)
  for (const agent of agents) assert.deepEqual(await texts(agent), ['USER', 'PENDING-TWO'])
  personaPrefix = 'ORIGINAL-PERSONA'
  write('PENDING-TWO', 'ptc')
  const presentAs = h.root.tools.presentAs
  t.mock.method(h.root.tools, 'presentAs', function (mode, ...args) {
    if (mode === 'ptc') throw new Error('LATE-VERSION-REJECTED')
    return presentAs.call(this, mode, ...args)
  })
  h.root.provide('ptcRuntime', { language: 'typescript' })
  await h.runtime.settled()
  for (const agent of agents) {
    assert.deepEqual(await texts(agent), ['USER', 'READY-OLD'])
    assert.deepEqual(h.runtime.moduleIds(agent.id), ['late-version'])
  }
})

test('共享初始化失败只影响声明来源，已替换实例和无关插件的迟到错误失效', async (t) => {
  const write = (id, text, modules = ['module-rule-tools']) => writeModuleFixture(id, {
    modules, promptConfigs: [{ id, text, position: 'after-user' }],
  })
  for (const id of ['shared-late-a', 'shared-late-b']) write(id, id)
  write('shared-late-healthy', 'HEALTHY', ['rule-engine'])
  let enabled = ['shared-late-a', 'shared-late-b', 'shared-late-healthy']
  const h = await liveAssembly(t, () => enabled)
  let rejection = true
  let waitForRelease
  let started
  h.root.provide('pt-module-rule-tools', { mount: ctx => {
    const fiber = ctx.inject(['lateSharedService'], async toolsCtx => {
      toolsCtx.tools.register({ name: 'late_shared_tool', description: 'shared', parameters: { type: 'object', properties: {} },
        output: { schema: { type: 'object' }, render: () => [] }, execute: async () => ({}),
      })
      started?.()
      if (waitForRelease) await waitForRelease
      if (rejection) throw new Error('SHARED-INITIALIZATION-REJECTED')
    })
    return () => { void fiber.dispose() }
  } })
  const agent = await h.makeAgent('shared-late-agent')
  const texts = async () => (await h.inject(agent)).messages.flatMap(message => message.content.map(block => block.text))
  h.root.provide('lateSharedService', {})
  await h.runtime.settled()
  assert.deepEqual(await texts(), ['USER', 'HEALTHY'])
  assert.deepEqual(h.runtime.moduleIds(agent.id), ['shared-late-healthy'])
  assert.deepEqual(h.root.tools.schemas(agent), [])
  assert.ok(h.warnings.some(message => message.includes('shared-late-a')))
  assert.ok(h.warnings.some(message => message.includes('shared-late-b')))

  rejection = false
  await h.runtime.refresh()
  assert.equal(h.root.tools.schemas(agent).filter(tool => tool.name === 'late_shared_tool').length, 1)
  let finishLate
  waitForRelease = new Promise(resolve => { finishLate = resolve })
  const entered = new Promise(resolve => { started = resolve })
  // 新来源在加载中；下一次更新排队后，旧初始化才拒绝。
  write('shared-late-a', 'WAITING-OLD')
  enabled = ['shared-late-a', 'shared-late-healthy']
  const loading = h.runtime.refresh('shared-late-a')
  await entered
  write('shared-late-a', 'CURRENT', ['rule-engine'])
  enabled = ['shared-late-a', 'shared-late-healthy']
  const replacing = h.runtime.refresh('shared-late-a')
  rejection = true
  finishLate()
  await assert.rejects(loading, /SHARED-INITIALIZATION-REJECTED/)
  await replacing
  await h.runtime.settled()
  assert.deepEqual(await texts(), ['USER', 'CURRENT', 'HEALTHY'])
  assert.deepEqual(h.runtime.moduleIds(agent.id), ['shared-late-a', 'shared-late-healthy'])
  const unrelated = agent.ctx.plugin({ name: 'unrelated-late', apply(ctx) {
    ctx.inject(['lateSharedService'], () => { throw new Error('UNRELATED-INITIALIZATION-REJECTED') })
  } })
  await unrelated
  await h.runtime.settled()
  assert.deepEqual(await texts(), ['USER', 'CURRENT', 'HEALTHY'])
  assert.equal(h.warnings.some(message => message.includes('UNRELATED-INITIALIZATION-REJECTED')), false)
  writeModuleFixture('shared-late-a', {
    modules: ['present-as'], moduleConfigs: { 'present-as': { enabled: true, mode: 'ptc' } },
    promptConfigs: [{ id: 'shared-late-a', text: 'PENDING-DISPOSE', position: 'after-user' }],
  })
  await h.runtime.refresh('shared-late-a')
  await h.runtime.dispose()
  h.root.provide('ptcRuntime', { language: 'typescript' })
  await h.runtime.settled()
  await unrelated.dispose()
  assert.deepEqual(await texts(), ['USER'])
  assert.deepEqual(h.root.tools.schemas(agent), [])
})

test('能力挂载失败按模块回退，半注册工具撤销且健康来源共享工具保留', async (t) => {
  const tool = id => ({ id, description: id, output: { schema: { type: 'json' } }, execute: { kind: 'delegate', tool: 'shared_tool' } })
  const writeBroken = (text, mode, toolId) => writeModuleFixture('mount-broken', {
    modules: ['module-rule-tools', 'tool-config-engine', 'present-as'],
    customTools: [tool(toolId)], moduleConfigs: { 'present-as': { enabled: true, mode } },
    promptConfigs: [{ id: 'mount-broken', text, position: 'after-user' }],
  })
  const writeHealthy = text => writeModuleFixture('mount-healthy', {
    modules: ['module-rule-tools'], promptConfigs: [{ id: 'mount-healthy', text, position: 'after-user' }],
  })
  writeBroken('BAD-INITIAL', 'native', 'partial_tool')
  writeHealthy('HEALTHY-INITIAL')
  const h = await liveAssembly(t, () => ['mount-broken', 'mount-healthy'])
  h.root.provide('ptcRuntime', { language: 'typescript' })
  h.root.provide('pt-module-rule-tools', { mount: ctx => ctx.tools.register({
    name: 'shared_tool', description: 'shared', parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'object' }, render: () => [] }, execute: async () => ({}),
  }) })
  const presentAs = h.root.tools.presentAs
  t.mock.method(h.root.tools, 'presentAs', function (mode, ...args) {
    if (mode === 'native') throw new Error('HOST-PRESENTATION-REJECTED')
    return presentAs.call(this, mode, ...args)
  })
  const agents = [await h.makeAgent('mount-isolation-main'), await h.makeAgent('mount-isolation-child', 1)]
  const texts = async agent => (await h.inject(agent)).messages.flatMap(message => message.content.map(block => block.text))
  const names = agent => h.root.tools.schemas(agent).map(schema => schema.name)
  for (const agent of agents) {
    assert.deepEqual(await texts(agent), ['USER', 'HEALTHY-INITIAL'])
    assert.deepEqual(h.runtime.moduleIds(agent.id), ['mount-healthy'])
    assert.deepEqual(names(agent), ['shared_tool'], '失败模块的半注册工具撤销，共享工具仍有健康使用者')
  }
  assert.ok(h.warnings.some(message => message.includes('mount-broken') && message.includes('HOST-PRESENTATION-REJECTED')))
  writeBroken('OLD-BROKEN', 'ptc', 'old_tool')
  await h.runtime.refresh('mount-broken')
  writeBroken('REJECTED-NEW', 'native', 'rejected_tool')
  writeHealthy('HEALTHY-UPDATED')
  await assert.rejects(h.runtime.refresh('mount-broken'), /HOST-PRESENTATION-REJECTED/)
  for (const agent of agents) {
    assert.deepEqual(await texts(agent), ['USER', 'OLD-BROKEN', 'HEALTHY-UPDATED'])
    assert.deepEqual(names(agent).sort(), ['old_tool', 'run_code', 'shared_tool'])
    assert.deepEqual(h.runtime.moduleIds(agent.id), ['mount-broken', 'mount-healthy'])
  }
  let registrations = 0
  const off = h.root.on('system-prompt/change', () => { registrations++ })
  for (const agent of agents) await texts(agent)
  assert.equal(registrations, 0, '同一失败版本不会每请求反复撤装')
  off()
  const mainCtx = agents[0].ctx
  agents[0].ctx = new Proxy(mainCtx, { get(target, key) {
    if (key === 'get') return (name, ...args) => name === 'pt-module-rule-tools' ? undefined : mainCtx.get(name, ...args)
    return Reflect.get(target, key)
  } })
  writeModuleFixture('mount-healthy', {
    modules: ['rule-engine'], promptConfigs: [{ id: 'mount-healthy', text: 'HEALTHY-WITHOUT-SERVICE', position: 'after-user' }],
  })
  await assert.rejects(h.runtime.refresh(), /pt-module-rule-tools/)
  assert.deepEqual(await texts(agents[0]), ['USER', 'HEALTHY-WITHOUT-SERVICE'], '旧版本依赖也缺失时跳过故障模块，健康模块不被挂起')
  assert.deepEqual(h.runtime.moduleIds(agents[0].id), ['mount-healthy'])
  assert.deepEqual(names(agents[0]), [])
  assert.deepEqual(await texts(agents[1]), ['USER', 'OLD-BROKEN', 'HEALTHY-WITHOUT-SERVICE'], '子代理仍有服务，继续保留其有效旧模块')
  await h.runtime.dispose()
  for (const agent of agents) {
    assert.deepEqual(names(agent), [])
    assert.deepEqual(await texts(agent), ['USER'])
  }
})

test('能力注册：私有工具服务与内联工具接入官方注册表，禁用后释放', async (t) => {
  const dir = writeModuleFixture('live-tools', { modules: ['module-rule-tools', 'tool-config-engine'] })
  const { writeModule: materialize } = await import('../../src/host/write-module.ts')
  writeFileSync(join(dir, 'module.yml'), JSON.stringify({
    id: 'live-tools', name: 'live-tools', modules: ['module-rule-tools', 'tool-config-engine'],
    layerSettings: { 'agent-request': { modelTemperature: '0.25' } },
    customTools: [{ id: 'delegated_tool', description: 'delegate', output: { schema: { type: 'json' } }, execute: { kind: 'delegate', tool: 'assembly_tool' } }],
    rules: [{ id: 'runtime-trigger', layer: 'pre-step', then: [{ id: 'inject', kind: 'inject-text', config: {
      id: 'trigger-text', layer: 'pre-step', text: 'TRIGGER', position: 'after-user',
    } }] }],
    configOrder: { 'runtime-trigger': 0 },
  }), 'utf8')
  materialize({ modulesRoot: moduleRoot, moduleId: 'live-tools', agentsInstructionText: '' })
  const h = await liveAssembly(t, () => ['live-tools'])
  const tool = {
    name: 'assembly_tool', description: 'assembly tool',
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'object' }, render: () => [] },
    execute: async () => ({}),
  }
  h.root.provide('pt-module-rule-tools', { mount: (ctx) => ctx.tools.register(tool) })
  const agent = await h.makeAgent('tools-agent')
  assert.deepEqual(h.warnings, [])
  assert.equal(h.root.tools.schemas(agent).filter(schema => schema.name === 'assembly_tool').length, 1)
  assert.equal(h.root.tools.schemas(agent).filter(schema => schema.name === 'delegated_tool').length, 1)
  assert.equal((await h.inject(agent)).messages.at(-1).content[0].text, 'TRIGGER')
  const request = () => h.root.waterfall(scopeTarget(agent, agent), 'agent/request', { agent }, async () => ({ temperature: 1 }))
  assert.equal((await request()).temperature, 0.25)
  await h.runtime.refresh()
  assert.equal(h.root.tools.schemas(agent).filter(schema => schema.name === 'assembly_tool').length, 1)
  await h.runtime.dispose()
  assert.equal(h.root.tools.schemas(agent).some(schema => schema.name === 'assembly_tool'), false)
  assert.equal(h.root.tools.schemas(agent).some(schema => schema.name === 'delegated_tool'), false)
  assert.equal((await h.inject(agent)).messages.length, 1)
  assert.equal((await request()).temperature, 1)
})

/** 手写字面量切片：真值源，不经任何被测代码生成。 */
const LITERAL_SLICES = [
  {
    id: 'near-anchor',
    name: '首句锚点',
    enabled: true,
    strategy: 'static',
    layer: 'pre-step',
    order: 0,
    role: 'user',
    position: 'after-user',
    dedupe: 'session',
    promotion: 'none',
    audience: 'main',
  },
  {
    id: 'router-guide',
    name: '每轮引导',
    enabled: true,
    strategy: 'static',
    layer: 'pre-step',
    order: 10,
    role: 'user',
    position: 'after-user',
    dedupe: 'batch',
    promotion: 'main',
    audience: 'subagent',
    modelScope: 'flash',
  },
]

function writeModuleFixture(id, { modules, promptConfigs = [], rules = [], moduleConfigs, persona, configOrder, variables, customTools }) {
  const dir = join(moduleRoot, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'module.yml'), `${JSON.stringify({
    id, name: id, modules: [...new Set(modules.map(name => ['prompt-config-engine', 'declared-triggers'].includes(name) ? 'rule-engine' : name))],
    rules: [...rules, ...promptConfigs.map(config => config.layer === 'agent-request'
      ? { id: config.id, layer: 'agent-request', then: [{ id: 'request', kind: 'request-params', patch: config.params.patch }] }
      : fixtureRule(config))], ...(configOrder === undefined ? {} : { configOrder }),
    ...(moduleConfigs === undefined ? {} : { moduleConfigs }), ...(persona === undefined ? {} : { persona }),
    ...(variables === undefined ? {} : { variables }),
    ...(customTools === undefined ? {} : { customTools }),
  }, null, 2)}\n`, 'utf8')
  if (promptConfigs.length > 0) {
    const configsDir = join(dir, 'configs')
    mkdirSync(configsDir, { recursive: true })
    for (const [index, config] of promptConfigs.entries()) {
      writeFileSync(join(configsDir, `${index}-${config.id}.yml`), `${JSON.stringify(config, null, 2)}\n`, 'utf8')
    }
  }
  return dir
}

function updateConfigOrder(dir, configOrder) {
  const file = join(dir, 'module.yml')
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), configOrder }))
}

test('受管字段一律解析到当前预设目录内', async () => {
  const id = 'managed-paths'
  const dir = join(moduleRoot, id)
  writeModuleFixture(id, {
    modules: ['prompt-config-engine', 'tool-config-engine', 'declared-triggers'],
    moduleConfigs: {
      // 新形态：预设目录基准。
      'tool-config-engine': { configsDir: './custom-tools' },
    },
  })
  mkdirSync(join(dir, 'custom-tools'), { recursive: true })

  const prepared = await prepareAssembly(moduleRoot, id, hasEveryService)
  const configOf = (moduleId) => prepared.modules.find((module) => module.id === moduleId)?.config ?? {}

  const cases = [
    ['tool-config-engine', 'configsDir', join(dir, 'custom-tools')],
  ]
  for (const [moduleId, field, expectedPath] of cases) {
    const value = configOf(moduleId)[field]
    assert.equal(typeof value, 'string', `${moduleId}.${field} 已换算`)
    assert.equal(fileURLToPath(value), expectedPath, `${moduleId}.${field} 的落点`)
  }
})

test('模块清单：私有能力复用现有适配器挂载服务', async () => {
  writeModuleFixture('module-roster', {
    modules: ['module-rule-tools', 'tool-config-engine'],
  })
  const prepared = await prepareAssembly(moduleRoot, 'module-roster', hasEveryService)

  // 私有能力复用现有适配器挂载服务，而不是只登记依赖。
  assert.equal(prepared.services.has('pt-module-rule-tools'), true)
})

test('拒绝路径：非法 id、无效模块声明、缺失宿主能力都在装配前 fail loud', async () => {
  await assert.rejects(
    prepareAssembly(moduleRoot, 'Not_An_Id', hasEveryService),
    /非法模块 id/,
  )
  writeModuleFixture('unknown-capability', { modules: ['no-such-capability-anywhere'] })
  await assert.rejects(
    prepareAssembly(moduleRoot, 'unknown-capability', hasEveryService),
    /模块声明无效/,
  )
  writeModuleFixture('requires-missing-service', { modules: ['prompt-config-engine'], promptConfigs: LITERAL_SLICES })
  await assert.rejects(
    prepareAssembly(moduleRoot, 'requires-missing-service', () => false),
    /配装所需宿主能力不可用/,
  )
})

test('「独占」段唯一性：聚合选中人设及跨模块规则，准备拒绝保留所有 Agent 的旧贡献', async t => {
  // 真值源：宿主 system-prompt 对「多于一个生效 complete 段」直接抛错
  // （packages/core/system-prompt/src/index.ts:597-600）。写门控只覆盖两个 bridge 端点，
  // 手改 YAML / 还原备份 / 导入包能绕过，这里钉住装配期的那道兜底。
  const exclusive = (id, enabled = true) => ({
    id,
    enabled,
    layer: 'system-section',
    strategy: 'static',
    order: 0,
    text: `${id} 正文`,
    params: { complete: true },
  })

  // ① 两个启用的独占配置 → 装配前 fail loud。
  writeModuleFixture('double-complete', {
    modules: ['prompt-config-engine'],
    promptConfigs: [exclusive('excl-a'), exclusive('excl-b')],
  })
  await assert.rejects(
    prepareAssembly(moduleRoot, 'double-complete', hasEveryService),
    /多个生效的「独占」段|multiple complete system sections/,
    '两个启用 complete 必须被拒',
  )

  // 未选中的人设只是定义；不能在单模块准备阶段限制其普通规则。
  writeModuleFixture('persona-complete', {
    modules: ['prompt-config-engine'],
    promptConfigs: [exclusive('excl-a')],
    persona: { main: { prefix: 'PREFIX', complete: true } },
  })
  assert.equal((await prepareAssembly(moduleRoot, 'persona-complete', hasEveryService)).rules.length, 1)

  // ③ 边界一：第二个独占被 `enabled: false` 关掉 → 不算冲突。
  writeModuleFixture('one-complete-disabled', {
    modules: ['prompt-config-engine'],
    promptConfigs: [exclusive('excl-a'), exclusive('excl-b', false)],
  })
  const allowed = await prepareAssembly(moduleRoot, 'one-complete-disabled', hasEveryService)
  assert.equal(allowed.rules.length, 2, '禁用的规则仍进装配输入（由引擎过滤 enabled）')

  // ④ 边界二：单独一个独占（无人设）→ 放行，且人设存在但未开独占也放行。
  writeModuleFixture('single-complete', {
    modules: ['prompt-config-engine'],
    promptConfigs: [exclusive('excl-a')],
    persona: { main: { prefix: 'PREFIX' } },
  })
  const single = await prepareAssembly(moduleRoot, 'single-complete', hasEveryService)
  assert.equal(single.rules.length, 1, '单个独占段正常装配')

  writeModuleFixture('exclusive-live', { modules: [], promptConfigs: [{ id: 'old', text: 'OLD', position: 'after-all' }] })
  writeModuleFixture('selected-persona', { modules: [], persona: { main: { prefix: 'SELECTED', complete: false }, subagent: { prefix: 'CHILD', complete: false } } })
  const root = new Context(), actors = [], scopes = [], warnings = []
  // Loader 只替代模块解析；声明按官方 Persona 的公开字段注册到真实 SystemPrompt。
  const OfficialPersona = { name: 'fixture-official-persona', inject: ['systemPrompt'], apply(ctx, config) {
    ctx.systemPrompt.section({ name: 'deployment:persona-prefix', order: 0, text: config.prefix, complete: config.complete })
    ctx.systemPrompt.section({ name: 'deployment:persona-suffix', order: 10200, text: config.suffix ?? '' })
  } }
  root.provide('loader', { import: async name => { assert.equal(name, '@deepseek-ai/dsh-persona'); return OfficialPersona }, unwrapExports: value => value })
  let persona, driver
  await root.plugin({ name: 'test-persona-early', apply(ctx) { persona = installPersonaCapture(ctx) } })
  await root.plugin(SystemPrompt)
  await root.plugin(ToolRuntime)
  root.provide('llm', {})
  root.provide('agents', { list: () => actors, async create(options) {
    const agent = { id: options.sessionId, status: 'idle', options: {}, session: { id: options.sessionId, header: options.meta ?? {}, snapshotEvents: () => [] } }
    const scope = createScope(driver, agent); scopes.push(scope); agent.ctx = scope.ctx
    bindScopeParent(scopeOf(agent.ctx), scopeOf(standing.ctx))
    await options.setup?.(agent.ctx, agent)
    actors.push(agent)
    await root.serial(scopeTarget(agent, agent), 'agent/created', { agent, source: 'startup' })
    return agent
  } })
  await root.plugin({ name: 'test-persona-driver', inject: ['agents', 'systemPrompt'], apply(ctx) { driver = ctx } })
  const standing = createScope(driver, {})
  scopes.push(standing)
  await standing.ctx.plugin(OfficialPersona, { prefix: 'OFFICIAL', complete: true })
  let selected = 'selected-persona', enabled = ['exclusive-live']
  const selectedModules = () => selected === undefined ? [] : [{ moduleId: selected, persona: loadModuleSpec(join(moduleRoot, selected)).persona }]
  const runtime = createAgentAssembly(root, { moduleRoot, enabledModules: () => enabled, personaModules: selectedModules, personaCapture: persona, warn: message => warnings.push(message) })
  t.after(async () => { await runtime.dispose(); for (const scope of scopes.reverse()) await scope.dispose(); await root.fiber.dispose() })
  const main = await driver.agents.create({ sessionId: 'exclusive-main' })
  const child = await driver.agents.create({ sessionId: 'exclusive-child', meta: { origin: 'subagent', delegationDepth: 1 } })
  const stepTexts = async agent => (await root.waterfall(scopeTarget(agent, agent), 'agent/pre-step', { agent, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [] }))).messages.flatMap(message => message.content.map(block => block.text))
  const sectionTexts = async agent => (await root.systemPrompt.assemble({ agent, scope: agent })).sections.map(section => section.text)
  for (const agent of [main, child]) assert.deepEqual(await stepTexts(agent), ['OLD'])
  assert.ok((await sectionTexts(main)).includes('SELECTED'))
  assert.ok((await sectionTexts(child)).includes('CHILD'))
  assert.deepEqual(runtime.moduleIds(main.id), ['exclusive-live'], '选择人设不启用来源模块的普通规则')

  // 人设 complete:false 遮蔽官方 complete：规则独占与它不再互相误报，规则段成为唯一系统段。
  writeModuleFixture('exclusive-live', { modules: [], promptConfigs: [{ ...exclusive('one'), audience: 'main' }] })
  await runtime.refresh()
  assert.deepEqual(await sectionTexts(main), ['one 正文'])
  assert.ok((await sectionTexts(child)).includes('CHILD'), '子代理不受主会话规则的 complete 影响')

  // 人设显式 complete:true 与同受众规则 complete 冲突：撤旧之前拒绝，旧装配原样保留。
  writeModuleFixture('selected-persona', { modules: [], persona: { main: { prefix: 'NEW', complete: true }, subagent: { prefix: 'CHILD', complete: false } } })
  await assert.rejects(runtime.refresh(), /多个生效 complete/)
  assert.deepEqual(await sectionTexts(main), ['one 正文'])
  assert.ok((await sectionTexts(child)).includes('CHILD'))
  assert.deepEqual(runtime.moduleIds(main.id), ['exclusive-live'])

  // 不同受众的独占可跨来源共存：主会话由规则独占，子代理由人设独占。
  writeModuleFixture('selected-persona', { modules: [], persona: { main: { prefix: 'NEW', complete: false }, subagent: { prefix: 'CHILD', complete: true } } })
  await runtime.refresh()
  assert.deepEqual(await sectionTexts(child), ['CHILD'], '子代理人设独占')
  assert.deepEqual(await sectionTexts(main), ['one 正文'], '主会话仍由规则独占')

  // 来源文件坏掉时拒绝刷新，两个受众都保持上一个有效装配。
  writeFileSync(join(moduleRoot, 'selected-persona', 'module.yml'), 'id: selected-persona\nmodules: []\npersona: [bad]\n')
  await assert.rejects(runtime.refresh(), /persona/)
  assert.deepEqual(await sectionTexts(child), ['CHILD'])
  assert.deepEqual(await sectionTexts(main), ['one 正文'])
})

test('固定系统段：独占和上下文抑制只作用目标受众，主子分别独占并可释放', async t => {
  const root = new Context()
  await root.plugin(SystemPrompt)
  const standing = createScope(root, {})
  const actors = ['main', 'subagent'].map(audience => {
    const agent = { id: `fixed-${audience}`, options: {}, session: { id: audience, header: { origin: audience === 'subagent' ? 'subagent' : 'user', delegationDepth: audience === 'subagent' ? 1 : 0 }, snapshotEvents: () => [] } }
    const scope = createScope(root, {}, { parent: scopeOf(standing.ctx) })
    agent.ctx = scope.ctx
    return { agent, scope }
  })
  standing.ctx.get('systemPrompt').context({ name: 'shared-context', order: 0, text: 'CONTEXT' })
  const { compileRules } = await import('../../engine/rule-spec.mjs')
  const { createPromptConfigs } = await import('../../engine/schema.mjs')
  const { createPreStepSource } = await import('../../engine/pre-step-source.mjs')
  const config = (audience, extra = {}) => ({ id: 'fixed', layer: 'system-section', audience, text: audience.toUpperCase(), mergeMode: 'merged', params: { complete: true, suppressRuntimeContext: true }, ...extra })
  const compile = configs => compileRules(configs.map((item, index) => ({ id: `fixed-${index}`, then: [{ id: 'inject', kind: 'inject-text', config: item }] })))
  let releases = []
  const release = () => { for (const off of releases.splice(0)) off() }
  const mount = configs => {
    release()
    const rules = compile(configs)
    releases = actors.map(({ agent }) => mountRuleSources(agent.ctx, [{ moduleId: 'fixed', rules }], { agent }))
  }
  const assembly = ({ agent }) => root.systemPrompt.assemble({ agent, scope: scopeOf(agent.ctx) })
  const sectionTexts = value => value.sections.map(item => item.text).filter(Boolean)
  t.after(async () => { release(); for (const { scope } of actors) await scope.dispose(); await standing.dispose(); await root.fiber.dispose() })
  const baseline = await Promise.all(actors.map(assembly))
  for (const audience of ['main', 'subagent']) {
    mount([config(audience)])
    for (const [index, actor] of actors.entries()) {
      const result = await assembly(actor)
      if (actor.agent.session.id === audience) {
        assert.deepEqual(sectionTexts(result), [audience.toUpperCase()])
        assert.deepEqual(result.contexts, [])
      } else {
        assert.deepEqual(result.sections, baseline[index].sections, '非目标受众保留完整官方系统段')
        assert.deepEqual(result.contexts, baseline[index].contexts, '非目标受众保留动态上下文')
      }
    }
  }
  mount([config('main', { id: 'main-complete' }), config('subagent', { id: 'child-complete' })])
  assert.deepEqual(sectionTexts(await assembly(actors[0])), ['MAIN'])
  assert.deepEqual(sectionTexts(await assembly(actors[1])), ['SUBAGENT'])
  mount([config('main', { params: { suppressRuntimeContext: true } })])
  assert.ok(sectionTexts(await assembly(actors[0])).includes('MAIN'))
  assert.deepEqual((await assembly(actors[1])).contexts, baseline[1].contexts)
  release()
  for (const [index, actor] of actors.entries()) assert.deepEqual(await assembly(actor), baseline[index], '释放后恢复完整官方装配')
  const independent = createPromptConfigs([config('main')])
  const mixed = createPromptConfigs([{ id: 'sentinel', layer: 'pre-step', text: 'NO LEAK', position: 'after-all' }, config('main')])
  const step = () => root.waterfall(scopeTarget(actors[0].agent, scopeOf(actors[0].agent.ctx)), 'agent/pre-step', { agent: actors[0].agent, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [] }))
  assert.throws(() => mountConfigs(standing.ctx, mixed), /Agent|agent|受众/, '共享作用域缺少明确Agent时不能发布受众限定固定效果')
  assert.throws(() => applyPromptConfigSources([createPreStepSource({ sourceId: 'shared', ctx: standing.ctx, configs: mixed })]), /Agent|agent|受众/)
  assert.deepEqual((await step()).messages, [], '被拒的混合来源没有遗留pre-step注入')
  releases.push(mountConfigs(actors[0].agent.ctx, mixed, { agent: actors[0].agent }))
  assert.deepEqual((await step()).messages.map(item => item.content[0].text), ['NO LEAK'], '同一输入有明确Agent时确实执行')
  release()
  const merged = createPromptConfigs([{ id: 'ordinary', layer: 'system-section', text: 'ORDINARY', mergeMode: 'merged' }, config('main')])
  releases.push(mountConfigs(actors[0].agent.ctx, merged, { agent: actors[0].agent }))
  assert.deepEqual(sectionTexts(await assembly(actors[0])), ['MAIN'], '独立引擎入口可显式提供目标Agent')
  release()
  releases.push(mountConfigs(actors[0].agent.ctx, independent, { agent: actors[0].agent }))
  assert.deepEqual(sectionTexts(await assembly(actors[0])), ['MAIN'], '重挂保持相同独占行为')
  assert.deepEqual((await assembly(actors[1])).sections, baseline[1].sections)
})

test('导入候选与运行配装同源：完整定义经过 rules 切片后保持所有执行维度', async () => {
  const { writeModule } = await import('../../src/host/write-module.ts')
  const id = 'materialized-slices'
  // 定义来源目录（writeModule 的模板解析基准：sourceDir 优先于已安装模块）。
  const sourceDir = join(moduleRoot, '.source-materialized', id)
  mkdirSync(sourceDir, { recursive: true })
  writeFileSync(join(sourceDir, 'module.yml'), `${JSON.stringify({
    id, name: id, modules: ['rule-engine'], rules: LITERAL_SLICES.map(fixtureRule),
  }, null, 2)}\n`, 'utf8')
  // 官方路径：把同一份切片交给 writeModule 物化到 <模块根>/<id>/configs。
  writeModule({
    modulesRoot: moduleRoot,
    moduleId: id,
    targetModuleId: id,
    sourceDir,
    agentsInstructionText: '',
  })
  const prepared = await prepareAssembly(moduleRoot, id, hasEveryService)
  assert.equal(prepared.rules.length, LITERAL_SLICES.length, '规则条数与定义一致')
  for (const [index, expected] of LITERAL_SLICES.entries()) {
    const actual = prepared.rules[index].actions[0].compiledConfig
    // 五个维度逐条对拍：写的层/位置/时机/次数/受众，读回来一项不改。
    assert.equal(actual.id, expected.id)
    assert.equal(actual.strategy, expected.strategy)
    assert.equal(actual.layer, expected.layer)
    assert.equal(actual.position, expected.position)
    assert.equal(actual.dedupe, expected.dedupe)
    assert.equal(typeof prepared.rules[index].when, 'function', '受众和晋升均在规则条件中编译')
  }
})

test('公共人设发布失败恢复整批旧贡献，恢复失败保留原因且不留半挂', async t => {
  writeModuleFixture('assembly-restore', { modules: ['rule-engine'], promptConfigs: [{ id: 'restore', text: 'RESTORE', position: 'after-user' }] })
  writeModuleFixture('assembly-persona', { modules: [] })
  let prefix = 'OLD-PERSONA'
  const h = await liveAssembly(t, () => ['assembly-restore'], { personaModules: () => [{
    moduleId: 'assembly-persona', persona: { main: { prefix }, subagent: { prefix } },
  }] })
  const agents = [await h.makeAgent('batch-first'), await h.makeAgent('batch-second', 1)]
  const section = h.root.systemPrompt.section
  let remaining = 1
  t.mock.method(h.root.systemPrompt, 'section', function (value) {
    if (remaining > 0 && scopeOf(this.ctx) === agents[1]) {
      remaining--
      throw new Error(remaining === 0 ? 'PUBLIC-PERSONA-FAIL' : 'RESTORE-FAIL')
    }
    return section.call(this, value)
  })
  prefix = 'NEW-PERSONA'
  await assert.rejects(h.runtime.refresh(), /PUBLIC-PERSONA-FAIL/)
  for (const agent of agents) {
    const system = await h.root.systemPrompt.assemble({ agent, scope: agent })
    assert.equal(system.sections.find(value => value.name === 'deployment:persona-prefix').text, 'OLD-PERSONA')
    assert.deepEqual(h.runtime.moduleIds(agent.id), ['assembly-restore'])
  }
  assert.equal(h.runtime.publicationFailures().length, 1)
  await h.runtime.refresh()
  assert.deepEqual(h.runtime.publicationFailures(), [])
  prefix = 'ANOTHER-PERSONA'
  remaining = 2
  await assert.rejects(h.runtime.refresh(), error => {
    assert.match(String(error), /PUBLIC-PERSONA-FAIL.*RESTORE-FAIL|RESTORE-FAIL.*PUBLIC-PERSONA-FAIL/s)
    assert.doesNotMatch(String(error), /已保存/)
    return true
  })
  assert.equal(h.runtime.hasMounted(agents[1].id), false)
})

test('启用表增删直接更新真实贡献，空启用表零贡献', async t => {
  for (const [id, text] of [['enabled-a', 'A'], ['enabled-b', 'B'], ['enabled-c', 'C']]) {
    writeModuleFixture(id, { modules: ['rule-engine'], promptConfigs: [{ id, text, position: 'after-user' }] })
  }
  let enabled = ['enabled-a', 'enabled-b']
  const h = await liveAssembly(t, () => enabled)
  const agent = await h.makeAgent('session-enabled')
  const texts = async () => (await h.inject(agent)).messages.flatMap(message => message.content.map(block => block.text))
  assert.deepEqual(await texts(), ['USER', 'A', 'B'])
  enabled = ['enabled-a', 'enabled-b', 'enabled-c']
  await h.runtime.refresh()
  assert.deepEqual(await texts(), ['USER', 'A', 'B', 'C'])
  enabled = []
  await h.runtime.refresh()
  assert.deepEqual(await texts(), ['USER'])
  assert.deepEqual(h.warnings, [])
})

test('配装记录报告本 Agent 的提示词层：顺序即启用表，装配前与释放后为空', async t => {
  for (const id of ['layer-a', 'layer-b']) writeModuleFixture(id, { modules: ['rule-engine'], promptConfigs: [{ id, text: id, position: 'after-user' }] })
  const h = await liveAssembly(t, () => ['layer-a', 'layer-b'])
  assert.deepEqual(h.runtime.moduleIds('session-layers'), [])
  assert.deepEqual(h.runtime.moduleIds('session-unknown'), [])
  const agent = await h.makeAgent('session-layers')
  assert.deepEqual(h.runtime.moduleIds(agent.id), ['layer-a', 'layer-b'])
  await h.root.serial(scopeTarget(agent, agent), 'agent/disposed', { agent })
  await h.runtime.settled()
  assert.deepEqual(h.runtime.moduleIds(agent.id), [])
})
test('诊断账本随装配释放回空，不返回陈旧快照', async (t) => {
  const h = await liveAssembly(t, () => [])
  await h.runtime.settled()
  await h.runtime.dispose()
  assert.deepEqual(h.runtime.ruleDiagnostics(), { records: [], dropped: 0 })
})
function writeRawRuleModule(id, rules) {
  const dir = join(moduleRoot, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'module.yml'), JSON.stringify({ id, name: id, modules: [], rules }, null, 2), 'utf8')
  return dir
}

const appendRule = {
  id: 'append-rule',
  then: [{ id: 'append', kind: 'assembly', target: { sections: { append: [{ name: 'deployment:persona-prefix', text: 'APPENDED' }] } } }],
}
const completeRule = (audience) => ({
  id: 'complete-rule',
  then: [{
    id: 'complete',
    kind: 'inject-text',
    config: {
      id: 'complete-text', layer: 'system-section', strategy: 'static', text: 'COMPLETE',
      params: { complete: true }, ...(audience === undefined ? {} : { audience }),
    },
  }],
})

test('sections.append：无 complete 时追加到既有段，输入不被就地修改', async (t) => {
  writeRawRuleModule('append-live', [appendRule])
  const h = await liveAssembly(t, () => ['append-live'])
  const agent = await h.makeAgent('append-live-agent')
  let read
  await agent.ctx.plugin({
    inject: ['systemPrompt'],
    apply(ctx) {
      ctx.systemPrompt.section({ name: 'deployment:persona-prefix', order: 0, text: 'BASE' })
      read = () => ctx.systemPrompt.assemble({ agent, scope: agent })
    },
  })
  const output = await read()
  const section = output.sections.find(item => item.name === 'deployment:persona-prefix')
  assert.equal(section.text, 'BASE\nAPPENDED')
})

test('sections.append 与同受众 complete 互斥，主/子受众分别判断', async (t) => {
  writeRawRuleModule('append-live-main', [appendRule])
  writeRawRuleModule('complete-main', [completeRule('main')])
  const h = await liveAssembly(t, () => ['append-live-main', 'complete-main'])
  const main = await h.makeAgent('append-complete-main')
  assert.equal(h.runtime.hasMounted(main.id), false)
  assert.ok(h.warnings.some(message => message.includes('sections.append') && message.includes('complete')))

  writeRawRuleModule('append-live-sub', [appendRule])
  writeRawRuleModule('complete-sub', [completeRule('subagent')])
  const split = await liveAssembly(t, () => ['append-live-sub', 'complete-sub'])
  const mainAgent = await split.makeAgent('append-sub-complete-main')
  assert.equal(split.runtime.hasMounted(mainAgent.id), true, '子代理 complete 不影响主会话 append')
  const child = await split.makeAgent('append-sub-complete-child', 1)
  assert.equal(split.runtime.hasMounted(child.id), false, '子代理同受众 append + complete 被拒')
  assert.ok(split.warnings.some(message => message.includes('sections.append') && message.includes('complete')))

  writeRawRuleModule('append-main-only', [{ ...appendRule, if: { scope: { audience: 'main' } } }])
  writeRawRuleModule('complete-sub-only', [completeRule('subagent')])
  const split2 = await liveAssembly(t, () => ['append-main-only', 'complete-sub-only'])
  const mainOnly = await split2.makeAgent('append-main-only-main')
  const childOnly = await split2.makeAgent('append-main-only-child', 1)
  assert.equal(split2.runtime.hasMounted(mainOnly.id), true, '主受众 append 不受子 complete 影响')
  assert.equal(split2.runtime.hasMounted(childOnly.id), true, 'append 规则限定 main 时，子受众只装 complete')
})

test('sections.append 的受众按动作级条件判定，else 分支按 not(if)', async (t) => {
  const appendAction = {
    id: 'append-action-rule',
    then: [{
      if: { scope: { audience: 'main' } },
      then: [{ id: 'append', kind: 'assembly', target: { sections: { append: [{ name: 'deployment:persona-prefix', text: 'APPENDED' }] } } }],
    }],
  }
  writeRawRuleModule('append-action-main', [appendAction])
  writeRawRuleModule('complete-action-sub', [completeRule('subagent')])
  const split = await liveAssembly(t, () => ['append-action-main', 'complete-action-sub'])
  const main = await split.makeAgent('append-action-main-agent')
  assert.equal(split.runtime.hasMounted(main.id), true, '动作级 main append 不影响主会话装配')
  const child = await split.makeAgent('append-action-main-child', 1)
  assert.equal(split.runtime.hasMounted(child.id), true, '动作级 main append 不与子代理 complete 冲突')

  writeRawRuleModule('append-action-main-conflict', [appendAction])
  writeRawRuleModule('complete-action-main', [completeRule('main')])
  const same = await liveAssembly(t, () => ['append-action-main-conflict', 'complete-action-main'])
  const sameMain = await same.makeAgent('append-action-main-conflict-agent')
  assert.equal(same.runtime.hasMounted(sameMain.id), false, '动作级 main append 与 main complete 同受众被拒')
  assert.ok(same.warnings.some(message => message.includes('sections.append') && message.includes('complete')))

  const elseAppend = {
    id: 'append-else-rule',
    if: { scope: { audience: 'subagent' } },
    then: [{ id: 'noop', kind: 'tool-gate', decision: 'allow' }],
    else: [{ id: 'append', kind: 'assembly', target: { sections: { append: [{ name: 'deployment:persona-prefix', text: 'APPENDED' }] } } }],
  }
  writeRawRuleModule('append-else-main', [elseAppend])
  writeRawRuleModule('complete-else-main', [completeRule('main')])
  const conflict = await liveAssembly(t, () => ['append-else-main', 'complete-else-main'])
  const mainAgent = await conflict.makeAgent('append-else-main-agent')
  assert.equal(conflict.runtime.hasMounted(mainAgent.id), false, 'else 分支的 append 按 not(if) 判 main，与 main complete 同受众被拒')
  assert.ok(conflict.warnings.some(message => message.includes('sections.append') && message.includes('complete')))
  const childAgent = await conflict.makeAgent('append-else-main-child', 1)
  assert.equal(conflict.runtime.hasMounted(childAgent.id), true, '两个声明都不作用于子代理时照常装配')
})

test('组合行 disabled 受控求值，并从运行集合剔除', async () => {
  assert.equal(rowDisabled(true), true)
  assert.equal(rowDisabled(false), false)
  assert.equal(rowDisabled(undefined), false)
  assert.equal(rowDisabled(`process.platform === 'win32'`), process.platform === 'win32')
  assert.equal(rowDisabled(`process.platform !== 'win32'`), process.platform !== 'win32')
  assert.throws(() => rowDisabled('process.env.X'), /disabled 表达式不受支持/)
  writeModuleFixture('official-disabled', { modules: ['tool-bash-disabled'] })
  const facts = readModuleFacts(join(moduleRoot, 'official-disabled'))
  assert.deepEqual(facts.disabledRows, ['tool-bash-disabled'])
  assert.equal(facts.effectiveModules.includes('tool-bash-disabled'), false, 'disabled 行不进入运行集合')
  const prepared = await prepareAssembly(moduleRoot, 'official-disabled', hasEveryService)
  assert.equal(prepared.modules.some(module => module.id === 'tool-bash-disabled'), false)
  assert.ok(prepared.skippedOfficialRows.includes('tool-bash-disabled'), '禁用的官方行也要有诊断')
})

test('customTools 未声明 tool-config-engine 时按事实自动装配', async () => {
  const id = 'implied-tools'
  const dir = join(moduleRoot, id)
  mkdirSync(dir, { recursive: true })
  const tool = {
    id: 'echo', name: 'echo', description: 'echo',
    output: { schema: { type: 'object', additionalProperties: false } },
    execute: { kind: 'shell', command: 'echo' },
  }
  writeFileSync(join(dir, 'module.yml'), JSON.stringify({ id, name: id, modules: [], customTools: [tool], rules: [] }), 'utf8')
  const facts = readModuleFacts(dir)
  assert.ok(facts.effectiveModules.includes('tool-config-engine'), 'customTools 隐含 tool-config-engine')
  const prepared = await prepareAssembly(moduleRoot, id, hasEveryService)
  assert.deepEqual(prepared.modules.map(module => module.id), ['tool-config-engine'])
  assert.equal(prepared.modules[0].config.tools.length, 1)
})

test('官方 recipe 行只声明时给出诊断，不静默假装已挂载', async t => {
  writeModuleFixture('official-row', { modules: ['filesystem-editor'] })
  const h = await liveAssembly(t, () => ['official-row'])
  await h.makeAgent('official-row-agent')
  assert.ok(h.warnings.some(message => message.includes('filesystem-editor')), '声明官方行必须可见')
})

// 回归：协调器的单个 prepend 监听器必须在最外层。官方 dsh-tool-skill 是更内层的监听器，
// `await next()` 之后才 append 技能目录；协调器若在内层，过滤时目录还没出现，随后外层再 append → 删不掉。
// 回归：filter 必须先于规则批——规则批的初始帧只应看到过滤后的 messages。
test('协调器管线：规则批收到过滤后的官方指令', async (t) => {
  const h = await liveAssembly(t, () => [], {
    beforeCoordinator: (root) => {
      root.on('agent/pre-step', async (_payload, next) => {
        const decision = await next()
        return { ...decision, messages: [...decision.messages, {
          id: 'official', role: 'user',
          source: { kind: 'agent-instructions', changes: [{ path: '~/.dsh/AGENTS.md', action: 'set' }] },
          content: [{ type: 'text', text: '<system-reminder>\nInstructions from: ~/.dsh/AGENTS.md\nOFFICIAL\n</system-reminder>' }],
        }] }
      })
    },
  })
  const identity = instructionFileIdentityOf('~/.dsh/AGENTS.md')
  assert.ok(identity.fileId)
  const current = readInstructionPolicy()
  assert.equal(writeInstructionPolicy({ expectedRevision: current.revision, patch: { files: { [identity.fileId]: { enabled: false } } } }).ok, true)
  const coordinator = h.root.get(PRE_STEP_COORDINATOR_SERVICE)
  const agent = await h.makeAgent('sees-filtered-main')
  const seen = []
  coordinator.registerPreset('probe', {
    sourceId: 'probe',
    ctx: agent.ctx,
    configs: [],
    ruleActions: [{
      id: 'probe',
      handler: async (_payload, next) => {
        const current = await next()
        seen.push((current.messages ?? []).map(message => message.source?.kind))
        return current
      },
    }],
  })
  await h.inject(agent)
  assert.ok(seen.length > 0, '规则批至少执行一次')
  assert.ok(seen.every(kinds => !kinds.includes('agent-instructions')), '规则批不得看到已过滤的官方指令')
})

test('协调器管线：规则批抛错仍返回已过滤的 decision', async (t) => {
  const h = await liveAssembly(t, () => [], {
    beforeCoordinator: (root) => {
      root.on('agent/pre-step', async (_payload, next) => {
        const decision = await next()
        return { ...decision, messages: [...decision.messages, {
          id: 'official', role: 'user',
          source: { kind: 'agent-instructions', changes: [{ path: '~/.dsh/AGENTS.md', action: 'set' }] },
          content: [{ type: 'text', text: '<system-reminder>\nInstructions from: ~/.dsh/AGENTS.md\nOFFICIAL\n</system-reminder>' }],
        }] }
      })
    },
  })
  const identity = instructionFileIdentityOf('~/.dsh/AGENTS.md')
  assert.ok(identity.fileId)
  const current = readInstructionPolicy()
  assert.equal(writeInstructionPolicy({ expectedRevision: current.revision, patch: { files: { [identity.fileId]: { enabled: false } } } }).ok, true)
  const coordinator = h.root.get(PRE_STEP_COORDINATOR_SERVICE)
  const agent = await h.makeAgent('boom-main')
  let boomCount = 0
  coordinator.registerPreset('boom', {
    sourceId: 'boom',
    ctx: agent.ctx,
    configs: [],
    ruleActions: [{ id: 'boom', handler: async () => { boomCount += 1; throw new Error('BATCH_BOOM') } }],
  })
  const decision = await h.inject(agent)
  assert.ok(boomCount > 0, '规则批至少执行一次')
  assert.ok(!decision.messages.some(message => message.source?.kind === 'agent-instructions'), 'batch 抛错后仍返回已过滤 decision')
})

test('协调器批执行在最外层：先注册的监听器在 next() 之后追加的消息仍会被过滤', async (t) => {
  writeModuleFixture('drop-catalog', {
    modules: ['rule-engine'],
    rules: [{ id: 'narrow', then: [{ id: 'drop', kind: 'pre-step-filter', sources: ['user'] }] }],
  })
  const h = await liveAssembly(t, () => ['drop-catalog'], {
    beforeCoordinator: (root) => {
      // 模拟官方 dsh-tool-skill：先注册（更内层），next() 之后才追加目录。
      root.on('agent/pre-step', async (_payload, next) => {
        const decision = await next()
        return { ...decision, messages: [...decision.messages, { role: 'user', source: { kind: 'skill-catalog' }, content: [{ type: 'text', text: 'CATALOG' }] }] }
      })
    },
  })
  const agent = await h.makeAgent('drop-catalog-main')
  const decision = await h.inject(agent)
  assert.ok(!decision.messages.some(message => message.source?.kind === 'skill-catalog'), '外层追加的 skill-catalog 被过滤')
  assert.ok(decision.messages.some(message => message.source?.kind === 'user'), '白名单内的 user 消息保留')
})
