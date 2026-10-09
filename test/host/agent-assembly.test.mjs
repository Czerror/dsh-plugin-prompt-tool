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
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { createScope, scopeTarget } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { isolatedHome } from '../fixtures/host-harness.mjs'

const { moduleRoot } = isolatedHome('pt-assembly-')
const { prepareAssembly, createAgentAssembly } = await import('../../src/runtime/agent-assembly.ts')
const { installPreStepCoordinator, PRE_STEP_COORDINATOR_SERVICE } = await import('../../src/runtime/pre-step-coordinator.ts')
const { ruleDiagnosticsSnapshot, resetRuleDiagnostics } = await import('../../src/runtime/rule-diagnostics.ts')
const { promptConfigToRule } = await import('../../src/host/rule-builder.ts')
const { convertLegacyModuleRules } = await import('../../src/host/rules-migration.ts')
const { mountRuleSources } = await import('../../engine/rule-runtime.mjs')

/** 装配能力探针：装配只问「宿主是否提供该服务」，这里全部视为提供。 */
const hasEveryService = () => true

/** 只替代 Agent/模型驱动；注册、scope 路由与注入执行器使用真实实现。 */
async function liveAssembly(t, enabledModules) {
  const root = new Context()
  await root.plugin(SystemPrompt)
  await root.plugin(ToolRuntime)
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
  const inject = (agent) => root.waterfall(scopeTarget(agent, agent), 'agent/pre-step', { agent }, async () => ({
    kind: 'continue', messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'USER' }] }],
  }))
  return { root, runtime, makeAgent, inject, warnings }
}

test('真实注入：启用配置进入主/子会话正确位置，关闭项不注入，释放后不再贡献', async (t) => {
  writePreset('live-injection', {
    modules: ['prompt-config-engine'],
    persona: { prefix: 'PERSONA', suffix: 'SUFFIX', includeRuntimeContext: false },
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
  for (const text of ['SYSTEM', 'PERSONA', 'SUFFIX']) assert.ok(system.sections.some((section) => section.text === text))
  assert.deepEqual(system.contexts, [])
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
    const evaluate = prepared.rules[0].when
    prepared.rules[0].when = Object.assign(subject => { checks[key]++; return evaluate(subject) }, evaluate)
    releases.push(mountRuleSources(agent.ctx, [{ moduleId: 'managed-chain', rules: prepared.rules }]))
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
  assert.equal(after.sections.some((section) => ['SYSTEM', 'PERSONA', 'SUFFIX'].includes(section.text)), false)
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
  resetRuleDiagnostics()
  t.after(() => resetRuleDiagnostics())
  const h = await liveAssembly(t, () => ['diag-rules'])
  const main = await h.makeAgent('diag-main')
  await h.runtime.settled()
  const injected = (await h.inject(main)).messages.flatMap(message => message.content.map(block => block.text))
  assert.deepEqual(injected, ['USER', 'HIT'], '命中规则注入正文，其余两支不注入')
  const byRule = new Map(ruleDiagnosticsSnapshot().map(record => [record.ruleId, record]))
  assert.deepEqual([...byRule.keys()].sort(), ['hit', 'miss', 'unavailable'], JSON.stringify(ruleDiagnosticsSnapshot()))
  const record = (ruleId, counts) => ({ moduleId: 'diag-rules', ruleId, channel: 'agent/pre-step', hit: 0, miss: 0, unavailable: 0, error: 0, ...counts })
  assert.deepEqual(byRule.get('hit'), record('hit', { hit: 1 }))
  assert.deepEqual(byRule.get('miss'), record('miss', { miss: 1 }))
  assert.deepEqual(byRule.get('unavailable'), record('unavailable', { unavailable: 1 }))
})

test('官方负责人事实：规则来源不再报 false，未观察到即 undefined', async (t) => {
  writePreset('owner-none', { modules: ['prompt-config-engine'], promptConfigs: [{ id: 'owner-x', text: 'X', position: 'after-user' }] })
  const h = await liveAssembly(t, () => ['owner-none'])
  const agent = await h.makeAgent('owner-session')
  await h.runtime.settled()
  await h.inject(agent)
  const coordinator = h.root.get(PRE_STEP_COORDINATOR_SERVICE)
  assert.equal(coordinator.officialOwnerOf('owner-session'), undefined, '没有官方装配事实时不猜')
  // bridge 载荷 = `observed ?? null`（settings-bridge 的 instructionOwner）。
  assert.equal(coordinator.officialOwnerOf('owner-session') ?? null, null)
})

test('创建边界：agent/created 返回时首条请求已经能注入，无需额外等待队列', async (t) => {
  writePreset('first-request', {
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
    const dir = writePreset(moduleId, { modules: ['prompt-config-engine'], promptConfigs: entries.map(([, config]) => config), configOrder: Object.fromEntries(entries.map(([sequence, config]) => [config.id, sequence])) })
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
    assert.deepEqual(system.sections.filter(section => section.text.startsWith('SYS-')).map(section => section.text), ['SYS-B', 'SYS-A'],
      '官方 system-section 定位仍由 order 决定')
    assert.deepEqual(h.runtime.moduleIds(agent.id), enabled, '工具写入目标的启用表顺序不随配置执行序改写')
  }
  assert.deepEqual(h.warnings, [])
})

test('持久序号覆盖文件旧前缀，ST 宏按全局调度求值并保留模块自己的变量帧', async (t) => {
  for (const [id, promptConfigs, configOrder] of [
    ['sequence-macro-a', [
      { id: 'a10', text: 'A10 {{setvar::scope::A}}{{roll::100}}', params: { stMacros: true } },
      { id: 'a30', text: 'A30 {{getvar::scope}} {{roll::100}}', params: { stMacros: true } },
    ], { a10: 10, a30: 30 }],
    ['sequence-macro-b', [
      { id: 'b20', text: 'B20 {{setvar::scope::B}}{{roll::100}}', params: { stMacros: true } },
    ], { b20: 20 }],
  ]) {
    const dir = writePreset(id, { modules: ['prompt-config-engine'], promptConfigs })
    updateConfigOrder(dir, configOrder)
  }
  const h = await liveAssembly(t, () => ['sequence-macro-b', 'sequence-macro-a'])
  const agent = await h.makeAgent('sequence-macro-agent')
  const draws = [0.1, 0.2, 0.3]
  const random = t.mock.method(Math, 'random', () => draws.shift())
  const texts = async () => (await h.inject(agent)).messages.flatMap(message => message.content.map(block => block.text))
  assert.deepEqual(await texts(), ['USER', 'A10 11', 'B20 21', 'A30 A 31'])
  assert.deepEqual(await texts(), ['USER', 'A10 11', 'B20 21', 'A30 A 31'], '同帧不重放随机宏')
  assert.equal(random.mock.callCount(), 3)
})

test('交错来源只合并连续段，保留 merged 身份与独立续跑预算', async (t) => {
  for (const [id, first, second] of [['source-a', 10, 30], ['source-b', 20, 21]]) {
    const dir = writePreset(id, {
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

test('官方文本层同 order 的默认段按 sequence 排列，显式注册名保留官方语义', async (t) => {
  for (const [id, sequence, explicitName] of [['text-order-a', 10000, 'explicit-a'], ['text-order-z', 9990, 'explicit-z']]) {
    const dir = writePreset(id, {
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
      kind === 'sections' ? ['explicit-a', 'explicit-z'] : ['explicit-z', 'explicit-a'],
      '显式名字不被改写：sections 同 order 按名字，contexts 同 order 保留注册次序')
  }
  assert.deepEqual(h.warnings, [])
})

test('重复模块身份：跨模块同 rule id 且 dedupe=session 只告警一次，装配照常成功', async (t) => {
  // 复制模块保留 rule id，默认身份（rule:ruleId:actionId）因此跨模块重复。这是合法操作，
  // 只可见化（warnOnce + 诊断），绝不整体拒绝——整体拒绝会让该 Agent 的全部装配失败，
  // 违背「失败不伤会话」。
  for (const id of ['dup-source-a', 'dup-source-b']) {
    writePreset(id, {
      modules: ['prompt-config-engine'],
      promptConfigs: [{ id: 'shared-hint', text: `${id}-HINT`, dedupe: 'session', position: 'after-user' }],
    })
  }
  // 另一对：id 不同（plugin 身份不撞）但显式声明同一个 sourceKind，经 kind 通道互相压制。
  for (const id of ['dup-kind-a', 'dup-kind-b']) {
    writePreset(id, {
      modules: ['prompt-config-engine'],
      promptConfigs: [{ id: `${id}-hint`, text: `${id}-KIND`, dedupe: 'session', sourceKind: 'shared-kind-channel', position: 'after-user' }],
    })
  }
  const h = await liveAssembly(t, () => ['dup-source-a', 'dup-source-b', 'dup-kind-a', 'dup-kind-b'])
  const agent = await h.makeAgent('duplicate-identity-agent')
  assert.deepEqual(h.runtime.moduleIds(agent.id), ['dup-source-a', 'dup-source-b', 'dup-kind-a', 'dup-kind-b'],
    '重复身份不影响装配成功')
  // 同一批内的候选不算「已投递」：四张卡各自注入一次，重复体现在**后续步**不再补发。
  // 同 `sequence` 时按 moduleId 字典序，故只断言集合与去重后步数，不锁跨模块顺序。
  const first = (await h.inject(agent)).messages.flatMap(message => message.content.map(block => block.text))
  assert.deepEqual([...first].sort(), ['USER', 'dup-kind-a-KIND', 'dup-kind-b-KIND', 'dup-source-a-HINT', 'dup-source-b-HINT'].sort())
  assert.deepEqual(h.warnings.length, 2, `两条通道各一条告警：${JSON.stringify(h.warnings)}`)
  const [identityWarning, kindWarning] = h.warnings
  assert.match(identityWarning, /疑似由复制产生同一个去重身份/)
  assert.match(identityWarning, /dup-source-a、dup-source-b/)
  assert.match(kindWarning, /显式 sourceKind "plugin:shared-kind-channel"/)
  assert.match(kindWarning, /有意共享/)
  assert.match(kindWarning, /dup-kind-a、dup-kind-b/)
})

test('热更新：空启用表到多模块、配置启停与拒绝后重试都更新同一个 Agent，重复刷新不重复注入', async (t) => {
  const { setModuleEnabled, enabledModuleIds } = await import('../../src/host/config-store.ts')
  for (const id of ['hot-a', 'hot-b']) writePreset(id, {
    modules: ['prompt-config-engine'],
    promptConfigs: [{ id, text: id, position: 'after-user' }],
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
  writePreset('hot-a', {
    modules: ['prompt-config-engine'],
    promptConfigs: [{ id: 'hot-a', text: 'CHANGED', enabled: false, position: 'after-user' }],
  })
  await h.runtime.refresh('hot-a')
  assert.deepEqual(await injected(), ['USER', 'hot-b'])
  writePreset('hot-a', {
    modules: ['prompt-config-engine'],
    promptConfigs: [{ id: 'hot-a', text: 'CHANGED', position: 'after-user' }],
  })
  await h.runtime.refresh('hot-a')
  assert.deepEqual(await injected(), ['USER', 'CHANGED', 'hot-b'])
  writePreset('hot-b', {
    modules: ['prompt-config-engine'],
    promptConfigs: [{ id: 'hot-b', strategy: 'invalid', text: 'BROKEN' }],
  })
  await assert.rejects(h.runtime.refresh('hot-b'), /运行时配装更新失败/)
  assert.deepEqual(await injected(), ['USER', 'CHANGED', 'hot-b'], '准备失败保留旧贡献')
  setModuleEnabled(moduleRoot, 'hot-b', false)
  await h.runtime.refresh()
  assert.deepEqual(await injected(), ['USER', 'CHANGED'])
  setModuleEnabled(moduleRoot, 'hot-a', false)
  await h.runtime.refresh()
  assert.deepEqual(await injected(), ['USER'])
  assert.deepEqual(h.runtime.moduleIds(agent.id), [])
})

test('能力注册：私有工具服务与内联工具接入官方注册表，禁用后释放', async (t) => {
  const dir = writePreset('live-tools', { modules: ['character-tools', 'tool-config-engine'] })
  const { writePreset: materialize } = await import('../../src/host/write-preset.ts')
  writeFileSync(join(dir, 'module.yml'), JSON.stringify({
    id: 'live-tools', name: 'live-tools', modules: ['character-tools', 'tool-config-engine'],
    layerSettings: { 'agent-request': { modelTemperature: '0.25' } },
    customTools: [{ id: 'delegated_tool', description: 'delegate', output: { schema: { type: 'json' } }, execute: { kind: 'delegate', tool: 'assembly_tool' } }],
    triggers: [{ id: 'runtime-trigger', channel: 'agent/pre-step', do: { kind: 'inject-text', config: {
      id: 'trigger-text', layer: 'pre-step', text: 'TRIGGER', position: 'after-user',
    } } }],
  }), 'utf8')
  const oldSource = JSON.parse(readFileSync(join(dir, 'module.yml'), 'utf8'))
  const migrated = convertLegacyModuleRules(oldSource, { directory: dir })
  delete oldSource.triggers
  delete oldSource.layerSettings
  writeFileSync(join(dir, 'module.yml'), JSON.stringify({ ...oldSource, rules: migrated.rules, configOrder: migrated.configOrder }))
  materialize('', { moduleDir: moduleRoot, presetTemplate: 'live-tools', presetOrder: 0, agentsInstructionText: '' })
  const h = await liveAssembly(t, () => ['live-tools'])
  const tool = {
    name: 'assembly_tool', description: 'assembly tool',
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'object' }, render: () => [] },
    execute: async () => ({}),
  }
  h.root.provide('pt-character-tools', { mount: (ctx) => ctx.tools.register(tool) })
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
    strategy: 'first-turn-anchor',
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
    strategy: 'guide-auto',
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

function writePreset(id, { modules, promptConfigs = [], moduleConfigs, persona, configOrder }) {
  const dir = join(moduleRoot, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'module.yml'), `${JSON.stringify({
    id, name: id, modules: [...new Set(modules.map(name => ['prompt-config-engine', 'declared-triggers'].includes(name) ? 'rule-engine' : name))],
    rules: promptConfigs.map(promptConfigToRule), ...(configOrder === undefined ? {} : { configOrder }),
    ...(moduleConfigs === undefined ? {} : { moduleConfigs }), ...(persona === undefined ? {} : { persona }),
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
  writePreset(id, {
    modules: ['prompt-config-engine', 'tool-config-engine', 'declared-triggers', 'subagent-tool-policy'],
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
  writePreset('module-roster', {
    modules: ['character-tools', 'tool-config-engine'],
  })
  const prepared = await prepareAssembly(moduleRoot, 'module-roster', hasEveryService)

  // 私有能力复用现有适配器挂载服务，而不是只登记依赖。
  assert.equal(prepared.services.has('pt-character-tools'), true)
})

test('拒绝路径：非法 id、无效模块声明、缺失宿主能力都在装配前 fail loud', async () => {
  await assert.rejects(
    prepareAssembly(moduleRoot, 'Not_An_Id', hasEveryService),
    /非法模块 id/,
  )
  writePreset('unknown-capability', { modules: ['no-such-capability-anywhere'] })
  await assert.rejects(
    prepareAssembly(moduleRoot, 'unknown-capability', hasEveryService),
    /模块声明无效/,
  )
  writePreset('requires-missing-service', { modules: ['prompt-config-engine'], promptConfigs: LITERAL_SLICES })
  await assert.rejects(
    prepareAssembly(moduleRoot, 'requires-missing-service', () => false),
    /配装所需宿主能力不可用/,
  )
})

test('「独占」段唯一性：装配前拒绝两个生效 complete（含人设×配置），禁用不算冲突', async () => {
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
  writePreset('double-complete', {
    modules: ['prompt-config-engine'],
    promptConfigs: [exclusive('excl-a'), exclusive('excl-b')],
  })
  await assert.rejects(
    prepareAssembly(moduleRoot, 'double-complete', hasEveryService),
    /多个生效的「独占」段|multiple complete system sections/,
    '两个启用 complete 必须被拒',
  )

  // ② 顶层人设独占 × 配置独占 → 同样被拒。
  writePreset('persona-complete', {
    modules: ['prompt-config-engine'],
    promptConfigs: [exclusive('excl-a')],
    persona: { prefix: 'PREFIX', complete: true },
  })
  await assert.rejects(
    prepareAssembly(moduleRoot, 'persona-complete', hasEveryService),
    /人设已开启|multiple complete system sections/,
    '人设与配置同时独占必须被拒',
  )

  // ③ 边界一：第二个独占被 `enabled: false` 关掉 → 不算冲突。
  writePreset('one-complete-disabled', {
    modules: ['prompt-config-engine'],
    promptConfigs: [exclusive('excl-a'), exclusive('excl-b', false)],
  })
  const allowed = await prepareAssembly(moduleRoot, 'one-complete-disabled', hasEveryService)
  assert.equal(allowed.rules.length, 2, '禁用的规则仍进装配输入（由引擎过滤 enabled）')

  // ④ 边界二：单独一个独占（无人设）→ 放行，且人设存在但未开独占也放行。
  writePreset('single-complete', {
    modules: ['prompt-config-engine'],
    promptConfigs: [exclusive('excl-a')],
    persona: { prefix: 'PREFIX' },
  })
  const single = await prepareAssembly(moduleRoot, 'single-complete', hasEveryService)
  assert.equal(single.rules.length, 1, '单个独占段正常装配')
})

test('导入候选与运行配装同源：完整定义经过 rules 切片后保持所有执行维度', async () => {
  const { writePreset } = await import('../../src/host/write-preset.ts')
  const id = 'materialized-slices'
  // 定义来源目录（writePreset 的模板解析基准：sourceDir 优先于同名已安装预设）。
  const sourceDir = join(moduleRoot, '.source-materialized', id)
  mkdirSync(sourceDir, { recursive: true })
  writeFileSync(join(sourceDir, 'module.yml'), `${JSON.stringify({
    id, name: id, modules: ['rule-engine'], rules: LITERAL_SLICES.map(promptConfigToRule),
  }, null, 2)}\n`, 'utf8')
  // 官方路径：把同一份切片交给 writePreset 物化到 <预设根>/<id>/configs。
  writePreset('materialized prompt', {
    moduleDir: moduleRoot,
    presetOrder: 5,
    presetTemplate: id,
    outputId: id,
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

/**
 * 装配失败**不得冒泡**：`agent/created` 的监听器被 await，抛错会让会话创建整个失败。
 * 这里用最小桩上下文走完挂载路径，断言「只告警、不抛、不留半挂状态」。
 */
function stubHostContext(options = {}) {
  const listeners = new Map()
  const counts = new Map()
  const mounts = []
  const warnings = []
  const disposers = []
  const agents = []
  // 宿主能力探针：默认全不可用（与「装配失败与恢复」那条用例的前提一致）；
  // 传 `services` 时才视为可用——带切片的模块要求 systemPrompt/tools/llm。
  const services = new Set(options.services ?? [])
  return {
    warnings,
    counts,
    mounts,
    agents,
    /**
     * 假 Agent：真实 Agent 的 ctx 是可安装插件的 scope 上下文；这里只记下安装请求。
     * `options.fault(第几次挂载)` 注入故障：`mount` 让这次挂载失败，`dispose` 让这次撤销失败。
     */
    makeAgent: (id) => {
      const agent = {
        id,
        ctx: {
          get: (name) => services.has(name) ? {} : undefined,
          plugin: (definition) => {
            mounts.push({ id, definition })
            const fault = options.fault?.(mounts.length) ?? {}
            // 真实 ctx.plugin 的返回值既能 await 也能 dispose（挂载失败时要撤），桩必须同形。
            const fiber = fault.mount === undefined ? Promise.resolve() : Promise.reject(fault.mount)
            return Object.assign(fiber, { dispose: async () => { await fault.dispose?.() } })
          },
        },
      }
      agents.push(agent)
      return agent
    },
    fire: async (name, payload) => {
      const handler = listeners.get(name)
      if (handler === undefined) throw new Error(`no listener for ${name}`)
      return handler(payload)
    },
    ctx: {
      // 同名监听按事件语义可以注册多份（每个模块各一份贡献），所以除最新处理器外还记次数。
      on: (name, handler) => {
        listeners.set(name, handler)
        counts.set(name, (counts.get(name) ?? 0) + 1)
        return () => { listeners.delete(name); counts.set(name, (counts.get(name) ?? 1) - 1) }
      },
      // 真实 effect 返回它的 disposer：装配失败时要靠它撤掉半挂的 fiber。
      effect: (register) => { const remove = register(); disposers.push(remove); return async () => { await remove?.() } },
      get: (name) => services.has(name) ? {} : undefined,
      // 构造期会枚举存量 Agent；由 index.ts 的 ctx.inject(['agents']) 保证真实可用。
      agents: { list: () => agents },
      logger: { warn: (message) => { warnings.push(message) } },
    },
  }
}

test('装配失败与恢复：准备期失败只告警，撤旧失败仍尝试恢复，恢复也失败保留两层原因', async () => {
  // ① 准备期失败：启用表里有一项非法 id ⇒ prepareAssembly 在准备期就抛（与真实坏定义同一条路径）。
  writePreset('assembly-target', { modules: ['tool-config-engine'] })
  const host = stubHostContext()
  const runtime = createAgentAssembly(host.ctx, {
    moduleRoot,
    enabledModules: () => ['Not_An_Id'],
    warn: (message) => { host.warnings.push(message) },
  })
  const agent = { id: 'session-broken', ctx: { get: () => undefined } }

  // 监听器返回 undefined（不是 Promise），事件派发不会因它失败。
  await host.fire('agent/created', { agent, source: 'startup' })
  await runtime.settled()

  assert.equal(runtime.hasMounted(agent.id), false, '失败的装配不留下已挂载状态')
  assert.equal(host.warnings.some((line) => line.includes('运行时配装失败')), true, '失败被降级为告警')
  assert.equal(host.mounts.length, 0, '准备期失败连挂载都不尝试')
  await runtime.dispose()

  // ② 撤旧失败：它和挂新在同一个 try 里，所以旧装配照样被装回去。
  const disposeFail = new Error('DISPOSE-FAIL')
  const host2 = stubHostContext({ fault: (attempt) => attempt === 1 ? { dispose: async () => { throw disposeFail } } : {} })
  const runtime2 = createAgentAssembly(host2.ctx, {
    moduleRoot, enabledModules: () => [], warn: (message) => { host2.warnings.push(message) },
  })
  const agent2 = host2.makeAgent('session-release-failure')
  await host2.fire('agent/created', { agent: agent2, source: 'startup' })
  await runtime2.settled()
  assert.equal(runtime2.hasMounted(agent2.id), true, '首次装配成功')
  await assert.rejects(runtime2.refresh(), (error) => {
    assert.equal(error.errors[0], disposeFail, '撤旧失败的原因原样上报')
    return true
  })
  assert.equal(host2.mounts.length, 2, '撤旧失败后仍重新挂载旧装配')
  assert.equal(runtime2.hasMounted(agent2.id), true, '恢复成功：旧贡献还在')
  await runtime2.dispose()

  // ③ 恢复也失败：两个原因都要留下，且 message 自带两段——上报点只读 message。
  const mountFail = new Error('MOUNT-FAIL')
  const restoreFail = new Error('RESTORE-FAIL')
  const faults = new Map([[2, mountFail], [3, restoreFail]])
  const host3 = stubHostContext({ fault: (attempt) => faults.has(attempt) ? { mount: faults.get(attempt) } : {} })
  const runtime3 = createAgentAssembly(host3.ctx, {
    moduleRoot, enabledModules: () => [], warn: (message) => { host3.warnings.push(message) },
  })
  const agent3 = host3.makeAgent('session-double-failure')
  await host3.fire('agent/created', { agent: agent3, source: 'startup' })
  await runtime3.settled()
  assert.equal(runtime3.hasMounted(agent3.id), true, '首次装配成功')
  await assert.rejects(runtime3.refresh(), (error) => {
    const inner = error.errors[0]
    assert.ok(inner instanceof AggregateError, '两层原因合成一个 AggregateError')
    assert.equal(inner.errors[0], mountFail, 'errors 保留新挂载失败的原因')
    assert.equal(inner.errors[1], restoreFail, 'errors 保留恢复失败的原因')
    assert.match(inner.message, /MOUNT-FAIL/, 'AggregateError 的 message 自带新挂载原因')
    assert.match(inner.message, /RESTORE-FAIL/, 'AggregateError 的 message 自带恢复原因')
    // settings-bridge 的上报只把 error 交给 String()：包装层的 message 也得带出两段原因。
    assert.match(String(error), /运行时配装更新失败.*MOUNT-FAIL.*RESTORE-FAIL/s, '只读 message 的上报点读到两段原因')
    return true
  })
  assert.equal(runtime3.hasMounted(agent3.id), false, '恢复失败不留半挂状态')
  await runtime3.dispose()

  // ④ 边界：挂新失败但恢复成功 ⇒ 与改动前一致：原错误直传、不新增包装、旧贡献复原。
  const mountFailOnly = new Error('MOUNT-FAIL-ONLY')
  const host4 = stubHostContext({ fault: (attempt) => attempt === 2 ? { mount: mountFailOnly } : {} })
  const runtime4 = createAgentAssembly(host4.ctx, {
    moduleRoot, enabledModules: () => [], warn: (message) => { host4.warnings.push(message) },
  })
  const agent4 = host4.makeAgent('session-restore-success')
  await host4.fire('agent/created', { agent: agent4, source: 'startup' })
  await runtime4.settled()
  await assert.rejects(runtime4.refresh(), (error) => {
    assert.equal(error.errors[0], mountFailOnly, '单次失败不新增包装，原错误直传')
    return true
  })
  assert.equal(runtime4.hasMounted(agent4.id), true, '恢复成功：旧贡献复原')
  await runtime4.dispose()
})

test('启用即配装：启用表里的每个模块各贡献一份，清单为空则不装配', async () => {
  // 两个模块各有自己的提示词配置与引擎模块声明：合起来应当两份都进装配输入。
  writePreset('enabled-a', {
    modules: ['prompt-config-engine'],
    promptConfigs: [{ id: 'from-a', strategy: 'static', text: 'A', position: 'after-user' }],
  })
  writePreset('enabled-b', {
    modules: ['prompt-config-engine'],
    promptConfigs: [{ id: 'from-b', strategy: 'static', text: 'B', position: 'after-user' }],
  })

  const host = stubHostContext({ services: ['systemPrompt', 'tools', 'llm'] })
  let enabled = ['enabled-a', 'enabled-b']
  const runtime = createAgentAssembly(host.ctx, {
    moduleRoot,
    enabledModules: () => enabled,
    warn: (message) => { host.warnings.push(message) },
  })
  const agent = host.makeAgent('session-enabled')

  await host.fire('agent/created', { agent, source: 'startup' })
  await runtime.settled()
  assert.equal(host.mounts.length, 1, '启用表里的模块装配成功（发出了一次安装）')
  assert.equal(await host.mounts[0].definition.apply(host.ctx), undefined)
  assert.equal(host.counts.get('agent/pre-step'), 2, '两个模块各贡献一份 pre-step 装配')

  await runtime.dispose()

  // 追加 C：装配范围随之变成三项（启用即配装，无需别的指针）。
  writePreset('enabled-c', {
    modules: ['prompt-config-engine'],
    promptConfigs: [{ id: 'from-c', strategy: 'static', text: 'C', position: 'after-user' }],
  })
  enabled = ['enabled-a', 'enabled-b', 'enabled-c']
  const host3 = stubHostContext({ services: ['systemPrompt', 'tools', 'llm'] })
  const runtime3 = createAgentAssembly(host3.ctx, {
    moduleRoot,
    enabledModules: () => enabled,
    warn: (message) => { host3.warnings.push(message) },
  })
  const agent3 = host3.makeAgent('session-three')
  await host3.fire('agent/created', { agent: agent3, source: 'startup' })
  await runtime3.settled()
  assert.equal(host3.mounts.length, 1, '追加后仍然只安装一次（一份装配承载 N 个模块）')
  await host3.mounts[0].definition.apply(host3.ctx)
  assert.equal(
    host3.counts.get('agent/pre-step'), 3,
    '追加一个模块后装配范围随之增加一份',
  )
  await runtime3.dispose()

  // 空启用表：不注册任何贡献（写盘关闭时上层就是这么返回的）。
  const host0 = stubHostContext({ services: ['systemPrompt', 'tools', 'llm'] })
  const runtime0 = createAgentAssembly(host0.ctx, {
    moduleRoot,
    enabledModules: () => [],
    warn: (message) => { host0.warnings.push(message) },
  })
  const agent0 = host0.makeAgent('session-empty')
  await host0.fire('agent/created', { agent: agent0, source: 'startup' })
  await runtime0.settled()
  assert.equal(host0.mounts.length, 1, '空启用表仍然成功装配（零贡献，但装配生效）')
  await host0.mounts[0].definition.apply(host0.ctx)
  assert.equal(host0.counts.get('agent/pre-step') ?? 0, 0, '空启用表零贡献')
  await runtime0.dispose()
})

/**
 * 配装记录是「这个 Agent 到底装了哪几层提示词」的唯一运行时答案。
 * 真值源是**启用表的字面量顺序**，不是实现自己算出的另一份结果。
 */
test('配装记录报告本 Agent 的提示词层：顺序即启用表，装配前与释放后为空', async () => {
  writePreset('layer-a', {
    modules: ['prompt-config-engine'],
    promptConfigs: [{ id: 'from-a', strategy: 'static', text: 'A', position: 'after-user' }],
  })
  writePreset('layer-b', {
    modules: ['prompt-config-engine'],
    promptConfigs: [{ id: 'from-b', strategy: 'static', text: 'B', position: 'after-user' }],
  })

  const host = stubHostContext({ services: ['systemPrompt', 'tools', 'llm'] })
  const runtime = createAgentAssembly(host.ctx, {
    moduleRoot,
    enabledModules: () => ['layer-a', 'layer-b'],
    warn: (message) => { host.warnings.push(message) },
  })
  const agent = host.makeAgent('session-layers')

  assert.deepEqual(runtime.moduleIds(agent.id), [], '装配前没有提示词层')
  assert.deepEqual(runtime.moduleIds('session-unknown'), [], '从未装过的会话为空')

  await host.fire('agent/created', { agent, source: 'startup' })
  await runtime.settled()
  assert.deepEqual(runtime.moduleIds(agent.id), ['layer-a', 'layer-b'], '顺序与启用表一致')

  await host.fire('agent/disposed', { agent })
  await runtime.settled()
  assert.deepEqual(runtime.moduleIds(agent.id), [], '释放后不再声明提示词层')

  await runtime.dispose()
})
