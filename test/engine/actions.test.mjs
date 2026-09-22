/**
 * B3 T2 —— engine/actions.mjs（七类动作）与 engine/sdk-strip.mjs 的行为验收。
 *
 * 覆盖：
 *   1. 每类动作的注册通道（断言动作只在其合法通道注册）与触发时机；
 *   2. 与既有实现的逐条对拍（inject-text / assembly / decision / append-context /
 *      request-params 与 tool-filter / tool-pipeline / progress-reminder / turn-stop /
 *      wireAgentRequests 同输入同输出）；
 *   3. 第 (5)(6) 类的**真实 PTC 子调用拒绝**（真实 ToolRuntime + 真实 ptc 传输管线，
 *      只替换语言运行时）：TS 与 Python 双载荷、预设切换后的首个请求、主子代理隔离、
 *      挂载失败与 disposer 释放；
 *   4. 第 (6) 类的解析用例：形态异常原样返回、删后自校验失败退回原文、引号转义工具名、
 *      空名单零开销；
 *   5. 第 (7) 类的 patch / replace / 按值条件删键三种语义。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import ToolRuntime, { renderToolsSdk, renderToolsSdkPy } from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { ACTION_DEGRADE, ACTION_KINDS, registerAction } from '../../engine/actions.mjs'
import { SDK_SECTION_NAME, sdkToolNames, stripSdkDeclarations } from '../../engine/sdk-strip.mjs'
import { applyAgentRequestParams, wireLayers } from '../../engine/layers.mjs'
import { applyPromptConfigs } from '../../engine/executor.mjs'
import { createPromptConfigs } from '../../engine/prompt-config-engine.mjs'
import { apply as applyToolFilter } from '../../engine/tool-filter.mjs'
import { apply as applyProgressReminder } from '../../engine/progress-reminder.mjs'
import { compositionConfig } from '../fixtures/composition-defaults.mjs'

/** 官方事件词汇表：动作声明的通道必须落在这里面。 */
const OFFICIAL_EVENTS = new Set([
  'agent/pre-step', 'agent/request', 'agent/turn-stopping', 'system-prompt/assemble', 'session/event',
  'llm/stream', 'tools/pre-execute', 'tools/post-execute', 'subagent/start', 'subagent/end',
])

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
    ...(services.ctx ?? {}),
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

test('动作声明：七类动作的合法通道都在官方事件表内，降级语义取四类固定词汇', () => {
  assert.deepEqual(Object.keys(ACTION_KINDS).sort(), [
    'append-context', 'assembly', 'decision', 'guard', 'inject-text', 'request-params', 'sdk-strip',
  ])
  const vocabulary = new Set(Object.values(ACTION_DEGRADE))
  for (const [kind, declaration] of Object.entries(ACTION_KINDS)) {
    assert.ok(declaration.events.length > 0, `${kind} 必须声明合法通道`)
    for (const event of declaration.events) assert.ok(OFFICIAL_EVENTS.has(event), `${kind} 声明了非官方事件 ${event}`)
    assert.ok(vocabulary.has(declaration.degrade), `${kind} 的降级语义必须在固定词汇内`)
    assert.ok(declaration.timing.length > 0 && declaration.note.length > 0, `${kind} 必须声明触发时机与降级说明`)
  }
  assert.equal(ACTION_KINDS.injectText, undefined)
  assert.equal(ACTION_KINDS['inject-text'].degrade, ACTION_DEGRADE.keep)
  assert.equal(ACTION_KINDS.assembly.degrade, ACTION_DEGRADE.exposeAll)
  assert.equal(ACTION_KINDS.guard.degrade, ACTION_DEGRADE.silent)
  assert.equal(ACTION_KINDS['request-params'].degrade, ACTION_DEGRADE.keep)
})

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
  ]
  for (const [label, action, expected] of cases) {
    const { ctx, events } = recordingCtx({ systemPrompt: systemPromptStub([]) })
    registerAction(ctx, action)
    const actual = events.map((entry) => entry.event).sort()
    assert.deepEqual(actual, expected, `${label} 只应在 ${expected.join('/')} 注册`)
    for (const event of actual) assert.ok(ACTION_KINDS[action.kind].events.includes(event), `${label} 注册了声明外的事件`)
  }
})

test('动作注册：未知 kind fail loud', () => {
  const { ctx } = recordingCtx()
  assert.throws(() => registerAction(ctx, { kind: 'nope' }), /unknown action kind/)
  assert.throws(() => registerAction(ctx, undefined), /unknown action kind/)
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

test('动作注册：plugin 身份由调用方传入（与 mountTriggers 同约定），缺省是中性的 prompt-actions', () => {
  const own = recordingCtx()
  assert.throws(() => registerAction(own.ctx, { kind: 'nope' }), /^TypeError: prompt-actions: /)
  assert.throws(() => registerAction(own.ctx, { kind: 'nope' }, { plugin: 'my-module' }), /^TypeError: my-module: /)
  const recorder = recordingCtx()
  registerAction(recorder.ctx, { kind: 'assembly', id: 'a', target: { tools: { deny: ['x'] } } })
  assert.equal(recorder.calls.at(-1).label, 'prompt-actions: action a')
})

// ───────────────────────── 二、与既有实现逐条对拍 ─────────────────────────

test('(1) 注入文本：system-section 与既有 applyPromptConfigs 注册出逐字段相同的段', () => {
  const spec = [{ id: 'sec', layer: 'system-section', text: 'HELLO', order: 7 }]
  const viaConfigs = recordingCtx({ systemPrompt: systemPromptStub([]) })
  viaConfigs.ctx.get = (serviceName) => (serviceName === 'systemPrompt' ? systemPromptStub(viaConfigs.calls) : undefined)
  applyPromptConfigs(viaConfigs.ctx, createPromptConfigs(spec), { prepend: true })

  const viaAction = recordingCtx()
  viaAction.ctx.get = (serviceName) => (serviceName === 'systemPrompt' ? systemPromptStub(viaAction.calls) : undefined)
  registerAction(viaAction.ctx, { kind: 'inject-text', id: 'sec', config: createPromptConfigs(spec)[0] })

  const sectionsOf = (calls) => calls.filter((call) => call.service === 'section').map((call) => call.entry)
  assert.deepEqual(sectionsOf(viaAction.calls), sectionsOf(viaConfigs.calls), '段注册必须与既有接线逐字段一致')
  assert.deepEqual(
    viaAction.events.filter((entry) => entry.event === 'agent/pre-step').length,
    0,
    '非 pre-step 层不得注册 pre-step 监听器',
  )
})

test('(1) 注入文本：pre-step 走既有执行器通道，注册的监听器与 applyPromptConfigs 一致', () => {
  const spec = [{ id: 'pre1', layer: 'pre-step', text: 'A' }]
  const direct = recordingCtx()
  applyPromptConfigs(direct.ctx, createPromptConfigs(spec), { prepend: true })
  const viaAction = recordingCtx()
  registerAction(viaAction.ctx, { kind: 'inject-text', id: 'pre1', options: { prepend: true }, config: createPromptConfigs(spec)[0] })
  assert.deepEqual(
    viaAction.events.map((entry) => ({ event: entry.event, options: entry.options })),
    direct.events.map((entry) => ({ event: entry.event, options: entry.options })),
  )
})

test('(2) 改装配 tools：与 tool-filter 在同一装配上逐条同结果（含 allow+deny 与空名单）', async () => {
  const cases = [
    { deny: ['web_search'] },
    { allow: ['bash', 'read'] },
    { allow: ['bash', 'read', 'web_search'], deny: ['web_search'] },
  ]
  for (const mask of cases) {
    const catalog = ['bash', 'read', 'web_search'].map(tool)
    const filter = recordingCtx()
    applyToolFilter(filter.ctx, { ...compositionConfig('tool-filter'), ...mask })
    const expected = await only(filter.events, 'system-prompt/assemble')(assembled(catalog.map((item) => ({ ...item }))), { agent: agent() }, async () => assembled(catalog.map((item) => ({ ...item }))))

    const viaAction = recordingCtx()
    registerAction(viaAction.ctx, { kind: 'assembly', id: 'm', target: { tools: mask } })
    const actual = await only(viaAction.events, 'system-prompt/assemble')(assembled(catalog.map((item) => ({ ...item }))), { agent: agent() }, async () => assembled(catalog.map((item) => ({ ...item }))))
    assert.deepEqual(actual.tools.map((item) => item.name), expected.tools.map((item) => item.name), `mask ${JSON.stringify(mask)}`)
    // 名单未命中时按官方默认不过滤
    assert.deepEqual(actual.tools.length, mask.allow === undefined ? 3 - mask.deny.length : Math.min(mask.allow.length, 3) - (mask.deny?.length ?? 0))
  }
  const empty = recordingCtx()
  registerAction(empty.ctx, { kind: 'assembly', id: 'm2', target: { tools: { deny: [] } } })
  const input = assembled([tool('bash')])
  const output = await only(empty.events, 'system-prompt/assemble')(input, { agent: agent() }, async () => input)
  assert.deepEqual(output.tools.map((item) => item.name), ['bash'], '空 deny = 不过滤')
})

test('(2) 改装配 sections/contexts：增删改与既有形态一致，异常时返回未改装配', async () => {
  const { ctx, events, warnings } = recordingCtx()
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

test('(3) 裁决：post-execute 与 tool-pipeline 层逐条同结果（accept/replace/block）', async () => {
  const build = (params, text) => {
    const [config] = createPromptConfigs([{ id: 'tp', layer: 'tool-pipeline', text, params }])
    const recorder = recordingCtx()
    wireLayers(recorder.ctx, [config], () => {})
    return only(recorder.events, 'tools/post-execute')
  }
  const action = (payload) => {
    const recorder = recordingCtx()
    registerAction(recorder.ctx, { kind: 'decision', id: 'tp', phase: 'post', ...payload })
    return only(recorder.events, 'tools/post-execute')
  }
  const exec = { name: 'bash', agent: agent(), arguments: { command: 'ls' } }
  const result = { kind: 'accept', content: [{ type: 'text', text: 'OUT' }] }
  const cases = [
    [{ toolNames: 'bash', postAction: 'replace' }, { toolNames: 'bash', action: 'replace' }, 'NEW'],
    [{ toolNames: 'bash', postAction: 'block' }, { toolNames: 'bash', action: 'block' }, 'STOP'],
    [{ toolNames: 'bash', postAction: 'accept' }, { toolNames: 'bash', action: 'accept' }, 'NEW'],
    [{ toolNames: 'read', postAction: 'block' }, { toolNames: 'read', action: 'block' }, 'STOP'],
  ]
  for (const [params, payload, text] of cases) {
    const expected = await build(params, text)(exec, result, async () => result)
    const actual = await action({ ...payload, text })(exec, result, async () => result)
    assert.deepEqual(actual, expected, `post ${JSON.stringify(params)}`)
  }
})

test('(4) 追加上下文：与 progress-reminder 的 additionalContexts 形状一致且只发 user 角色', async () => {
  const reminder = recordingCtx()
  applyProgressReminder(reminder.ctx, { ...compositionConfig('progress-reminder'), enabled: true, every: 1, maxPerTurn: 1, text: 'BEAT' })
  const exec = { name: 'bash', agent: agent(), arguments: {} }
  const decision = { kind: 'accept', content: [{ type: 'text', text: 'OUT' }] }
  const expected = await only(reminder.events, 'tools/post-execute')(exec, decision, async () => ({ ...decision }))

  const viaAction = recordingCtx()
  registerAction(viaAction.ctx, { kind: 'append-context', id: 'beat', mode: 'context', text: 'BEAT' })
  const actual = await only(viaAction.events, 'tools/post-execute')(exec, decision, async () => ({ ...decision }))
  assert.equal(actual.additionalContexts.length, 1)
  assert.deepEqual(actual.additionalContexts[0].content, expected.additionalContexts[0].content)
  assert.equal(actual.additionalContexts[0].role, 'user')
  assert.equal(actual.additionalContexts[0].source.kind, 'plugin')
  assert.equal(actual.additionalContexts[0].source.plugin, 'beat')
  // 非 accept 裁决不追加（与 progress-reminder 相同）
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

test('(4) 续跑：无正文 = 不注册（empty 降级），不伪造 assistant 角色', () => {
  const recorder = recordingCtx()
  registerAction(recorder.ctx, { kind: 'append-context', id: 'noop', mode: 'continue', text: '' })
  assert.deepEqual(recorder.events.map((entry) => entry.event), [])
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

test('(5) 真实 PTC：继承面工具先被 restrict 拿掉绑定（guard 之外的第一层），两者同源同名单', async () => {
  const h = await ptcHarness({ language: 'typescript' })
  const dispose = registerAction(h.root, { kind: 'guard', id: 'no-bash', mask: { deny: ['bash'] }, reason: 'inherited denied' })
  await h.assemble(h.main)
  assert.equal(h.tools.schemas(h.main).some((schema) => schema.name === 'bash'), false, 'restrict 已在继承面移除 bash')
  const result = await h.runCode(h.main, 'bash')
  assert.equal(result.isError, true, '即便模型知道旧名字，也既无绑定（restrict）又被 guard 裁决')
  assert.deepEqual(h.bodyRuns, [])
  dispose()
  await h.root.fiber.dispose()
})

test('(5) 真实 PTC 子调用：Python 载荷同样被 guard 拦下（同一名单判据）', async () => {
  const h = await ptcHarness({ language: 'python' })
  const dispose = registerAction(h.root, { kind: 'guard', id: 'no-own', mask: { deny: ['own_tool'] }, reason: 'python payload denied' })
  await h.assemble(h.main)
  const result = await h.runCode(h.main, 'own_tool')
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /python payload denied/)
  assert.deepEqual(h.bodyRuns, [])
  dispose()
  await h.root.fiber.dispose()
})

test('(5) 真实 PTC 子调用：disposer 释放后 guard 立即撤销（body 恢复执行）', async () => {
  const h = await ptcHarness()
  const dispose = registerAction(h.root, { kind: 'guard', id: 'g', mask: { deny: ['own_tool'] }, reason: 'no' })
  await h.assemble(h.main)
  assert.equal((await h.runCode(h.main, 'own_tool')).isError, true)
  dispose()
  const after = await h.runCode(h.main, 'own_tool')
  assert.equal(after.isError, false, '释放后不得继续拒绝')
  assert.deepEqual(h.bodyRuns, ['own_tool'])
  dispose() // 幂等
  await h.root.fiber.dispose()
})

test('(5) 真实 PTC 子调用：主子代理隔离（子代理 scope 挂在父链上也不被父 guard 波及）', async () => {
  const h = await ptcHarness()
  const child = await h.makeAgent('child', h.main)
  const dispose = registerAction(h.root, { kind: 'guard', id: 'main-only', mask: { deny: ['own_tool'] }, reason: 'main only' })
  await h.assemble(h.main)
  await h.assemble(child)
  assert.equal((await h.runCode(h.main, 'own_tool')).isError, true, '主会话被拦')
  assert.equal(child.session.header.delegationDepth, 1)
  const childRun = await h.runCode(child, 'own_tool')
  assert.notEqual(childRun.isError === true && /main only/.test(childRun.content[0].text), true, '子代理不得被仅主会话的 guard 拒绝')
  assert.deepEqual(h.bodyRuns, ['own_tool'], '子代理自己的调用照常执行')
  dispose()
  await h.root.fiber.dispose()
})

test('(5) includeSubagents=true：子代理同样在 guard 的裁决面内', async () => {
  const h = await ptcHarness()
  const child = await h.makeAgent('child', h.main)
  const dispose = registerAction(h.root, { kind: 'guard', id: 'all', mask: { deny: ['own_tool'] }, includeSubagents: true, reason: 'all agents' })
  await h.assemble(child)
  const childRun = await h.runCode(child, 'own_tool')
  assert.equal(childRun.isError, true)
  assert.match(childRun.content[0].text, /all agents/)
  dispose()
  await h.root.fiber.dispose()
})

test('(5) guard 是最终拒绝：pre-execute 水位的放行不能解除它', async () => {
  const h = await ptcHarness()
  // 另一条策略在最外层明确 allow（下游 waterfall 放行），guard 仍在其后独立求值。
  h.root.on('tools/pre-execute', async (_exec, next) => next(), { prepend: true })
  const dispose = registerAction(h.root, { kind: 'guard', id: 'g', mask: { deny: ['own_tool'] }, reason: 'final' })
  await h.assemble(h.main)
  const denied = await h.runCode(h.main, 'own_tool')
  assert.equal(denied.isError, true, 'guard 在 pre-execute 之后独立求值，allow 无权解除')
  assert.deepEqual(h.bodyRuns, [])
  dispose()
  await h.root.fiber.dispose()
})

test('(5) 挂载失败：无 agent-scoped tools 服务时只告警一次，不抛错、不伪装成已生效', async () => {
  const recorder = recordingCtx()
  registerAction(recorder.ctx, { kind: 'guard', id: 'g', mask: { deny: ['bash'] } })
  const context = { agent: { session: session(0), ctx: {} } }
  const handler = only(recorder.events, 'system-prompt/assemble')
  const output = await handler(assembled([]), context, async () => assembled([]))
  assert.deepEqual(output.tools, [])
  assert.equal(recorder.warnings.length, 1)
  assert.match(recorder.warnings[0], /no agent-scoped tools service/)
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

// ───────────────────────── 四、第 (6) 类：解析用例 ─────────────────────────

const tsSdk = renderToolsSdk([
  { name: 'bash', description: 'shell', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] }, output: { type: 'object', properties: { stdout: { type: 'string' } } } },
  { name: 'we"ird', description: 'quoted', parameters: { type: 'object', properties: { x: { type: 'number' } } }, output: { type: 'object', properties: {} } },
  { name: 'read', description: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }, output: { type: 'object', properties: { text: { type: 'string' } } } },
])
const pySdk = renderToolsSdkPy([
  { name: 'bash', description: 'shell', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] }, output: { type: 'object', properties: { stdout: { type: 'string' } } } },
  { name: 'my-tool', description: 'exotic', parameters: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] }, output: { type: 'object', properties: {} } },
  { name: 'read', description: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }, output: { type: 'object', properties: { text: { type: 'string' } } } },
])

test('(6) 解析：TS 载荷删成员后保留成员逐字节不变，且两表成员集合一致', () => {
  const stripped = stripSdkDeclarations(tsSdk, new Set(['bash']))
  assert.notEqual(stripped, tsSdk)
  assert.deepEqual(sdkToolNames(stripped).sort(), ['read', 'we"ird'])
  assert.ok(!stripped.includes('  bash: '))
  assert.ok(stripped.includes('  read: {'))
  assert.ok(stripped.includes('  "we\\"ird": {'))
  // 只删不增：结果行是原文行的子多重集
  const pool = new Map()
  for (const line of tsSdk.split('\n')) pool.set(line, (pool.get(line) ?? 0) + 1)
  for (const line of stripped.split('\n')) {
    const left = pool.get(line) ?? 0
    assert.ok(left > 0, `出现了原文没有的行：${JSON.stringify(line)}`)
    pool.set(line, left - 1)
  }
})

test('(6) 解析：Python 载荷删成员并删除只被它引用的 TypedDict 类', () => {
  const stripped = stripSdkDeclarations(pySdk, new Set(['bash']))
  assert.notEqual(stripped, pySdk)
  assert.deepEqual(sdkToolNames(stripped).sort(), ['my-tool', 'read'])
  assert.ok(!stripped.includes('class BashArgs'), '只被被剔工具引用的类必须一并删除')
  assert.ok(!stripped.includes('class BashOutput'))
  assert.ok(stripped.includes('class ReadArgs'))
  assert.ok(stripped.includes('class ToolCallError'), '固定错误类型永不被删')
  assert.ok(!/async def bash\(self/.test(stripped))
})

test('(6) 解析：需引号转义的工具名（TS 与 Python 两侧）都被精确删除', () => {
  const ts = stripSdkDeclarations(tsSdk, new Set(['we"ird']))
  assert.deepEqual(sdkToolNames(ts).sort(), ['bash', 'read'])
  assert.ok(!ts.includes('we\\"ird'))
  const py = stripSdkDeclarations(pySdk, new Set(['my-tool']))
  assert.deepEqual(sdkToolNames(py).sort(), ['bash', 'read'])
  assert.ok(!py.includes('# tools["my-tool"]'))
  assert.ok(!py.includes('class MyToolOutput'))
})

test('(6) 解析：空名单零开销（返回同一引用，不解析）', () => {
  assert.equal(stripSdkDeclarations(tsSdk, new Set()), tsSdk)
  assert.equal(stripSdkDeclarations(pySdk, []), pySdk)
  assert.equal(stripSdkDeclarations(tsSdk, undefined), tsSdk)
  assert.deepEqual(sdkToolNames(''), [])
})

test('(6) 解析：形态异常原样返回；名单未命中同样原样返回', () => {
  const malformed = '```ts\ninterface ToolArgsMap {\n  broken: ;\n}\n```'
  assert.equal(stripSdkDeclarations(malformed, ['broken']), malformed)
  assert.equal(stripSdkDeclarations('not an sdk at all', ['x']), 'not an sdk at all')
  assert.equal(stripSdkDeclarations('', ['x']), '')
  assert.equal(stripSdkDeclarations(tsSdk, ['nope']), tsSdk)
  assert.equal(stripSdkDeclarations(pySdk, ['nope']), pySdk)
  // 截断的段（自校验失败）：协议头在、成员与类被截掉
  const truncated = pySdk.slice(0, pySdk.indexOf('class Tools(Protocol):')) + 'class Tools(Protocol):\n'
  assert.equal(stripSdkDeclarations(truncated, ['bash']), truncated)
})

test('(6) 解析：删空 Python 协议体会只剩注释（非法语法）→ 保守放弃，返回原文', () => {
  const single = stripSdkDeclarations(pySdk, ['my-tool'])
  assert.notEqual(single, pySdk)
  const all = stripSdkDeclarations(pySdk, ['bash', 'my-tool', 'read'])
  assert.equal(all, pySdk, 'Python 保守失败：绝不新增 pass 来凑语法')
  const tsAll = stripSdkDeclarations(tsSdk, ['bash', 'we"ird', 'read'])
  assert.notEqual(tsAll, tsSdk, 'TS 的空表是合法语法，允许删空')
  assert.deepEqual(sdkToolNames(tsAll), [])
})

test('(6) 降级：SDK 段被替换时下游异常原样上抛，改写失败保留原文并告警', async () => {
  const recorder = recordingCtx()
  registerAction(recorder.ctx, { kind: 'sdk-strip', id: 's', mask: { deny: ['bash'] } })
  const handler = only(recorder.events, 'system-prompt/assemble')
  const input = assembled([], { sections: [{ name: SDK_SECTION_NAME, text: tsSdk }] })
  const output = await handler(input, { agent: agent() }, async () => ({ ...input, sections: [...input.sections] }))
  assert.notEqual(output.sections[0].text, tsSdk)
  assert.equal(input.sections[0].text, tsSdk, '输入不得被就地修改')

  const broken = { ...input, sections: [{ name: SDK_SECTION_NAME, get text() { throw new Error('nope') } }] }
  const kept = await handler(broken, { agent: agent() }, async () => broken)
  assert.equal(kept, broken)
  assert.equal(recorder.warnings.length, 1)
  assert.match(recorder.warnings[0], /keeping the original SDK text/)
  await assert.rejects(handler(input, { agent: agent() }, async () => { throw new Error('downstream') }), /downstream/)
})

test('(6) allow 名单：正文里不在白名单内的工具被删（差集来自正文自身）', async () => {
  const recorder = recordingCtx()
  registerAction(recorder.ctx, { kind: 'sdk-strip', id: 'only-read', mask: { allow: ['read'] } })
  const input = assembled([], { sections: [{ name: SDK_SECTION_NAME, text: pySdk }] })
  const output = await only(recorder.events, 'system-prompt/assemble')(input, { agent: agent() }, async () => ({ ...input, sections: [...input.sections] }))
  assert.deepEqual(sdkToolNames(output.sections[0].text), ['read'])
})

// ───────────────────────── 五、第 (7) 类：请求参数三种语义 ─────────────────────────

test('(7) patch：浅合并（既有 agent-request 层的原始实现作为对拍基准）', async () => {
  const legacy = (params, base) => {
    const patch = params?.patch !== null && typeof params?.patch === 'object' && !Array.isArray(params.patch) ? params.patch : {}
    if (params?.replace === true) return { ...patch }
    return { ...base, ...patch }
  }
  const bases = [
    { provider: 'deepseek', model: 'chat', maxTokens: 1000, stop: ['x'] },
    { provider: 'deepseek', model: 'chat' },
  ]
  const paramsList = [{ patch: { maxTokens: 64 } }, { patch: {} }, { patch: null }, { patch: { temperature: 0.2, stop: ['a'] } }]
  for (const base of bases) {
    for (const params of paramsList) {
      assert.deepEqual(applyAgentRequestParams(params, base), legacy(params, base), `${JSON.stringify(params)} on ${JSON.stringify(base)}`)
    }
  }
})

test('(7) replace：整体替换，逐字段与既有实现一致', () => {
  const full = { provider: 'other', model: 'other-model' }
  const params = { replace: true, patch: full }
  assert.deepEqual(applyAgentRequestParams(params, { provider: 'deepseek', model: 'chat', maxTokens: 999 }), full)
  assert.equal(applyAgentRequestParams(params, { provider: 'deepseek' }).maxTokens, undefined)
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

test('(7) 与既有 agent-request 层同源：同一 params 下监听器输出逐字段一致', async () => {
  const params = { patch: { maxTokens: 2048 } }
  const [config] = createPromptConfigs([{ id: 'ar', layer: 'agent-request', params }])
  const recorder = recordingCtx()
  wireLayers(recorder.ctx, [config], () => {})
  const layerHandler = only(recorder.events, 'agent/request')

  const viaAction = recordingCtx()
  registerAction(viaAction.ctx, { kind: 'request-params', id: 'ar', ...params })
  const actionHandler = only(viaAction.events, 'agent/request')

  for (const base of [{ provider: 'deepseek', model: 'chat' }, { provider: 'p', model: 'm', maxTokens: 1, stop: ['s'] }]) {
    const fromLayer = await layerHandler({ agent: agent() }, async () => base)
    const fromAction = await actionHandler({ agent: agent() }, async () => base)
    assert.deepEqual(fromAction, fromLayer, `patch 语义需与既有层逐字段一致：${JSON.stringify(base)}`)
  }
})

test('(7) 只改命中 scope/agent 的请求：audience 与 modelScope 不命中的 agent 透传', async () => {
  const recorder = recordingCtx()
  registerAction(recorder.ctx, { kind: 'request-params', id: 'main-only', audience: 'main', modelScope: 'pro', patch: { maxTokens: 8 } })
  const handler = only(recorder.events, 'agent/request')
  const base = { provider: 'deepseek', model: 'chat' }
  const mainPro = { session: session(0), options: { model: 'deepseek-chat' } }
  const subPro = { session: session(1), options: { model: 'deepseek-chat' } }
  const mainFlash = { session: session(0), options: { model: 'deepseek-flash' } }
  assert.deepEqual(await handler({ agent: mainPro }, async () => base), { ...base, maxTokens: 8 })
  assert.deepEqual(await handler({ agent: subPro }, async () => base), base, '子代理不得继承主会话的请求改写')
  assert.deepEqual(await handler({ agent: mainFlash }, async () => base), base, 'modelScope 不命中不得改写')
  assert.throws(() => registerAction(recordingCtx().ctx, { kind: 'request-params', id: 'bad', patch: 3 }), /patch must be an object/)
})

test('(7) 未命中/异常降级：下游异常原样上抛（动作只 guard 自身逻辑）', async () => {
  const recorder = recordingCtx()
  registerAction(recorder.ctx, { kind: 'request-params', id: 'r', patch: { maxTokens: 8 } })
  const handler = only(recorder.events, 'agent/request')
  await assert.rejects(handler({ agent: agent() }, async () => { throw new Error('downstream') }), /downstream/)
})

test('释放：动作的 disposer 撤销它注册的全部监听器', () => {
  const recorder = recordingCtx({ systemPrompt: systemPromptStub([]) })
  const dispose = registerAction(recorder.ctx, { kind: 'decision', id: 'd', phase: 'pre', decision: 'deny' })
  assert.equal(recorder.events.length, 1)
  dispose()
  assert.equal(recorder.events.length, 0)
  dispose()
  assert.equal(scopeOf, scopeOf) // 保持导入被使用（真实 scope 断言在上面 PTC 用例里）
})
