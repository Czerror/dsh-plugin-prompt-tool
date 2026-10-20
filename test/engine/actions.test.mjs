/**
 * B3 T2 —— engine/actions.mjs（九类动作）与 engine/sdk-strip.mjs 的行为验收（主路径）。
 *
 * 覆盖：每类动作的注册通道与触发时机；inject-text / assembly / tool-gate / tool-result /
 * append-context / request-params / guard / sdk-strip / inbox-prepend /
 * pre-step-filter 的主路径副作用；真实 PTC 子调用拒绝；每轮预算与 when 门控。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { registerAction } from '../../engine/actions.mjs'
import { SDK_SECTION_NAME, sdkToolNames } from '../../engine/sdk-strip.mjs'
import { applyAgentRequestParams } from '../../engine/layers.mjs'
import { createPromptConfigs } from '../../engine/schema.mjs'

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

// ───────────────────────── 一、通道与降级语义声明 ─────────────────────────

test('动作只在其合法通道注册：逐类记录 ctx.on 的通道并与声明对拍', async () => {
  const cases = [
    ['inject-text pre-step', { kind: 'inject-text', id: 'i1', config: createPromptConfigs([{ id: 'i1', layer: 'pre-step', text: 'A' }])[0] }, ['agent/pre-step', 'session/event']],
    ['assembly', { kind: 'assembly', id: 'a1', target: { sections: { remove: ['x'] } } }, ['system-prompt/assemble']],
    ['tool-gate', { kind: 'tool-gate', id: 'd1', decision: 'deny', reason: 'no' }, ['tools/pre-execute']],
    ['tool-result', { kind: 'tool-result', id: 'd2', action: 'block', text: 'x' }, ['tools/post-execute']],
    ['append-context', { kind: 'append-context', id: 'c1', mode: 'context', text: 'x' }, ['tools/post-execute']],
    ['append-context continue', { kind: 'append-context', id: 'c2', mode: 'continue', text: 'x' }, ['agent/turn-stopping']],
    ['tool-visibility', { kind: 'tool-visibility', id: 'v1', deny: ['bash'] }, ['system-prompt/assemble']],
    ['request-params', { kind: 'request-params', id: 'r1', patch: { maxTokens: 64 } }, ['agent/request']],
    ['inbox-prepend', { kind: 'inbox-prepend', id: 'p1', text: 'ANCHOR' }, ['agent/inbox/inserted']],
    ['pre-step-filter', { kind: 'pre-step-filter', id: 'f1', sources: ['plugin'] }, ['agent/pre-step']],
  ]
  for (const [label, action, expected] of cases) {
    const { ctx, events } = recordingCtx({ systemPrompt: systemPromptStub([]) })
    registerAction(ctx, action)
    const actual = events.map((entry) => entry.event).sort()
    assert.deepEqual(actual, expected, `${label} 只应在 ${expected.join('/')} 注册`)
  }
})

test('动作声明 fail loud：名单形状错误、名单为空、名单命名 run_code 都在挂载期抛出', () => {
  const { ctx } = recordingCtx()
  assert.throws(() => registerAction(ctx, { kind: 'tool-visibility', id: 'v', deny: ['run_code'] }), /must not name the reserved run_code/)
  assert.throws(() => registerAction(ctx, { kind: 'tool-visibility', id: 'v' }), /needs allow and\/or deny/)
  assert.throws(() => registerAction(ctx, { kind: 'tool-visibility', id: 'v', deny: ['a'], audience: 'nobody' }), /audience must be main, subagent or all/)
  assert.throws(() => registerAction(ctx, { kind: 'tool-visibility', id: 'v', deny: ['a'], requireMatch: true }), /requireMatch only applies to allow/)
  assert.throws(() => registerAction(ctx, { kind: 'request-params', id: 'x', replace: true, unset: { maxTokens: 1 } }), /cannot combine replace with unset/)
  assert.throws(() => registerAction(ctx, { kind: 'tool-gate', id: 'x', decision: 'maybe' }), /must be one of allow, deny, ask/)
  assert.throws(() => registerAction(ctx, { kind: 'tool-result', id: 'x', action: 'explode' }), /must be one of accept, replace, block/)
  // 段/上下文增量的形状校验（含 label 与 plugin 一起拼出的消息）
  assert.throws(() => registerAction(ctx, { kind: 'assembly', id: 'x', target: { sections: { add: [{ name: 1, text: 'a' }] } } }), /assembly\.sections\.add\[\]\.name must be a string/)
  assert.throws(() => registerAction(ctx, { kind: 'assembly', id: 'x', target: { contexts: { add: {} } } }), /assembly\.contexts\.add must be an array/)
  // clear 与 add/remove 并存不可解释（旧实现静默丢弃 add/remove），非布尔 clear 也静默失效：
  // 两者都在挂载期拒绝，与 sections 的 keep+remove 同一纪律。形状校验先于互斥判定。
  for (const target of [
    { contexts: { clear: true, add: [{ name: 'a', text: 't' }] } },
    { contexts: { clear: true, remove: ['a'] } },
  ]) assert.throws(() => registerAction(ctx, { kind: 'assembly', id: 'x', target }), /assembly\.contexts\.clear cannot combine with add or remove/)
  assert.throws(() => registerAction(ctx, { kind: 'assembly', id: 'x', target: { contexts: { clear: true, add: {} } } }), /assembly\.contexts\.add must be an array/)
  assert.throws(() => registerAction(ctx, { kind: 'assembly', id: 'x', target: { contexts: { clear: 'true' } } }), /assembly\.contexts\.clear must be boolean/)
  // sections 同纪律（前缀也不再用 `assembly target.sections`）：互斥判定排在形状校验之后，
  // 所以 `add: {}` / `add: null` 报形状错而不是互斥错。
  assert.throws(() => registerAction(ctx, { kind: 'assembly', id: 'x', target: { sections: { keep: ['a'], remove: ['b'] } } }), /assembly\.sections cannot combine keep with remove/)
  assert.throws(() => registerAction(ctx, { kind: 'assembly', id: 'x', target: { sections: { keep: ['a'], remove: ['b'], add: {} } } }), /assembly\.sections\.add must be an array/)
  assert.throws(() => registerAction(ctx, { kind: 'assembly', id: 'x', target: { sections: { keep: ['a'], remove: ['b'], add: null } } }), /assembly\.sections\.add must be an array/)
  assert.throws(() => registerAction(ctx, { kind: 'append-context', id: 'x', mode: 'context', text: 5 }), /x\.text must be a string/)
  assert.throws(() => registerAction(ctx, { kind: 'inject-text', id: 'x', config: { layer: '' } }), /config\.layer is required/)
  assert.throws(() => registerAction(ctx, { kind: 'inject-text', id: 'x' }), /requires a config object/)
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
  registerAction(boom.ctx, { kind: 'assembly', id: 'boom', target: { sections: { remove: ['x'] } } })
  const broken = assembled([{ name: 'x' }])
  const survived = await only(boom.events, 'system-prompt/assemble')(broken, { agent: agent() }, async () => { throw new Error('downstream') }).catch(() => 'threw')
  assert.equal(survived, 'threw', '下游异常必须原样上抛，动作不得吞掉')

  const failing = recordingCtx()
  registerAction(failing.ctx, { kind: 'assembly', id: 'f', target: { sections: { remove: ['x'] } } })
  const hostile = { get sections() { throw new Error('assembly hook exploded') }, tools: [], contexts: [], variables: {} }
  const kept = await only(failing.events, 'system-prompt/assemble')(hostile, { agent: agent() }, async () => hostile)
  assert.equal(kept, hostile, '装配改写失败时返回未改装配（expose-all）')
  assert.equal(failing.warnings.length, 1)
})

test('(2f) contexts：clear 单独清空；跨动作拆分的 [clear, add] 仍是 after-next 串接', async () => {
  const clear = recordingCtx()
  registerAction(clear.ctx, { kind: 'assembly', id: 'clear', target: { contexts: { clear: true } } })
  const input = assembled([], { contexts: [{ name: 'old', text: 'O' }] })
  const cleared = await only(clear.events, 'system-prompt/assemble')(input, { agent: agent() }, async () => input)
  assert.deepEqual(cleared.contexts, [], 'clear 单独声明时清空 contexts')
  // 跨动作不是单动作内的 replace 语义：后续动作的 add 接在 clear 之后（after-next 顺序）。
  const add = recordingCtx()
  registerAction(add.ctx, { kind: 'assembly', id: 'add', target: { contexts: { add: [{ name: 'new', text: 'N' }] } } })
  const added = await only(add.events, 'system-prompt/assemble')(cleared, { agent: agent() }, async () => cleared)
  assert.deepEqual(added.contexts.map((entry) => entry.name), ['new'])
})

test('(3) 工具裁决：deny / ask / allow 三档返回各自的裁决对象', async () => {
  const action = (payload) => {
    const recorder = recordingCtx()
    registerAction(recorder.ctx, { kind: 'tool-gate', id: 'tp', ...payload })
    return only(recorder.events, 'tools/pre-execute')
  }
  const exec = { name: 'bash', agent: agent(), arguments: { command: 'ls' } }
  const cases = [
    [{ decision: 'deny', reason: 'R' }, { kind: 'deny', reason: 'R' }],
    [{ decision: 'ask' }, { kind: 'ask' }],
    // allow 不是终局：原样放行下游，结果由下游给出。
    [{ decision: 'allow' }, 'PASS'],
  ]
  for (const [payload, expected] of cases) {
    assert.deepEqual(await action(payload)(exec, async () => 'PASS'), expected, `pre ${JSON.stringify(payload)}`)
  }
})

test('(3b) 工具结果：replace / block 产出，accept 与空正文放行下游', async () => {
  const run = (payload) => {
    const recorder = recordingCtx()
    registerAction(recorder.ctx, { kind: 'tool-result', id: 'r', ...payload })
    return only(recorder.events, 'tools/post-execute')
  }
  const exec = { name: 'bash', agent: agent() }
  const base = { kind: 'accept', content: [{ type: 'text', text: 'REAL' }] }
  const next = async () => base

  assert.deepEqual(await run({ action: 'replace', text: 'REPLACED' })(exec, base, next),
    { kind: 'accept', content: [{ type: 'text', text: 'REPLACED' }] }, 'replace 用正文替换结果')
  assert.deepEqual(await run({ action: 'block', text: 'STOP' })(exec, base, next),
    { kind: 'block', feedback: [{ type: 'text', text: 'STOP' }] }, 'block 返回反馈')
  assert.equal(await run({ action: 'accept' })(exec, base, next), base, 'accept 放行下游结果')
  assert.equal(await run({ action: 'replace', text: '' })(exec, base, next), base, '空正文不替换')
  assert.equal(await run({ action: 'block' })(exec, base, next).then((value) => value.feedback[0].text),
    'r: blocked by action', 'block 缺正文回退引擎缺省原因')
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
  // 带 Agent 的 run_code 会向 workingDirectory 服务要目录（dsh-tools 0.2.1-alpha.2 起强制，
  // 见其 requireWorkingDirectory）；真实部署由 @deepseek-ai/dsh-working-directory 提供，
  // 这里给最小替身，避免为了一个服务把新包引进 devDependencies。
  root.provide('workingDirectory', { ensure: async () => process.cwd() })
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

test('(5) 真实 PTC：工具可见面同时裁 SDK 正文与执行面，子调用建不出绑定', async () => {
  const h = await ptcHarness({ language: 'typescript' })
  const before = await h.assemble(h.main)
  const sdkBefore = before.sections.find((section) => section.name === SDK_SECTION_NAME)
  assert.ok(sdkBefore, 'PTC 下必须存在 tools:sdk 段')
  assert.deepEqual(sdkToolNames(sdkBefore.text).sort(), ['bash', 'own_tool', 'read'])

  const dispose = registerAction(h.root, { kind: 'tool-visibility', id: 'v', deny: ['own_tool'] })
  const after = await h.assemble(h.main)
  const sdkAfter = after.sections.find((section) => section.name === SDK_SECTION_NAME)
  assert.deepEqual(sdkToolNames(sdkAfter.text).sort(), ['bash', 'read'], '被剔工具的 SDK 声明必须从正文消失')
  assert.ok(!sdkAfter.text.includes('own_tool'), '正文里不得残留被剔工具的声明')
  assert.equal(sdkBefore.text.includes('own_tool'), true, '裁剪前正文确实带着被剔工具')

  // 呈现裁剪不是执行边界：即便模型"知道"旧名字，子调用仍被 guard 拦下
  const denied = await h.runCode(h.main, 'own_tool')
  assert.equal(denied.isError, true)
  assert.match(denied.content[0].text, /denied by tool-visibility/)
  assert.deepEqual(h.bodyRuns, [])
  const allowed = await h.runCode(h.main, 'read')
  assert.equal(allowed.isError, false)
  assert.deepEqual(h.bodyRuns, ['read'])
  dispose()
  await h.root.fiber.dispose()
})

test('(6) 真实 PTC（Python）：工具可见面裁剪保留异名注释，只删被剔工具及其 TypedDict', async () => {
  const h = await ptcHarness({ language: 'python' })
  h.tools.register({
    name: 'my-tool',
    description: 'Exotic tool',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: {
        type: 'object',
        properties: { inner: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] } },
        required: ['inner'],
      },
      render: () => [{ type: 'text', text: 'ok' }],
    },
    execute: async () => ({ inner: { x: 'ok' } }),
  })
  const before = await h.assemble(h.main)
  const sdkBefore = before.sections.find(section => section.name === SDK_SECTION_NAME)
  assert.ok(sdkBefore, 'PTC 下必须存在 tools:sdk 段')
  assert.deepEqual(sdkToolNames(sdkBefore.text).sort(), ['bash', 'my-tool', 'own_tool', 'read'])

  const dispose = registerAction(h.root, { kind: 'tool-visibility', id: 'py', deny: ['own_tool'] })
  const after = await h.assemble(h.main)
  const sdkAfter = after.sections.find(section => section.name === SDK_SECTION_NAME)
  assert.deepEqual(sdkToolNames(sdkAfter.text).sort(), ['bash', 'my-tool', 'read'], '被剔工具的协议成员必须消失')
  assert.ok(sdkAfter.text.includes('# tools["my-tool"]'), '异名工具的下标注释必须保留')
  assert.ok(!sdkAfter.text.includes('OwnTool') && !sdkAfter.text.includes('own_tool'), '被剔工具及其 TypedDict 必须消失')
  dispose()
  await h.root.fiber.dispose()
})


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
    kind: 'tool-gate', id: 'gate', decision: 'deny', reason: 'go deeper', maxPerTurn: 2,
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
  registerAction(anon.ctx, { kind: 'tool-gate', id: 'g2', decision: 'deny', reason: 'r', maxPerTurn: 1 })
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
  registerAction(recorder.ctx, { kind: 'inbox-prepend', id: 'anchor', text: 'ANCHOR' }, { if: () => true })
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