/**
 * B3 T2 —— engine/actions.mjs（九类动作）与 engine/sdk-strip.mjs 的行为验收（主路径）。
 *
 * 覆盖：每类动作的注册通道与触发时机；inject-text / assembly / decision /
 * append-context / request-params / guard / sdk-strip / inbox-prepend /
 * pre-step-filter 的主路径副作用；真实 PTC 子调用拒绝；每轮预算与 when 门控。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { ACTION_KINDS, registerAction } from '../../engine/actions.mjs'
import { SDK_SECTION_NAME, sdkToolNames } from '../../engine/sdk-strip.mjs'
import { applyAgentRequestParams, wireLayers } from '../../engine/layers.mjs'
import { createPromptConfigs } from '../../engine/prompt-config-engine.mjs'
import { compileDeclarations, mountDeclarations } from '../../engine/trigger-spec.mjs'

/** 记录型 ctx 桩：记录 ctx.on 的通道、注册的服务调用与 effect 释放。 */
function recordingCtx(services = {}) {
  const events = []
  const calls = []
  const effects = []
  const warnings = []
  const ctx = {
    logger: { warn: (message) => warnings.push(String(message)) },
    on(event, handler, options) {
      events.push({ event, handler, options })
      return () => events.splice(events.indexOf(entryOf(event, handler)), 1)
    },
    effect(callback, label) {
      calls.push({ service: 'effect', label })
      const disposer = callback()
      if (typeof disposer === 'function') effects.push(disposer)
      return disposer
    },
    get: (name) => services[name],
    ...services.ctx,
  }
  function entryOf(event, handler) {
    return events.find((entry) => entry.event === event && entry.handler === handler) ?? {}
  }
  return { ctx, events, calls, effects, warnings }
}

/** systemPrompt 服务桩：记录 section / context / variable 注册。 */
function systemPromptStub(calls) {
  return {
    section: (entry) => { calls.push({ service: 'section', entry }); return () => {} },
    context: (entry) => { calls.push({ service: 'context', entry }); return () => {} },
    variable: (name, read) => { calls.push({ service: 'variable', name, read }); return () => {} },
    suppressRuntimeContext: () => () => {},
  }
}

const only = (events, name) => {
  const found = events.filter((entry) => entry.event === name)
  assert.equal(found.length, 1, `应恰好注册一个 ${name} 监听器，实际 ${found.length}`)
  return found[0].handler
}

const session = (depth = 0, id = `s${depth}-${Math.random()}`) => ({ id, header: { delegationDepth: depth } })
const agent = (depth = 0, extra = {}) => ({ session: session(depth), options: { model: 'deepseek-chat' }, ...extra })
const assembled = (tools, extra = {}) => ({ sections: [], contexts: [], tools, variables: {}, ...extra })
const tool = (toolName) => ({ name: toolName, description: `tool ${toolName}`, parameters: { type: 'object', properties: {} } })

// ───────────────────────── 一、通道与降级语义声明 ─────────────────────────

test('动作只在其合法通道注册：逐类记录 ctx.on 的通道并与声明对拍', async () => {
  const cases = [
    ['inject-text pre-step', { kind: 'inject-text', id: 'i1', config: createPromptConfigs([{ id: 'i1', layer: 'pre-step', text: 'A' }])[0] }, ['agent/pre-step', 'session/event']],
    ['assembly', { kind: 'assembly', id: 'a1', target: { tools: { deny: ['bash'] } } }, ['system-prompt/assemble']],
    ['decision pre', { kind: 'decision', id: 'd1', phase: 'pre', decision: 'deny', reason: 'no' }, ['tools/pre-execute']],
    ['decision post', { kind: 'decision', id: 'd2', phase: 'post', action: 'block', text: 'x' }, ['tools/post-execute']],
    ['append-context', { kind: 'append-context', id: 'c1', mode: 'context', text: 'x' }, ['tools/post-execute']],
    ['append-context continue', { kind: 'append-context', id: 'c2', mode: 'continue', text: 'x' }, ['agent/turn-stopping']],
    ['guard', { kind: 'guard', id: 'g1', mask: { deny: ['bash'] } }, ['system-prompt/assemble']],
    ['sdk-strip', { kind: 'sdk-strip', id: 's1', mask: { deny: ['bash'] } }, ['system-prompt/assemble']],
    ['request-params', { kind: 'request-params', id: 'r1', patch: { maxTokens: 64 } }, ['agent/request']],
    ['inbox-prepend', { kind: 'inbox-prepend', id: 'p1', text: 'ANCHOR' }, ['agent/inbox/inserted']],
    ['pre-step-filter', { kind: 'pre-step-filter', id: 'f1', sources: ['plugin'] }, ['agent/pre-step']],
  ]
  for (const [label, action, expected] of cases) {
    const { ctx, events } = recordingCtx({ systemPrompt: systemPromptStub([]) })
    registerAction(ctx, action)
    const actual = events.map((entry) => entry.event).sort()
    assert.deepEqual(actual, expected, `${label} 只应在 ${expected.join('/')} 注册`)
    for (const event of actual) assert.ok(ACTION_KINDS[action.kind].events.includes(event), `${label} 注册了声明外的事件`)
  }
})

test('动作声明 fail loud：名单形状错误、名单为空、名单命名 run_code 都在挂载期抛出', () => {
  const { ctx } = recordingCtx()
  assert.throws(() => registerAction(ctx, { kind: 'assembly', id: 'x', target: { tools: { deny: 'bash' } } }), /deny must be an array/)
  assert.throws(() => registerAction(ctx, { kind: 'assembly', id: 'x', target: { tools: {} } }), /needs allow and\/or deny/)
  assert.throws(() => registerAction(ctx, { kind: 'guard', id: 'x', mask: { deny: ['run_code'] } }), /must not name the reserved run_code/)
  assert.throws(() => registerAction(ctx, { kind: 'request-params', id: 'x', replace: true, unset: { maxTokens: 1 } }), /cannot combine replace with unset/)
  assert.throws(() => registerAction(ctx, { kind: 'decision', id: 'x', phase: 'pre', decision: 'maybe' }), /must be one of allow, deny, ask/)
  // 段/上下文增量的形状校验（含 label 与 plugin 一起拼出的消息）
  assert.throws(() => registerAction(ctx, { kind: 'assembly', id: 'x', target: { sections: { add: [{ name: 1, text: 'a' }] } } }), /assembly\.sections\.add\[\]\.name must be a string/)
  assert.throws(() => registerAction(ctx, { kind: 'assembly', id: 'x', target: { contexts: { add: {} } } }), /assembly\.contexts\.add must be an array/)
  assert.throws(() => registerAction(ctx, { kind: 'append-context', id: 'x', mode: 'context', text: 5 }), /x\.text must be a string/)
  assert.throws(() => registerAction(ctx, { kind: 'inject-text', id: 'x', config: { layer: '' } }), /config\.layer is required/)
  assert.throws(() => registerAction(ctx, { kind: 'inject-text', id: 'x' }), /requires a config object/)
})

// ───────────────────────── 二、与既有实现逐条对拍 ─────────────────────────

test('(1) 纯数据声明：编译、挂载后实际注入正文，并遵守条件、受众与批次去重', async () => {
  const recorder = recordingCtx()
  const declaration = {
    id: 'declared-text', channel: 'agent/pre-step',
    do: { kind: 'inject-text', config: {
      id: 'notice', layer: 'pre-step', text: 'HELLO {{who}}', variables: { who: 'WORLD' },
      audience: 'main', dedupe: 'batch', match: { keys: ['RUN'] },
    } },
  }
  const dispose = mountDeclarations(recorder.ctx, compileDeclarations([declaration]))
  const handler = only(recorder.events, 'agent/pre-step')
  const run = async (text, depth = 0) => {
    const user = { id: 'u', role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
    return handler({ agent: agent(depth), messages: [user] }, () => ({ kind: 'enter', messages: [user] }))
  }
  assert.equal((await run('SKIP')).messages.length, 1)
  assert.equal((await run('RUN', 1)).messages.length, 1)
  const result = await run('RUN')
  assert.equal(result.messages.length, 2)
  assert.equal(result.messages[1].content[0].text, 'HELLO WORLD')
  const repeated = await handler({ agent: agent(), messages: result.messages }, () => result)
  assert.equal(repeated.messages.length, 2, '已含本配置的批次不重复注入')
  assert.deepEqual(recorder.warnings, [])
  assert.equal(Object.hasOwn(declaration.do.config, 'resolve'), false, '编译不得把运行时函数写回声明')
  dispose()
  assert.deepEqual(recorder.events, [])
})

test('(2) 改装配 tools：名单裁剪（deny / allow / 空名单）', async () => {
  // B7 T3：原 `tool-filter` 模块已删除，本用例不再与它逐条对拍；期望值是按名单语义
  // 逐条算出的字面量 —— `createMask` 的剔出判据是「先看 deny、再看 allow 是否点名」
  // （actions.mjs:191-192）。
  const cases = [
    [{ deny: ['web_search'] }, ['bash', 'read']],
    [{ allow: ['bash', 'read'] }, ['bash', 'read']],
  ]
  for (const [mask, expected] of cases) {
    const catalog = ['bash', 'read', 'web_search'].map(tool)
    const viaAction = recordingCtx()
    registerAction(viaAction.ctx, { kind: 'assembly', id: 'm', target: { tools: mask } })
    const actual = await only(viaAction.events, 'system-prompt/assemble')(assembled(catalog.map((item) => ({ ...item }))), { agent: agent() }, async () => assembled(catalog.map((item) => ({ ...item }))))
    assert.deepEqual(actual.tools.map((item) => item.name), expected, `mask ${JSON.stringify(mask)}`)
  }
  const empty = recordingCtx()
  registerAction(empty.ctx, { kind: 'assembly', id: 'm2', target: { tools: { deny: [] } } })
  const input = assembled([tool('bash')])
  const output = await only(empty.events, 'system-prompt/assemble')(input, { agent: agent() }, async () => input)
  assert.deepEqual(output.tools.map((item) => item.name), ['bash'], '空 deny = 不过滤')

  const emptyAllow = recordingCtx()
  registerAction(emptyAllow.ctx, { kind: 'assembly', id: 'm3', target: { tools: { allow: [] } } })
  const none = await only(emptyAllow.events, 'system-prompt/assemble')(input, { agent: agent() }, async () => input)
  assert.deepEqual(none.tools.map((item) => item.name), [], '显式空 allow = 一个都不通过')
})

test('(2) 改装配 sections/contexts：增删改与既有形态一致，异常时返回未改装配', async () => {
  const { ctx, events } = recordingCtx()
  registerAction(ctx, {
    kind: 'assembly',
    id: 'sec',
    target: {
      sections: { add: [{ name: 'stage-status', text: 'S' }], remove: ['tools:sdk'] },
      contexts: { add: [{ name: 'extra', text: 'E' }], remove: ['drop-me'] },
    },
  })
  const input = assembled([], {
    sections: [{ name: 'tools:sdk', text: 'sdk' }, { name: 'keep', text: 'k' }],
    contexts: [{ name: 'drop-me', text: 'x' }, { name: 'keep', text: 'y' }],
  })
  const output = await only(events, 'system-prompt/assemble')(input, { agent: agent() }, async () => input)
  assert.deepEqual(output.sections.map((item) => item.name), ['keep', 'stage-status'])
  assert.deepEqual(output.contexts.map((item) => item.name), ['keep', 'extra'])
  assert.deepEqual(input.sections.map((item) => item.name), ['tools:sdk', 'keep'], '输入不得被就地修改')

  const boom = recordingCtx()
  registerAction(boom.ctx, { kind: 'assembly', id: 'boom', target: { tools: { deny: ['x'] } } })
  const broken = assembled([{ name: 'x' }])
  const survived = await only(boom.events, 'system-prompt/assemble')(broken, { agent: agent() }, async () => { throw new Error('downstream') }).catch(() => 'threw')
  assert.equal(survived, 'threw', '下游异常必须原样上抛，动作不得吞掉')

  const failing = recordingCtx()
  registerAction(failing.ctx, { kind: 'assembly', id: 'f', target: { tools: { deny: ['x'] } } })
  const hostile = { get tools() { throw new Error('assembly hook exploded') }, sections: [], contexts: [], variables: {} }
  const kept = await only(failing.events, 'system-prompt/assemble')(hostile, { agent: agent() }, async () => hostile)
  assert.equal(kept, hostile, '装配改写失败时返回未改装配（expose-all）')
  assert.equal(failing.warnings.length, 1)
})

test('(3) 裁决：pre-execute 与 tool-pipeline 层逐条同结果（allow/deny/ask）', async () => {
  const build = (params, text = '') => {
    const [config] = createPromptConfigs([{ id: 'tp', layer: 'tool-pipeline', text, params }])
    const recorder = recordingCtx()
    wireLayers(recorder.ctx, [config], () => {})
    return only(recorder.events, 'tools/pre-execute')
  }
  const action = (payload) => {
    const recorder = recordingCtx()
    registerAction(recorder.ctx, { kind: 'decision', id: 'tp', phase: 'pre', ...payload })
    return only(recorder.events, 'tools/pre-execute')
  }
  const exec = { name: 'bash', agent: agent(), arguments: { command: 'ls' } }
  const cases = [
    [{ toolNames: 'bash', preDecision: 'deny', denyReason: 'R' }, { toolNames: 'bash', decision: 'deny', reason: 'R' }],
    [{ toolNames: 'bash', preDecision: 'ask' }, { toolNames: 'bash', decision: 'ask' }],
    [{ toolNames: 'bash', preDecision: 'allow' }, { toolNames: 'bash', decision: 'allow' }],
    [{ toolNames: 'read', preDecision: 'deny', denyReason: 'R' }, { toolNames: 'read', decision: 'deny', reason: 'R' }],
  ]
  for (const [params, payload] of cases) {
    const expected = await build(params)(exec, async () => 'PASS')
    const actual = await action(payload)(exec, async () => 'PASS')
    assert.deepEqual(actual, expected, `pre ${JSON.stringify(params)}`)
  }
})

test('(4) 追加上下文：additionalContexts 形状（user 角色、plugin 来源）且只在 accept 裁决上追加', async () => {
  // B7 T3：原 `progress-reminder` 模块已删除，本用例不再与它逐条对拍；期望值改为字面量。
  const exec = { name: 'bash', agent: agent(), arguments: {} }
  const decision = { kind: 'accept', content: [{ type: 'text', text: 'OUT' }] }
  const viaAction = recordingCtx()
  registerAction(viaAction.ctx, { kind: 'append-context', id: 'beat', mode: 'context', text: 'BEAT' })
  const actual = await only(viaAction.events, 'tools/post-execute')(exec, decision, async () => ({ ...decision }))
  assert.equal(actual.additionalContexts.length, 1)
  assert.deepEqual(actual.additionalContexts[0].content, [{ type: 'text', text: 'BEAT' }])
  assert.equal(actual.additionalContexts[0].role, 'user')
  assert.equal(actual.additionalContexts[0].source.kind, 'plugin:beat')
  assert.equal(actual.additionalContexts[0].source.plugin, 'beat')
  // 非 accept 裁决不追加（原模块同样只在 accept 上追加）
  const denied = await only(viaAction.events, 'tools/post-execute')(exec, decision, async () => ({ kind: 'block', feedback: [] }))
  assert.deepEqual(denied, { kind: 'block', feedback: [] })
})

test('(4) 续跑：steer 一次/轮、总量受引擎预算约束，且与 turn-stop 的计数纪律一致', async () => {
  const steered = []
  const target = { session: session(0), options: { model: 'deepseek-chat' }, steer: (message) => steered.push(message) }
  const recorder = recordingCtx()
  registerAction(recorder.ctx, { kind: 'append-context', id: 'go', mode: 'continue', text: 'GO' })
  const handler = only(recorder.events, 'agent/turn-stopping')
  for (let index = 0; index < 5; index += 1) handler({ agent: target, turn: 1 })
  for (let turn = 2; turn <= 5; turn += 1) handler({ agent: target, turn })
  assert.equal(steered.length, 3, '每会话上限 3 次（引擎常量，不可配置）')
  assert.deepEqual(steered[0].content, [{ type: 'text', text: 'GO' }])
  assert.equal(steered[0].role, 'user')
  assert.equal(steered[0].source.plugin, 'go')
})

test('(7) 按值条件删键：值相等才删、值不等保留、缺失键不动，且不得删别的插件设置的同名值', () => {
  const injected = 2048
  // 相等 → 删除（bootstrapMaxTokens 的剥离语义）
  assert.deepEqual(applyAgentRequestParams({ unset: { maxTokens: injected } }, { model: 'chat', maxTokens: injected }), { model: 'chat' })
  // 不等 → 保留（模型或其它插件设置的值）
  assert.deepEqual(applyAgentRequestParams({ unset: { maxTokens: injected } }, { model: 'chat', maxTokens: 4096 }), { model: 'chat', maxTokens: 4096 })
  // 缺失 → 不动，且不产生键
  const missing = applyAgentRequestParams({ unset: { maxTokens: injected } }, { model: 'chat' })
  assert.deepEqual(missing, { model: 'chat' })
  assert.equal(Object.hasOwn(missing, 'maxTokens'), false)
  // patch 与 unset 组合：合并结果的值等于声明值时才删
  assert.deepEqual(
    applyAgentRequestParams({ patch: { maxTokens: injected }, unset: { maxTokens: injected } }, { model: 'chat', maxTokens: 4096 }),
    { model: 'chat' },
  )
  assert.deepEqual(
    applyAgentRequestParams({ patch: { maxTokens: injected }, unset: { maxTokens: 100 } }, { model: 'chat' }),
    { model: 'chat', maxTokens: injected },
  )
  // 多键：只删命中的那个
  assert.deepEqual(
    applyAgentRequestParams({ unset: { maxTokens: injected, temperature: 0.5 } }, { model: 'chat', maxTokens: injected, temperature: 0.7 }),
    { model: 'chat', temperature: 0.7 },
  )
  // 无 unset 时零额外分配（同一形状）
  assert.deepEqual(applyAgentRequestParams({ patch: { temperature: 0.1 } }, { model: 'chat' }), { model: 'chat', temperature: 0.1 })
})

// ───────────────────────── 三、第 (5)(6) 类：真实 PTC 子调用拒绝 ─────────────────────────

/** 真实 SystemPrompt + ToolRuntime 的 PTC 环境；只替换语言运行时（不替换工具管线）。 */
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
    // agent 本层工具：`restrict` 只收继承面、收不动它，因此它是执行 guard 的**唯一兜底面**
    // —— 只有它能在 `run_code` 里真正建出绑定并走到子调用裁决（PLAN 要求的"真实 PTC 拒绝"）。
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

test('(5) 真实 PTC 子调用：guard 拦下本层工具（restrict 收不动）的调用，工具体一次都没执行（TS 载荷）', async () => {
  const h = await ptcHarness({ language: 'typescript' })
  // 注册在真实 root ctx 上：动作的 assembly 监听由真实 waterfall 触发（含首个请求）。
  const dispose = registerAction(h.root, { kind: 'guard', id: 'no-own', mask: { deny: ['own_tool'] }, reason: 'blocked by guard action' })
  await h.assemble(h.main)
  // agent 本层工具仍在 `registry.schemas(agent)` 里 → `run_code` 真的建出绑定 → 子调用真的发生
  assert.ok(h.tools.schemas(h.main).some((schema) => schema.name === 'own_tool'), '绑定必须存在，否则测的不是 guard')
  const result = await h.runCode(h.main, 'own_tool')
  assert.equal(result.isError, true, '被剔工具的 PTC 子调用必须失败')
  assert.match(result.content[0].text, /blocked by guard action/)
  assert.deepEqual(h.bodyRuns, [], '工具体不得执行')
  // 名单外的工具仍可正常调用
  const allowed = await h.runCode(h.main, 'read')
  assert.equal(allowed.isError, false)
  assert.deepEqual(h.bodyRuns, ['read'])
  dispose()
  await h.root.fiber.dispose()
})

test('(6) 真实 PTC：SDK 正文里被剔工具的声明消失，且 guard 让「知道旧名字」也调不动', async () => {
  const h = await ptcHarness({ language: 'typescript' })
  const before = await h.assemble(h.main)
  const sdkBefore = before.sections.find((section) => section.name === SDK_SECTION_NAME)
  assert.ok(sdkBefore, 'PTC 下必须存在 tools:sdk 段')
  assert.deepEqual(sdkToolNames(sdkBefore.text).sort(), ['bash', 'own_tool', 'read'])

  // 两个动作都注册在真实 root ctx：由真实 assembly 瀑布触发。
  const disposeStrip = registerAction(h.root, { kind: 'sdk-strip', id: 's', mask: { deny: ['own_tool'] } })
  const disposeGuard = registerAction(h.root, { kind: 'guard', id: 'g', mask: { deny: ['own_tool'] }, reason: 'no own tool' })

  const after = await h.assemble(h.main)
  const sdkAfter = after.sections.find((section) => section.name === SDK_SECTION_NAME)
  assert.deepEqual(sdkToolNames(sdkAfter.text).sort(), ['bash', 'read'], '被剔工具的 SDK 声明必须从正文消失')
  assert.ok(!sdkAfter.text.includes('own_tool'), '正文里不得残留被剔工具的声明')
  assert.ok(sdkAfter.text.includes('bash'), '其它工具声明必须保留')
  assert.equal(sdkBefore.text.includes('own_tool'), true, '裁剪前正文确实带着被剔工具')

  // 文本裁剪不是执行边界：即便模型"知道"旧名字，子调用仍被 guard 拦下
  const denied = await h.runCode(h.main, 'own_tool')
  assert.equal(denied.isError, true)
  assert.match(denied.content[0].text, /no own tool/)
  assert.deepEqual(h.bodyRuns, [])
  disposeStrip()
  disposeGuard()
  await h.root.fiber.dispose()
})

// ───────────────────────── 四、when 门控与每轮预算 ─────────────────────────

test('when：命中才执行动作，不命中放行下游', async () => {
  const recorder = recordingCtx()
  let evaluated = 0
  registerAction(recorder.ctx, { kind: 'request-params', id: 'r', patch: { maxTokens: 8 } },
    { when: () => { evaluated += 1; return true } })
  const handler = only(recorder.events, 'agent/request')
  const base = { provider: 'deepseek', model: 'chat' }
  assert.deepEqual(await handler({ agent: agent() }, async () => base), { ...base, maxTokens: 8 }, '命中即改写')
  assert.equal(evaluated, 1)

  const off = recordingCtx()
  registerAction(off.ctx, { kind: 'request-params', id: 'r', patch: { maxTokens: 8 } }, { when: () => false })
  const offHandler = only(off.events, 'agent/request')
  assert.deepEqual(await offHandler({ agent: agent() }, async () => base), base, '不命中必须原样放行')
})

test('每轮预算：maxPerTurn 命中后同步消耗，轮边界重置，无会话不设限', async () => {
  const recorder = recordingCtx()
  const session = { id: 's-budget', header: {}, snapshotEvents: () => [] }
  const agent = { session }
  registerAction(recorder.ctx, {
    kind: 'decision', id: 'gate', phase: 'pre', decision: 'deny', reason: 'go deeper', maxPerTurn: 2,
  })
  const handler = only(recorder.events, 'tools/pre-execute')
  const exec = () => ({ name: 'bash', agent })

  assert.deepEqual(await handler(exec(), () => undefined), { kind: 'deny', reason: 'go deeper' }, '第 1 次生效')
  assert.deepEqual(await handler(exec(), () => undefined), { kind: 'deny', reason: 'go deeper' }, '第 2 次生效')
  assert.equal(await handler(exec(), () => 'next'), 'next', '第 3 次超出预算 → 等同不命中，放行下游')

  // 轮边界来自 durable 事件（与 predicates 的 trackTurn 同规则），所以重启后计数虽从 0 开始、
  // 轮边界却是立刻正确的——这正是它不能用 count 的冷扫模型表达的原因。
  const observer = recorder.events.find((item) => item.event === 'session/event')?.handler
  assert.ok(observer, '带预算的动作必须接 session/event 以跟踪轮边界')
  observer(session, { type: 'turn/start', data: { turn: 2 } })
  assert.deepEqual(await handler(exec(), () => undefined), { kind: 'deny', reason: 'go deeper' }, '新轮预算重置')

  // 无会话不设限：与原模块「取不到会话条目即放行」的降级一致。
  const anon = recordingCtx()
  registerAction(anon.ctx, { kind: 'decision', id: 'g2', phase: 'pre', decision: 'deny', reason: 'r', maxPerTurn: 1 })
  const anonHandler = only(anon.events, 'tools/pre-execute')
  for (let i = 0; i < 3; i += 1) {
    assert.deepEqual(await anonHandler({ name: 'bash' }, () => undefined), { kind: 'deny', reason: 'r' }, `无会话第 ${i + 1} 次仍生效`)
  }
})

// ───────────────────────── 五、第 (8)(9) 类：收件箱前置与 pre-step 过滤 ─────────────────────────

test('(8) 前置收件箱消息：命中即插到真实消息之前，插件来源不再前置，缺服务静默跳过', () => {
  const recorder = recordingCtx()
  const prepended = []
  const agent = { session: { id: 's-1' }, inbox: { prepend: (target, message) => prepended.push({ target, message }) } }
  registerAction(recorder.ctx, { kind: 'inbox-prepend', id: 'anchor', text: 'ANCHOR' }, { when: () => true })
  const handler = only(recorder.events, 'agent/inbox/inserted')

  handler({ agent, message: { id: 'real', role: 'user' } })
  assert.equal(prepended.length, 1, '命中即前置')
  assert.equal(prepended[0].target, 'next-turn', '缺省插到下一轮队列')
  assert.equal(prepended[0].message.content[0].text, 'ANCHOR')
  assert.equal(prepended[0].message.role, 'user', '绝不伪造 assistant 角色')
  assert.equal(prepended[0].message.source.kind, 'plugin:anchor', '来源标记为生产者身份，供防自触发')

  // 防自触发：插件来源消息（含本动作自己插入的那条）永不再次前置，否则一条消息引出无限插队。
  // 两种形态都要拦：v4 新写入用 `plugin:<name>`，旧日志才是裸 `plugin`。
  handler({ agent, message: { source: { kind: 'plugin:anchor' } } })
  assert.equal(prepended.length, 1, '插件来源消息不得再次触发前置')
  handler({ agent, message: { source: { kind: 'plugin' } } })
  assert.equal(prepended.length, 1, '旧形态的插件来源同样不得再次触发前置')

  // 缺 inbox 服务（最小组合 / 测试桩）：静默跳过，不抛。
  assert.doesNotThrow(() => handler({ agent: { session: { id: 'x' } }, message: {} }))
  assert.equal(prepended.length, 1)
})

test('(9) pre-step 过滤：sources 严格白名单只放行声明的 source.kind（含 claimed 批）', async () => {
  const recorder = recordingCtx()
  registerAction(recorder.ctx, { kind: 'pre-step-filter', id: 'phase1', sources: ['plugin'] })
  const handler = only(recorder.events, 'agent/pre-step')
  const decide = (messages) => async () => ({ kind: 'send', messages })

  const filtered = await handler({ agent: agent(), messages: [] },
    decide([{ id: 'a', source: { kind: 'plugin' } }, { id: 'b', source: { kind: 'user' } }, { id: 'c', source: { kind: 'plugin' } }]))
  assert.deepEqual(filtered.messages.map((m) => m.id), ['a', 'c'], '只留白名单内的 kind')

  // 全留时返回**同一对象**（不制造无谓的新决策）。
  const same = { kind: 'send', messages: [{ id: 'x', source: { kind: 'plugin' } }] }
  assert.equal(await handler({ agent: agent(), messages: [] }, async () => same), same)
})
