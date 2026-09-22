/**
 * B7 T1 → T3 —— `tool-filter` 的**声明契约与新增覆盖**：`test/engine/declarations/tool-filter.yml`。
 *
 * T1 时本文件是「声明 vs 原模块 `engine/tool-filter.mjs`」的等价对拍。T3 把该模块与本地下
 * 同名组合源一并删除（工具过滤改由预设顶层 `triggers` 段的声明表达），对拍的那一半已无对象
 * 可对，随模块一同退场。保留下来的都是**声明侧**断言，不依赖原模块：
 *   - 声明文件自身的契约：三条声明（呈现 / SDK 正文裁剪 / 执行 guard）与模式互斥；
 *   - 保留名 `run_code` 的三条语义（allow 可点名、deny 挂载期拒绝、未点名按 fail-closed 剔出）；
 *   - PTC 形态与执行边界的真实宿主覆盖（`sdk-strip` + `guard` 是原模块**没有**的两层）。
 *
 * 名单语义按用户拍板取**模式互斥**（allow / deny 只写一侧）；旧实现的「allow 与 deny 同时
 * 生效、deny 优先」那条语义已被放弃，因此不再有对应断言。
 *
 * ctx 桩与 PTC 环境形状取自 actions.test.mjs 的 `ptcHarness`（真实 SystemPrompt + ToolRuntime，
 * 只替换语言运行时）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { compileDeclarations, mountDeclarations } from '../../engine/trigger-spec.mjs'
import { SDK_SECTION_NAME, sdkToolNames } from '../../engine/sdk-strip.mjs'

/** 声明文件本体（测的就是这份 YAML，不是测试里另抄的一份）。 */
const DECLARATIONS = parse(readFileSync(new URL('./declarations/tool-filter.yml', import.meta.url), 'utf8'))

const PLUGIN = 'tool-filter-declaration'

/** 收集 ctx.on 注册的监听器（按注册顺序），并返回与 Cordis 同形状的 disposer。 */
function makeCtx() {
  const listeners = new Map()
  const ctx = {
    logger: { warn: () => {} },
    get: () => undefined,
    on(type, handler, options) {
      const list = listeners.get(type) ?? []
      list.push({ handler, options })
      listeners.set(type, list)
      return () => {
        const current = listeners.get(type) ?? []
        const index = current.findIndex((entry) => entry.handler === handler)
        if (index >= 0) current.splice(index, 1)
      }
    },
  }
  return { ctx, listeners }
}

const handlersOf = (listeners, event) => (listeners.get(event) ?? []).map((entry) => entry.handler)

const makeSession = (depth = 0) => ({ id: `s-${Math.random()}`, header: { delegationDepth: depth } })
const makeAgent = (session) => ({ session })
const tool = (name) => ({ name, description: `tool ${name}` })

/** 装配输入：带干扰 sections / contexts，用来证明过滤不动这些字段。 */
const assemblyOf = (tools) => ({
  tools,
  sections: [{ name: 'keep-me', text: 'X' }],
  contexts: [{ name: 'keep-me-too', text: 'Y' }],
  variables: {},
})

/** `system-prompt/assemble`：(assembly, context, next)，按注册顺序串成 waterfall。 */
async function assembleThrough(listeners, agent, input) {
  const handlers = handlersOf(listeners, 'system-prompt/assemble')
  const run = (index) => (index >= handlers.length
    ? input
    : handlers[index](input, { agent, scope: agent }, () => run(index + 1)))
  return run(0)
}

/**
 * 只替换名单，声明形状（通道 / 动作 / channelOrder / waterfallPosition / 受众）逐字来自 YAML。
 * 名单在三个动作上的落点不同：`assembly.target.tools`、`sdk-strip.mask`、`guard.mask`。
 */
function withMask(declarations, mask) {
  return declarations.map((declaration) => ({
    ...declaration,
    do: {
      ...declaration.do,
      ...(declaration.do.target !== undefined ? { target: { ...declaration.do.target, tools: mask } } : {}),
      ...(declaration.do.mask !== undefined ? { mask } : {}),
    },
  }))
}

/** 只取呈现过滤那一条声明：其余两条（SDK 正文裁剪 / 执行 guard）另由 PTC 用例覆盖。 */
const presentationOnly = (mask) => withMask(DECLARATIONS.filter((item) => item.id === 'tool-filter-presentation'), mask)

// ───────────────────────── 一、声明文件自身的契约 ─────────────────────────

const masksOf = (declaration) => [declaration.do.target?.tools, declaration.do.mask].filter((mask) => mask !== undefined)

test('声明文件：模式互斥（同一份名单不并存 allow 与 deny），三处消费同一份名单', () => {
  assert.deepEqual(DECLARATIONS.map((item) => item.id),
    ['tool-filter-presentation', 'tool-filter-sdk', 'tool-filter-guard'])
  const masks = DECLARATIONS.flatMap(masksOf)
  assert.equal(masks.length, 3, '呈现 / SDK 正文 / 执行 guard 三处各有一份名单')
  for (const mask of masks) {
    assert.equal(mask.allow !== undefined && mask.deny !== undefined, false,
      '模式互斥：一份声明只写 allow 或 deny（旧实现 deny 优先的语义已废弃）')
    assert.ok(mask.allow !== undefined || mask.deny !== undefined, '空名单无法表达剔哪些工具')
    assert.equal([mask.allow, mask.deny].flat().filter((name) => name !== undefined).includes('run_code'), false,
      '不得点名 PTC 传输名 run_code')
  }
  for (const mask of masks.slice(1)) {
    assert.deepEqual(mask.deny ?? mask.allow, masks[0].deny ?? masks[0].allow,
      '同一份名单判据驱动呈现、SDK 裁剪与执行 guard')
  }
  // 通道与位置：三条都在 `system-prompt/assemble`；受众按原模块写 false（2026-09-22 拍板：
  // 执行边界留待 agent scope 的 guard，呈现这一层不做受众判定）。
  //
  // B8 T1（2026-09-22）：**呈现过滤是否决型门控**——它裁 `assembly.tools`、本质是否决，
  // 必须位于普通注册之外，故取 `waterfallPosition: outermost`（→ `registrationOptions` 的
  // `prepend: true`）。真实 cordis 反例见 `test/engine/assemble-authority.test.mjs`。
  // 另外两条保持 `default`：`sdk-strip` 改写的是 `tools:sdk` 段正文、不构成否决；`guard`
  // 不在 `ON_REGISTERED_KINDS` 内，带 `prepend` 会挂载期抛错（actions.mjs:823-826）。
  for (const declaration of DECLARATIONS) {
    assert.equal(declaration.channel, 'system-prompt/assemble')
    assert.equal(declaration.when, undefined, '本轮声明不需要 when')
  }
  assert.equal(DECLARATIONS.find((item) => item.id === 'tool-filter-presentation').waterfallPosition, 'outermost',
    'B8 T1：呈现过滤是否决型门控，必须位于普通注册之外')
  for (const id of ['tool-filter-sdk', 'tool-filter-guard']) {
    assert.equal(DECLARATIONS.find((item) => item.id === id).waterfallPosition, 'default',
      `${id} 保持默认位置：sdk-strip 非否决；guard 不支持 prepend`)
  }
  const guard = DECLARATIONS.find((item) => item.do.kind === 'guard')
  assert.equal(guard.do.includeSubagents, false, '执行 guard 的受众与旧实现一致（只作用主会话）')
})

test('allow 模式可点名 run_code（2026-09-22 拍板修复后的语义）', async () => {
  // 声明允许点名 run_code：此前「点名即挂载期报错、不点名又被 fail-closed 连带剔出」等于
  // PTC 预设失去唯一可调用入口（`createMask` 曾对 allow/deny 一律拒绝该保留名）。
  const named = makeCtx()
  mountDeclarations(named.ctx, compileDeclarations(presentationOnly({ allow: ['read', 'run_code'] })), { plugin: PLUGIN })
  const declared = await assembleThrough(named.listeners, makeAgent(makeSession()), assemblyOf(['read', 'run_code', 'web_search'].map(tool)))
  assert.deepEqual(declared.tools.map((item) => item.name), ['read', 'run_code'], 'allow 可把 run_code 留在装配目录')

  // deny 点名它仍然挂载期拒绝：那会让整个 PTC 面失效（唯一入口被封）。
  const denied = makeCtx()
  assert.throws(
    () => mountDeclarations(denied.ctx, compileDeclarations(presentationOnly({ deny: ['run_code'] })), { plugin: PLUGIN }),
    /must not name the reserved run_code/,
    'deny 侧不放宽',
  )

  // 不点名仍按 fail-closed 被剔（这条语义没有放宽）。
  const unnamed = makeCtx()
  mountDeclarations(unnamed.ctx, compileDeclarations(presentationOnly({ allow: ['read'] })), { plugin: PLUGIN })
  const filtered = await assembleThrough(unnamed.listeners, makeAgent(makeSession()), assemblyOf(['read', 'run_code'].map(tool)))
  assert.deepEqual(filtered.tools.map((item) => item.name), ['read'], 'run_code 被 allow 名单剔出（未点名）')
})

// ───────────────────────── 二、PTC 形态与执行边界 ─────────────────────────

/**
 * 真实 SystemPrompt + ToolRuntime 的 PTC 环境；只替换语言运行时（不替换工具管线）。
 * 与 actions.test.mjs:349-403 的 `ptcHarness` 同一形状（本文件不改既有测试，故就地复用）。
 * `own_tool` 注册在 agent 本层——`restrict` 收不动它，因此它是执行 guard 的唯一兜底面。
 */
async function ptcHarness({ language = 'typescript', mode = 'ptc' } = {}) {
  const root = new Context()
  await root.plugin(SystemPrompt)
  await root.plugin(ToolRuntime, { mode })
  const bodyRuns = []
  const programs = []
  const definition = (toolName) => ({
    name: toolName,
    description: `tool ${toolName}`,
    parameters: { type: 'object', properties: { command: { type: 'string' } }, additionalProperties: true },
    output: { schema: { type: 'object', additionalProperties: true }, render: () => [{ type: 'text', text: 'ok' }] },
    execute: async () => { bodyRuns.push(toolName); return { ran: toolName } },
  })
  root.tools.register(definition('bash'))
  root.tools.register(definition('read'))
  root.provide('ptcRuntime', {
    language,
    resolve: (spec) => spec,
    // 程序文本就是绑定名：调用它并回传结果/错误，子调用因此走真实调度与裁决管线。
    run: async (spec) => {
      programs.push(spec.program)
      const binding = spec.bindings[0].functions[spec.program]
      if (binding === undefined) return { logs: [], error: { kind: 'program', message: `no binding ${spec.program}` } }
      try {
        return { logs: [], value: await binding({ command: 'echo hi' }) }
      } catch (error) {
        return { logs: [], error: { kind: 'tool', message: String(error?.message ?? error) } }
      }
    },
  })
  const makeAgent = async (id, parentScope) => {
    const record = {
      id,
      options: { model: 'deepseek-chat' },
      session: { id, header: { delegationDepth: parentScope === undefined ? 0 : 1 }, append() {}, snapshotEvents: () => [] },
    }
    const scope = parentScope === undefined ? createScope(root, record) : createScope(root, record, { parent: parentScope })
    record.ctx = await new Promise((resolve) => { scope.ctx.inject(['tools'], (runtimeCtx) => resolve(runtimeCtx)) })
    record.ctx.tools.register(definition('own_tool'))
    return record
  }
  const main = await makeAgent('main')
  const runCode = async (target, program) => root.tools.execute({
    callId: `c-${programs.length}`,
    name: 'run_code',
    agent: target,
    arguments: { code: program, description: `run ${program}` },
    signal: new AbortController().signal,
  })
  // 官方 assembly 上下文形状：`{ agent, scope: agent }`（dsh-agent `assembleContextFor`）。
  const assemble = (target) => root.systemPrompt.assemble({ agent: target, scope: target })
  return { root, tools: root.tools, main, makeAgent, bodyRuns, programs, runCode, assemble }
}

/** 在 PTC 环境里挂上整份声明（呈现 + SDK 裁剪 + guard），名单由调用方给。 */
function mountAll(root, mask) {
  return mountDeclarations(root, compileDeclarations(withMask(DECLARATIONS, mask)), { plugin: PLUGIN })
}

test('PTC 新增覆盖：被剔工具既不在 assembly.tools、也不在 tools:sdk 段正文', async () => {
  // `mode: 'both'` 同时呈现原生 schema 与 tools:sdk 段（ToolPresentationMode，
  // dsh-tools/lib/types/index.d.ts:458）——父需求的两半在这一档里都能被观测到；
  // 纯 `mode: 'ptc'` 下原生 schema 本就被 run_code 取代，那一半会是空断言。
  const h = await ptcHarness({ language: 'typescript', mode: 'both' })
  try {
    // 挂声明之前：真实装配里工具与 SDK 声明都在。
    const before = await h.assemble(h.main)
    const beforeSdk = before.sections.find((section) => section.name === SDK_SECTION_NAME)
    assert.ok(beforeSdk, '装配里必须存在 tools:sdk 段')
    assert.deepEqual(sdkToolNames(beforeSdk.text).sort(), ['bash', 'own_tool', 'read'], '装配前正文确实带着被剔工具')
    assert.ok(before.tools.some((item) => item.name === 'own_tool'), '装配前目录里确实带着被剔工具')
    assert.ok(before.tools.some((item) => item.name === 'run_code'), 'PTC 传输名在目录里')

    const dispose = mountAll(h.root, { deny: ['own_tool'] })
    const assembly = await h.assemble(h.main)
    assert.equal(assembly.tools.some((item) => item.name === 'own_tool'), false,
      '被剔工具不得留在 assembly.tools（呈现过滤）')
    assert.ok(assembly.tools.some((item) => item.name === 'run_code'), 'PTC 传输名不得被剔（deny 模式未点名它）')
    const sdk = assembly.sections.find((section) => section.name === SDK_SECTION_NAME)
    assert.deepEqual(sdkToolNames(sdk.text).sort(), ['bash', 'read'], 'SDK 声明正文里也必须消失')
    assert.equal(sdk.text.includes('own_tool'), false, '正文里不得残留被剔工具的声明')
    dispose()
  } finally {
    await h.root.fiber.dispose()
  }
})

test('(b) 执行边界：真实 run_code 子调用被 guard 拒绝（TypeScript 载荷），工具体一次都没执行', async () => {
  const h = await ptcHarness({ language: 'typescript' })
  const dispose = mountAll(h.root, { deny: ['own_tool'] })
  try {
    await h.assemble(h.main)
    assert.ok(h.tools.schemas(h.main).some((schema) => schema.name === 'own_tool'),
      '绑定必须存在，否则测的不是 guard')
    const denied = await h.runCode(h.main, 'own_tool')
    assert.equal(denied.isError, true, '被剔工具的 PTC 子调用必须失败')
    assert.match(denied.content[0].text, /blocked by tool-filter declaration/, '拒绝理由必须存在')
    assert.deepEqual(h.bodyRuns, [], '工具体不得执行')
    const allowed = await h.runCode(h.main, 'read')
    assert.equal(allowed.isError, false, '名单外工具照常放行')
    assert.deepEqual(h.bodyRuns, ['read'])
  } finally {
    dispose()
    await h.root.fiber.dispose()
  }
})

test('(b) 执行边界：Python 载荷同样被同一份名单拒绝', async () => {
  const h = await ptcHarness({ language: 'python' })
  const dispose = mountAll(h.root, { deny: ['own_tool'] })
  try {
    await h.assemble(h.main)
    const denied = await h.runCode(h.main, 'own_tool')
    assert.equal(denied.isError, true)
    assert.match(denied.content[0].text, /blocked by tool-filter declaration/)
    assert.deepEqual(h.bodyRuns, [])
  } finally {
    dispose()
    await h.root.fiber.dispose()
  }
})

test('(b) 执行边界：guard 只作用于主会话（includeSubagents:false），子代理放行', async () => {
  const h = await ptcHarness()
  const child = await h.makeAgent('child', h.main)
  const dispose = mountAll(h.root, { deny: ['own_tool'] })
  try {
    await h.assemble(h.main)
    await h.assemble(child)
    assert.equal((await h.runCode(h.main, 'own_tool')).isError, true, '主会话被拦')
    const childRun = await h.runCode(child, 'own_tool')
    assert.equal(/blocked by tool-filter declaration/.test(childRun.content?.[0]?.text ?? ''), false,
      '子代理不得被仅主会话的 guard 拒绝（受众与旧实现一致）')
    assert.deepEqual(h.bodyRuns, ['own_tool'])
  } finally {
    dispose()
    await h.root.fiber.dispose()
  }
})

test('执行边界：disposer 释放后 guard 与过滤同时撤销', async () => {
  const h = await ptcHarness()
  const dispose = mountAll(h.root, { deny: ['own_tool'] })
  await h.assemble(h.main)
  assert.equal((await h.runCode(h.main, 'own_tool')).isError, true)
  const filtered = await h.assemble(h.main)
  assert.equal(filtered.tools.some((item) => item.name === 'own_tool'), false)
  dispose()
  await h.assemble(h.main)
  const after = await h.runCode(h.main, 'own_tool')
  assert.equal(after.isError, false, '释放后不得继续拒绝')
  assert.deepEqual(h.bodyRuns, ['own_tool'])
  await h.root.fiber.dispose()
})
