/**
 * 运行时配装通道回归：装配输入必须与原预设形态逐项同源。
 *
 * 真值源是**预设目录里的字面量**（`preset.yml` 的 modules 声明与 `prompt-configs/*.yml`），
 * 不是被测实现自己算出的另一份结果——两条路径互相比对会让同一个错误在两边同时通过。
 *
 * 断言落在调用方观察到的装配输入上：切片（层/位置/时机/次数/受众）、引擎模块清单、
 * 受管字段的绝对位置。改装配实现时这些契约不变。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
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
  writeFileSync(join(dir, 'preset.yml'), `${JSON.stringify({
    id, name: id, modules, ...(moduleConfigs === undefined ? {} : { moduleConfigs }),
  }, null, 2)}\n`, 'utf8')
  if (promptConfigs.length > 0) {
    const configsDir = join(dir, 'prompt-configs')
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

test('受管字段路径换算与原注册层同基准：`.` 基准预设目录，`..` 基准历史引擎位置', async () => {
  const id = 'managed-paths'
  const dir = join(presetRoot, id)
  writePreset(id, {
    modules: ['prompt-config-engine', 'tool-config-engine', 'declared-triggers', 'subagent-tool-policy'],
    moduleConfigs: {
      // `.` 开头：基准是预设目录。
      'tool-config-engine': { configsDir: './custom-tools' },
      // `..` 开头：基准是 `<预设根>/.engine/`，故必须带 id 段才落回预设目录内。
      'declared-triggers': { triggersFile: `../${id}/triggers.yml` },
      // 已写死的绝对 file URL：原样保留，不二次解析。
      'subagent-tool-policy': { policyFile: pathToFileURL(join(dir, 'subagent-tools', 'policy.yml')).href },
    },
  })
  mkdirSync(join(dir, 'custom-tools'), { recursive: true })
  mkdirSync(join(dir, 'prompt-configs'), { recursive: true })
  mkdirSync(join(dir, 'subagent-tools'), { recursive: true })
  writeFileSync(join(dir, 'triggers.yml'), '[]\n', 'utf8')
  writeFileSync(join(dir, 'subagent-tools', 'policy.yml'), 'tools: {}\n', 'utf8')

  const prepared = await prepareAssembly(presetRoot, id, hasEveryService)
  const configOf = (id) => prepared.modules.find((module) => module.id === id)?.config ?? {}

  const cases = [
    ['tool-config-engine', 'configsDir', join(dir, 'custom-tools')],
    ['declared-triggers', 'triggersFile', join(dir, 'triggers.yml')],
    ['subagent-tool-policy', 'policyFile', join(dir, 'subagent-tools', 'policy.yml')],
  ]
  for (const [id, field, expectedPath] of cases) {
    const value = configOf(id)[field]
    assert.equal(typeof value, 'string', `${id}.${field} 已换算`)
    assert.equal(fileURLToPath(value), expectedPath, `${id}.${field} 指向预设目录内`)
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
