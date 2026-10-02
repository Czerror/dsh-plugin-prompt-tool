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
import { isolatedHome } from '../fixtures/host-harness.mjs'

const { presetRoot } = isolatedHome('pt-assembly-')
const { prepareAssembly, createAgentAssembly } = await import('../../src/runtime/agent-assembly.ts')

/** 装配能力探针：装配只问「宿主是否提供该服务」，这里全部视为提供。 */
const hasEveryService = () => true

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

function writePreset(id, { modules, promptConfigs = [], moduleConfigs }) {
  const dir = join(presetRoot, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'module.yml'), `${JSON.stringify({
    id, name: id, modules, ...(moduleConfigs === undefined ? {} : { moduleConfigs }),
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
  const prepared = await prepareAssembly(presetRoot, 'literal-slices', hasEveryService)

  assert.equal(prepared.presetId, 'literal-slices')
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
    assert.equal(actual.modelScope, expected.modelScope)
  }
  // 有切片就有注入执行器：三个宿主能力进装配依赖。
  for (const name of ['systemPrompt', 'tools', 'llm']) {
    assert.equal(prepared.services.has(name), true, `依赖 ${name}`)
  }
})

test('受管字段一律解析到当前预设目录内：新写法 `./` 与历史写法 `../<id>/` 同结果', async () => {
  const id = 'managed-paths'
  const dir = join(presetRoot, id)
  writePreset(id, {
    modules: ['prompt-config-engine', 'tool-config-engine', 'declared-triggers', 'subagent-tool-policy'],
    moduleConfigs: {
      // 新形态：预设目录基准。
      'tool-config-engine': { configsDir: './custom-tools' },
      // 历史写法：相对历史引擎位置书写，必须仍解析到同一处。
      'declared-triggers': { triggersFile: `../${id}/triggers.yml` },
      // 历史写法（`../` 但不带 id 段）：落到预设根，引擎的越界校验负责拒绝。
      'subagent-tool-policy': { policyFile: '../subagent-tools/policy.yml' },
    },
  })
  mkdirSync(join(dir, 'custom-tools'), { recursive: true })
  mkdirSync(join(dir, 'configs'), { recursive: true })
  writeFileSync(join(dir, 'triggers.yml'), '[]\n', 'utf8')

  const prepared = await prepareAssembly(presetRoot, id, hasEveryService)
  const configOf = (moduleId) => prepared.modules.find((module) => module.id === moduleId)?.config ?? {}

  const cases = [
    ['tool-config-engine', 'configsDir', join(dir, 'custom-tools')],
    ['declared-triggers', 'triggersFile', join(dir, 'triggers.yml')],
    // `../` 按 path.resolve 语义上溯一级：以预设目录为基准，落点是预设根下的兄弟路径
    // ——`subagent-tool-policy` 组合源的缺省值就是这种形态。
    ['subagent-tool-policy', 'policyFile', join(presetRoot, 'subagent-tools', 'policy.yml')],
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
  const prepared = await prepareAssembly(presetRoot, 'module-roster', hasEveryService)
  const ids = prepared.modules.map((module) => module.id)

  // 插件包内确有 engine mjs 的能力：装载（官方行的 config 已由参数桥并入）。
  assert.deepEqual(ids, ['tool-config-engine'])
  // 只有 library yml、没有 engine mjs 的官方行与 recipe：跳过，不装第二棵官方树。
  assert.equal(ids.includes('tool-pwsh'), false)
  assert.equal(ids.includes('planning'), false)
  // 私有服务能力经服务判定挂载，不从包内 engine 目录 import。
  assert.equal(prepared.services.has('pt-character-tools'), true)
  assert.equal(ids.includes('character-tools'), false)
})

test('拒绝路径：非法 id、无效模块声明、缺失宿主能力都在装配前 fail loud', async () => {
  await assert.rejects(
    prepareAssembly(presetRoot, 'Not_An_Id', hasEveryService),
    /非法预设 id/,
  )
  writePreset('unknown-capability', { modules: ['no-such-capability-anywhere'] })
  await assert.rejects(
    prepareAssembly(presetRoot, 'unknown-capability', hasEveryService),
    /模块声明无效/,
  )
  writePreset('requires-missing-service', { modules: ['prompt-config-engine'], promptConfigs: LITERAL_SLICES })
  await assert.rejects(
    prepareAssembly(presetRoot, 'requires-missing-service', () => false),
    /配装所需宿主能力不可用/,
  )
})

test('官方挂载行与本通道不重复装载：引擎能力只出现一次', async () => {
  // 物化产物里既有官方工具行，也有引擎行；自建通道只认引擎能力。
  const dir = writePreset('mixed-rows', {
    modules: ['prompt-config-engine', 'tool-config-engine', 'tool-pwsh', 'planning', 'compaction'],
  })
  mkdirSync(join(dir, 'configs'), { recursive: true })
  mkdirSync(join(dir, 'custom-tools'), { recursive: true })

  const prepared = await prepareAssembly(presetRoot, 'mixed-rows', hasEveryService)
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
  const sourceDir = join(presetRoot, '.source-materialized')
  mkdirSync(sourceDir, { recursive: true })
  writeFileSync(join(sourceDir, 'module.yml'), `${JSON.stringify({
    id, name: id, modules: ['prompt-config-engine'],
  }, null, 2)}\n`, 'utf8')
  // 官方路径：把同一份切片交给 writePreset 物化到 <预设根>/<id>/configs。
  writePreset('materialized prompt', {
    presetDir: presetRoot,
    presetOrder: 5,
    promptConfigs: LITERAL_SLICES,
    presetTemplate: id,
    outputId: id,
    sourceDir,
    agentsInstructionText: '',
  })
  const prepared = await prepareAssembly(presetRoot, id, hasEveryService)
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
function stubHostContext() {
  const listeners = new Map()
  const warnings = []
  const disposers = []
  return {
    warnings,
    fire: async (name, payload) => {
      const handler = listeners.get(name)
      if (handler === undefined) throw new Error(`no listener for ${name}`)
      return handler(payload)
    },
    ctx: {
      on: (name, handler) => { listeners.set(name, handler); return () => { listeners.delete(name) } },
      effect: (register) => { const remove = register(); disposers.push(remove); return () => {} },
      get: () => undefined,
      // 构造期会枚举存量 Agent；由 index.ts 的 ctx.inject(['agents']) 保证真实可用。
      agents: { list: () => [] },
      logger: { warn: (message) => { warnings.push(message) } },
    },
  }
}

test('装配失败降级为告警：不抛出、不阻塞会话创建、不留半挂状态', async () => {
  // 预设 id 非法 ⇒ prepareAssembly 在准备期就抛（与真实坏定义同一条路径）。
  writePreset('assembly-target', { modules: ['tool-config-engine'] })
  const host = stubHostContext()
  const runtime = createAgentAssembly(host.ctx, {
    presetRoot,
    currentPreset: () => 'Not_An_Id',
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
