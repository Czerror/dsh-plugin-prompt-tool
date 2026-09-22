/**
 * T4 能力提供者边界守卫（2026-09-22，PLAN: engine-b3-capability-runtime / Wave 4 / T4）。
 *
 * 分类判据（与 engine/{subagent-tool-policy,tool-config-engine}.mjs 顶部注释、
 * engine/compositions/source/local/{subagent-tool-policy,tool-config-engine,filesystem-editor}.yml
 * 的注释同一份措辞）：
 *   - 会给模型提供可调用能力（注册工具 / 域 / 服务）的 → **能力提供者**（provider）；
 *   - 干预流程（改提示词、改装配、裁决、追加）的 → **声明式触发器**（trigger）。
 *
 * 这些断言全部是**行为/数据断言**：消费模块运行时导出的登记对象、engine 目录清单、
 * 组合源 yml 的解析结果与真实 Cordis 上的注册/撤销行为——不做源码文本匹配。
 *
 * 三个提供者：subagent-tool-policy、tool-config-engine（本仓库实现，登记
 * `engineProvider`）与官方 str-replace-editor（官方包实现，归属校正见最后一组用例）。
 *
 * 后续候选（T4 登记，本支不改）：官方推荐服务定义用 `Service` 子类 +
 * `declare module '@deepseek-ai/cordis'` 声明合并 + `super(ctx, name)`
 * （service-provider-plugin-tutorial-draft.md:103-148）；本项目现用
 * `ctx.provide('pt-*', 普通对象)`（三处：src/index.ts:543/556/569），消费方只能手写
 * 类型断言，全仓无 `declare module`。会波及三处服务与全部消费点，故不在本支改。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import { parse as parseYaml } from '../../engine/vendor/yaml/index.js'

const ENGINE_DIR = fileURLToPath(new URL('../../engine/', import.meta.url))
const LOCAL_DIR = join(ENGINE_DIR, 'compositions', 'source', 'local')

const subagentModule = await import('../../engine/subagent-tool-policy.mjs')
const toolConfigModule = await import('../../engine/tool-config-engine.mjs')

/** 本仓库内的能力提供者登记表；第三个提供者是官方包，不在本仓库（见归属校正用例）。 */
const PROVIDERS = [
  { id: 'subagent-tool-policy', module: subagentModule },
  { id: 'tool-config-engine', module: toolConfigModule },
]

/** 声明式触发器在模块上可能出现的导出名：与 `engineProvider` 互斥（T3 的声明形状）。 */
const TRIGGER_EXPORTS = ['engineTriggers', 'triggers', 'declareTriggers', 'when', 'do', 'schedule', 'degrade']

/** 建一个临时目录，测试结束清理（确定性：目录不存在时用于降级路径）。 */
function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  return dir
}

function loadRows(file) {
  return parseYaml(readFileSync(join(LOCAL_DIR, file), 'utf8'), { logLevel: 'silent' })
}

test('T4：引擎模块要么是声明式触发器、要么是显式登记的能力提供者', async () => {
  const files = readdirSync(ENGINE_DIR).filter((file) => file.endsWith('.mjs')).sort()
  assert.ok(files.length > 10, `扫描到引擎模块清单（实际 ${files.length} 个）`)

  const providers = []
  for (const file of files) {
    const module = await import(pathToFileURL(join(ENGINE_DIR, file)).href)
    const provider = module.engineProvider
    const declaredTriggers = TRIGGER_EXPORTS.filter((key) => module[key] !== undefined)
    if (provider === undefined) continue
    // 互斥：提供者不得同时声明触发器——这条就是「禁止将来把提供者误塞进触发器」的守卫。
    assert.deepEqual(declaredTriggers, [], `${file}: 能力提供者不得同时声明触发器（engineProvider 与 engineTriggers 互斥）`)
    providers.push({ file, provider })
  }

  // 登记与目录事实双向一致：既没有未登记的提供者，也没有清单里的幽灵提供者。
  assert.deepEqual(
    providers.map(({ file }) => file),
    PROVIDERS.map(({ id }) => `${id}.mjs`),
    '导出 engineProvider 的模块集合 = 显式登记的提供者集合',
  )

  for (const { file, provider } of providers) {
    const label = `${file}: engineProvider`
    assert.equal(provider.kind, 'provider', `${label}.kind`)
    assert.equal(provider.moduleId, file.replace(/\.mjs$/, ''), `${label}.moduleId 与文件名同源`)
    assert.equal(provider.registers, 'tools', `${label}.registers 是官方工具 registry，不是触发器引擎通道`)
    if (provider.provides?.kind === 'fixed') {
      assert.ok(
        Array.isArray(provider.provides.tools) && provider.provides.tools.length > 0
        && provider.provides.tools.every((tool) => typeof tool === 'string' && tool.length > 0),
        `${label}.provides.tools 固定清单非空且全为字符串`,
      )
    } else {
      assert.equal(provider.provides?.kind, 'dynamic', `${label}.provides.kind 只能是 fixed / dynamic`)
      assert.ok(typeof provider.provides.source === 'string' && provider.provides.source.length > 0, `${label}.provides.source 说明动态来源`)
    }
  }
})

test('T4：提供者登记与组合源行事实一致（行 id / 引用的实现文件 / 插件名）', () => {
  for (const { id, module } of PROVIDERS) {
    const rows = loadRows(`${id}.yml`)
    const row = rows.find((item) => item.id === id)
    assert.ok(row, `${id}.yml: 必须有同名模块行`)
    assert.equal(row.name, `./engine/${id}.mjs`, `${id}.yml: 行引用的实现文件与登记模块同源`)
    assert.equal(module.name, id, `${id}: Cordis 插件名 = 组合行 id`)
    assert.equal(module.engineProvider.moduleId, id, `${id}: engineProvider.moduleId = 组合行 id`)
  }
})

test('T4：提供者配置声明走 fields.mjs（派生白名单 + 未知键挂载期报错）', () => {
  for (const { id, module } of PROVIDERS) {
    const contract = module.configContract
    assert.ok(contract?.allowedKeys instanceof Set, `${id}: 白名单由字段声明派生（defineConfig）`)
    assert.equal(typeof contract.parse, 'function', `${id}: 有统一 parse 入口`)
    assert.deepEqual(
      Object.keys(contract.parse(undefined, id)).sort(),
      [...contract.allowedKeys].sort(),
      `${id}: parse 只返回声明键`,
    )
    assert.throws(
      () => contract.parse({ t4UnknownKey: 1 }, id),
      new RegExp(`${id}: unknown config key\\(s\\) t4UnknownKey`),
      `${id}: 未知键在挂载期报错`,
    )
  }
})

test('T4：tool-config-engine 注册走 disposer 契约（dispose 后工具撤销）', async () => {
  const dir = tempDir('pt-t4-tools-')
  try {
    writeFileSync(join(dir, 'probe.yml'), [
      'id: t4_probe',
      'name: t4_probe',
      'description: T4 边界守卫探针',
      'parameters: { type: object, properties: {} }',
      'output: { schema: { type: object, additionalProperties: true } }',
      "execute: { kind: ask-user, question: 'probe?' }",
      '',
    ].join('\n'), 'utf8')
    const ctx = new Context()
    // ToolRuntime 的依赖链含 systemPrompt：先加载 SystemPrompt，tools 服务才会就绪。
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const tools = ctx.tools
    toolConfigModule.apply(ctx, { configsDir: dir })
    assert.deepEqual(tools.schemas().map((tool) => tool.name), ['t4_probe'], '装配期注册模型可见工具')
    await ctx.fiber.dispose()
    assert.equal(tools.get('t4_probe'), undefined, 'dispose 后注册被撤销（keepDisposer 契约）')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('T4：subagent-tool-policy 注册走 disposer 契约（fiber dispose 后 shadow 撤销）', async () => {
  const dir = tempDir('pt-t4-shadow-')
  try {
    const file = join(dir, 'policy.yml')
    writeFileSync(file, JSON.stringify({
      defaultProfile: 'base',
      ceiling: { allow: ['read'], deny: [] },
      profiles: [{ id: 'base', name: '基础', allow: ['read'], deny: [], modelSelectable: false }],
    }), 'utf8')

    const root = new Context()
    await root.plugin(SystemPrompt)
    await root.plugin(ToolRuntime)
    const presetKey = {}
    const preset = createScope(root, presetKey)
    Object.defineProperties(preset.ctx, {
      agents: { configurable: true, value: { list: () => [] } },
      subagents: { configurable: true, value: { getProvider: () => undefined } },
    })
    subagentModule.apply(preset.ctx, { policyFile: pathToFileURL(file).href, maxDepth: 3 })

    const agentScope = createScope(root, {}, { parent: presetKey })
    const agentCtx = await new Promise((resolve) => { agentScope.ctx.inject(['tools'], resolve) })
    const agent = { id: 'parent', ctx: agentCtx, options: {}, session: { header: { cwd: process.cwd() } } }
    const tools = root.tools
    const scope = scopeOf(agentCtx)

    preset.ctx.emit('agent/created', { agent })
    const registered = tools.schemas(scope).map((tool) => tool.name).filter((name) => name.startsWith('subagent')).sort()
    assert.deepEqual(registered, [...subagentModule.engineProvider.provides.tools].sort(), '实际注册的工具名 = 登记清单')

    await root.fiber.dispose()
    for (const name of subagentModule.engineProvider.provides.tools) {
      assert.equal(tools.get(name, scope), undefined, `dispose 后 ${name} 撤销（ctx.effect 契约）`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('T4：降级告警统一 `${name}: ` 前缀格式，且整体降级不注册任何能力', () => {
  const toolDir = tempDir('pt-t4-missing-')
  try {
    const toolWarns = []
    const toolCtx = {
      get: () => undefined,
      logger: { info: () => {}, warn: (message) => toolWarns.push(String(message)) },
    }
    toolConfigModule.apply(toolCtx, { configsDir: join(toolDir, 'nope') })
    assert.equal(toolWarns.length, 1, '目录缺失：一条降级告警')
    assert.match(toolWarns[0], /^tool-config-engine: cannot load /, '告警带插件名前缀')

    const policyWarns = []
    const policyCtx = { logger: { warn: (message) => policyWarns.push(String(message)) } }
    assert.doesNotThrow(
      () => subagentModule.apply(policyCtx, { policyFile: pathToFileURL(join(toolDir, 'nope.yml')).href }),
      '策略文件缺失：降级而不是抛错',
    )
    assert.equal(policyWarns.length, 1, '缺文件：一条降级告警')
    assert.match(policyWarns[0], /^subagent-tool-policy: policy file missing/, '告警带插件名前缀')
  } finally {
    rmSync(toolDir, { recursive: true, force: true })
  }
})

test('T4 归属校正：第三个提供者 str-replace-editor 是官方包，本仓库没有对应实现', () => {
  const rows = loadRows('filesystem-editor.yml')
  const editor = rows[0].config.find((row) => row.id === 'str-replace-editor')
  assert.ok(editor, 'filesystem-editor.yml 行下必须有 str-replace-editor 行')
  assert.equal(editor.name, '@deepseek-ai/dsh-tool-str-replace-editor', '第三个提供者是官方包实现')
  assert.ok(editor.name.startsWith('@deepseek-ai/'), '官方 scoped 包：配置声明与注册都在包内')

  const modules = readdirSync(ENGINE_DIR).filter((file) => file.endsWith('.mjs'))
  assert.equal(modules.some((file) => file.includes('str-replace-editor')), false, '本仓库没有对应的 .mjs')
  assert.equal(PROVIDERS.some(({ id }) => id === 'str-replace-editor'), false, '它不在本仓库提供者登记里')

  // tool-git-bash 提供的是 `bash` 工具，不是第三个指定提供者。
  const bashRows = loadRows('tool-git-bash.yml')
  assert.equal(bashRows[0].name, './engine/tool-git-bash.mjs', 'tool-git-bash 是仓库自有实现')
  assert.equal(PROVIDERS.some(({ id }) => id === 'tool-git-bash'), false, '它不在三个指定提供者之列')
})

test('T4：触发器运行时（engine/trigger.mjs）出现后不得把提供者当触发器', async () => {
  const trigger = await import(pathToFileURL(join(ENGINE_DIR, 'trigger.mjs')).href).catch(() => undefined)
  // T3 尚未落地时本用例只做形状声明；trigger.mjs 一旦出现，下面这条守卫自动生效。
  if (trigger === undefined) return

  // 收集触发器运行时对外暴露的一切**数据**导出（函数以外的常量与声明清单）。
  const haystacks = []
  for (const [key, value] of Object.entries(trigger)) {
    if (typeof value === 'function') continue
    haystacks.push(`${key}=${JSON.stringify(value instanceof Set ? [...value] : value) ?? ''}`)
  }
  const declared = trigger.engineTriggers ?? trigger.triggers
  if (declared !== undefined) haystacks.push(JSON.stringify(declared) ?? '')
  const text = haystacks.join('\n')

  for (const { id, module } of PROVIDERS) {
    assert.equal(text.includes(id), false, `${id}: 能力提供者不得出现在触发器声明/常量里`)
    for (const tool of module.engineProvider.provides.tools ?? []) {
      assert.equal(text.includes(tool), false, `${tool}: 提供者工具不得出现在触发器声明/常量里`)
    }
  }
})
