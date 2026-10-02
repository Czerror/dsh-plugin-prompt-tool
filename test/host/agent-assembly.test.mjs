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
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { createScope, scopeTarget } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { isolatedHome } from '../fixtures/host-harness.mjs'

const { moduleRoot } = isolatedHome('pt-assembly-')
const { prepareAssembly, createAgentAssembly } = await import('../../src/runtime/agent-assembly.ts')
const { installPreStepCoordinator } = await import('../../src/runtime/pre-step-coordinator.ts')

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
  assert.deepEqual(h.warnings, [])
  await h.runtime.dispose()
  assert.deepEqual(texts(await h.inject(main)), ['USER'])
  const after = await h.root.systemPrompt.assemble({ agent: main, scope: main })
  assert.equal(after.sections.some((section) => ['SYSTEM', 'PERSONA', 'SUFFIX'].includes(section.text)), false)
  assert.ok(after.contexts.some((context) => context.text === 'CONTEXT'))
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

test('能力注册：私有工具服务与物化工具接入官方注册表，禁用后释放', async (t) => {
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

function writePreset(id, { modules, promptConfigs = [], moduleConfigs, persona }) {
  const dir = join(moduleRoot, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'module.yml'), `${JSON.stringify({
    id, name: id, modules, ...(moduleConfigs === undefined ? {} : { moduleConfigs }), ...(persona === undefined ? {} : { persona }),
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

test('装配切片逐条来自预设目录的字面量：层/位置/时机/次数/受众一项不改', async () => {
  writePreset('literal-slices', { modules: ['prompt-config-engine'], promptConfigs: LITERAL_SLICES })
  const prepared = await prepareAssembly(moduleRoot, 'literal-slices', hasEveryService)

  assert.equal(prepared.moduleId, 'literal-slices')
  assert.equal(prepared.configs.length, LITERAL_SLICES.length, '切片条数与字面量一致')
  for (const [index, expected] of LITERAL_SLICES.entries()) {
    const actual = prepared.configs[index]
    assert.equal(actual.id, expected.id)
    assert.equal(actual.layer, expected.layer, '注入层')
    assert.equal(actual.position, expected.position, '位置')
    assert.equal(actual.promotion, expected.promotion, '时机/晋升')
    assert.equal(actual.dedupe, expected.dedupe, '次数/去重')
    assert.equal(actual.audience, expected.audience, '受众')
    assert.equal(actual.order, expected.order)
    assert.equal(actual.modelScope, expected.modelScope ?? 'all')
  }
  // 有切片就有注入执行器：三个宿主能力进装配依赖。
  for (const name of ['systemPrompt', 'tools', 'llm']) {
    assert.equal(prepared.services.has(name), true, `依赖 ${name}`)
  }
})

test('受管字段一律解析到当前预设目录内：新写法 `./` 与历史写法 `../<id>/` 同结果', async () => {
  const id = 'managed-paths'
  const dir = join(moduleRoot, id)
  writePreset(id, {
    modules: ['prompt-config-engine', 'tool-config-engine', 'declared-triggers', 'subagent-tool-policy'],
    moduleConfigs: {
      // 新形态：预设目录基准。
      'tool-config-engine': { configsDir: './custom-tools' },
      // 历史写法：相对历史引擎位置书写，必须仍解析到同一处。
      'declared-triggers': { triggersFile: `../${id}/triggers.yml` },
      // 组合源默认相对模块内引擎位置，仍然必须消费本模块的物化策略。
      'subagent-tool-policy': { policyFile: '../subagent-tools/policy.yml' },
    },
  })
  mkdirSync(join(dir, 'custom-tools'), { recursive: true })
  mkdirSync(join(dir, 'configs'), { recursive: true })
  writeFileSync(join(dir, 'triggers.yml'), '[]\n', 'utf8')

  const prepared = await prepareAssembly(moduleRoot, id, hasEveryService)
  const configOf = (moduleId) => prepared.modules.find((module) => module.id === moduleId)?.config ?? {}

  const cases = [
    ['tool-config-engine', 'configsDir', join(dir, 'custom-tools')],
    ['declared-triggers', 'triggersFile', join(dir, 'triggers.yml')],
    ['subagent-tool-policy', 'policyFile', join(dir, 'subagent-tools', 'policy.yml')],
  ]
  for (const [moduleId, field, expectedPath] of cases) {
    const value = configOf(moduleId)[field]
    assert.equal(typeof value, 'string', `${moduleId}.${field} 已换算`)
    assert.equal(fileURLToPath(value), expectedPath, `${moduleId}.${field} 的落点`)
  }
})

test('模块清单：引擎能力装载，官方组合行与能力 recipe 留给会话原有预设', async () => {
  writePreset('module-roster', {
    modules: ['character-tools', 'tool-config-engine', 'tool-pwsh', 'planning'],
  })
  const prepared = await prepareAssembly(moduleRoot, 'module-roster', hasEveryService)
  const ids = prepared.modules.map((module) => module.id)

  // 插件包内确有 engine mjs 的能力：装载（官方行的 config 已由参数桥并入）。
  assert.deepEqual(ids, ['character-tools', 'tool-config-engine'])
  // 只有 library yml、没有 engine mjs 的官方行与 recipe：跳过，不装第二棵官方树。
  assert.equal(ids.includes('tool-pwsh'), false)
  assert.equal(ids.includes('planning'), false)
  // 私有能力复用现有适配器挂载服务，而不是只登记依赖。
  assert.equal(prepared.services.has('pt-character-tools'), true)
  assert.equal(ids.includes('character-tools'), true)
})

test('拒绝路径：非法 id、无效模块声明、缺失宿主能力都在装配前 fail loud', async () => {
  await assert.rejects(
    prepareAssembly(moduleRoot, 'Not_An_Id', hasEveryService),
    /非法预设 id/,
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
    /多个生效的「独占」段/,
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
    /人设已开启/,
    '人设与配置同时独占必须被拒',
  )

  // ③ 边界一：第二个独占被 `enabled: false` 关掉 → 不算冲突。
  writePreset('one-complete-disabled', {
    modules: ['prompt-config-engine'],
    promptConfigs: [exclusive('excl-a'), exclusive('excl-b', false)],
  })
  const allowed = await prepareAssembly(moduleRoot, 'one-complete-disabled', hasEveryService)
  assert.equal(allowed.configs.length, 2, '禁用的切片仍进装配输入（由引擎过滤 enabled）')

  // ④ 边界二：单独一个独占（无人设）→ 放行，且人设存在但未开独占也放行。
  writePreset('single-complete', {
    modules: ['prompt-config-engine'],
    promptConfigs: [exclusive('excl-a')],
    persona: { prefix: 'PREFIX' },
  })
  const single = await prepareAssembly(moduleRoot, 'single-complete', hasEveryService)
  assert.equal(single.configs.length, 1, '单个独占段正常装配')
})

test('官方挂载行与本通道不重复装载：引擎能力只出现一次', async () => {
  // 物化产物里既有官方工具行，也有引擎行；自建通道只认引擎能力。
  const dir = writePreset('mixed-rows', {
    modules: ['prompt-config-engine', 'tool-config-engine', 'tool-pwsh', 'planning', 'compaction'],
  })
  mkdirSync(join(dir, 'configs'), { recursive: true })
  mkdirSync(join(dir, 'custom-tools'), { recursive: true })

  const prepared = await prepareAssembly(moduleRoot, 'mixed-rows', hasEveryService)
  const ids = prepared.modules.map((module) => module.id)
  assert.deepEqual(ids, ['tool-config-engine'], '只装引擎能力，官方行不在本通道内')
  assert.equal(new Set(ids).size, ids.length, '同一份组合不会装入重复模块')
  // 切片只由 applyPromptConfigs 挂一次，不由模块清单再挂一遍。
  assert.equal(ids.includes('prompt-config-engine'), false)
})

test('与官方物化路径同源：writePreset 落盘的切片 = 配装读出的切片', async () => {
  const { writePreset } = await import('../../src/host/write-preset.ts')
  const id = 'materialized-slices'
  // 定义来源目录（writePreset 的模板解析基准：sourceDir 优先于同名已安装预设）。
  const sourceDir = join(moduleRoot, '.source-materialized')
  mkdirSync(sourceDir, { recursive: true })
  writeFileSync(join(sourceDir, 'module.yml'), `${JSON.stringify({
    id, name: id, modules: ['prompt-config-engine'],
  }, null, 2)}\n`, 'utf8')
  // 官方路径：把同一份切片交给 writePreset 物化到 <预设根>/<id>/configs。
  writePreset('materialized prompt', {
    moduleDir: moduleRoot,
    presetOrder: 5,
    promptConfigs: LITERAL_SLICES,
    presetTemplate: id,
    outputId: id,
    sourceDir,
    agentsInstructionText: '',
  })
  const prepared = await prepareAssembly(moduleRoot, id, hasEveryService)
  assert.equal(prepared.configs.length, LITERAL_SLICES.length, '条数与落盘一致')
  for (const [index, expected] of LITERAL_SLICES.entries()) {
    const actual = prepared.configs[index]
    // 五个维度逐条对拍：写的层/位置/时机/次数/受众，读回来一项不改。
    assert.equal(actual.id, expected.id)
    assert.equal(actual.strategy, expected.strategy)
    assert.equal(actual.layer, expected.layer)
    assert.equal(actual.position, expected.position)
    assert.equal(actual.promotion, expected.promotion)
    assert.equal(actual.dedupe, expected.dedupe)
    assert.equal(actual.audience, expected.audience)
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
  // 宿主能力探针：默认全不可用（与「装配失败降级为告警」那条用例的前提一致）；
  // 传 `services` 时才视为可用——带切片的模块要求 systemPrompt/tools/llm。
  const services = new Set(options.services ?? [])
  return {
    warnings,
    counts,
    mounts,
    /** 假 Agent：真实 Agent 的 ctx 是可安装插件的 scope 上下文；这里只记下安装请求。 */
    makeAgent: (id) => ({
      id,
      ctx: {
        get: (name) => services.has(name) ? {} : undefined,
        plugin: (definition) => {
          mounts.push({ id, definition })
          return Promise.resolve({ dispose: async () => {} })
        },
      },
    }),
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
      effect: (register) => { const remove = register(); disposers.push(remove); return () => {} },
      get: (name) => services.has(name) ? {} : undefined,
      // 构造期会枚举存量 Agent；由 index.ts 的 ctx.inject(['agents']) 保证真实可用。
      agents: { list: () => [] },
      logger: { warn: (message) => { warnings.push(message) } },
    },
  }
}

test('装配失败降级为告警：不抛出、不阻塞会话创建、不留半挂状态', async () => {
  // 启用表里有一项非法 id ⇒ prepareAssembly 在准备期就抛（与真实坏定义同一条路径）。
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
  await runtime.dispose()
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
