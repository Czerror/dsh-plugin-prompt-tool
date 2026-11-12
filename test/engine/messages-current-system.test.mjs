import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
await import('../../engine/provider-system-roles-early.mjs')
await import('../../engine/messages-current-system-early.mjs')
await import('../../engine/request-budget-early.mjs')
const { createAgentAssembly } = await import('../../src/runtime/agent-assembly.ts')
const { compileRules } = await import('../../engine/rule-spec.mjs')
const { providerSystemRolesBridge } = await import('../../engine/provider-system-roles.mjs')
const require = createRequire(import.meta.url), peer = createRequire(require.resolve('@deepseek-ai/dsh-agent-loop'))
const load = name => import(pathToFileURL(peer.resolve('@deepseek-ai/' + name)).href)
const [{ default: Llm, createUserMessage, createSystemMessage, createAssistantMessage, createToolResultMessage, createDeveloperMessage }, { default: Agents, assembleContextFor }, { default: Prompt }, { default: Sessions }, { default: Projections }, { default: Loop }, { default: Tools }, Native, Persistence] = await Promise.all([
  load('dsh-llm'), load('dsh-agent'), load('dsh-system-prompt'), load('dsh-session'), load('dsh-session-projection'), load('dsh-agent-loop'), load('dsh-tools'), load('dsh-tool-executor-native'), load('dsh-session-persistence-jsonl'),
])
const { DeepSeekAdapter, resolveAdapterOptions } = await import('@deepseek-ai/dsh-llm-deepseek')
const deadline = async promise => {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Messages request timeout')), 10000) })]) }
  finally { clearTimeout(timer) }
}
const textOf = content => content?.map(block => block.text ?? '').join('') ?? ''
const user = text => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
async function fixture(t) {
  const requests = [], responses = [], waiters = [], root = new Context(), home = mkdtempSync(join(tmpdir(), 'pt25-')), moduleRoot = join(home, 'modules'), moduleDir = join(moduleRoot, 'messages')
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    requests.push({ path: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString()) })
    for (const waiter of waiters.splice(0)) waiter()
    const respond = () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const events = [
        { type: 'message_start', message: { id: 'msg_1', model: 'probe', usage: { input_tokens: 3, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'OK' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }, { type: 'message_stop' },
      ]
      res.end(events.map(event => 'event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n').join(''))
    }
    const behavior = responses.shift()
    if (behavior === undefined) respond(); else behavior(respond, req, res)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const connection = resolveAdapterOptions({ baseURL: 'http://127.0.0.1:' + server.address().port + '/anthropic', thinking: 'disabled', models: [{ id: 'probe', systemPromptUpdate: 'in-history', toolUpdate: 'in-history' }], retryPolicy: { mode: 'normal', maxRetries: 1 }, streamIdleTimeoutMs: 10000 })
  const adapter = new DeepSeekAdapter({ options: () => connection, resolveAuth: async () => ({ headers: { 'x-api-key': 'local-only' } }), resolveUserId: () => 'local-user', prepareExtensions: async () => ({ fields: {}, accept: async () => {} }) })
  mkdirSync(moduleDir, { recursive: true })
  const define = (enabled = false, snapshot = false, body = 'BODY_A', audience = 'main') => writeFileSync(join(moduleDir, 'module.yml'), JSON.stringify({ id: 'messages', modules: ['rule-engine'], rules: [
    { id: 'messages', enabled, if: { scope: { audience } }, then: [{ id: 'control', kind: 'host-control', capability: 'messages-current-system', value: true }, { id: 'dependent', kind: 'inject-text', config: { layer: 'system-section', order: 2, text: 'QUALIFIED' } }] },
    { id: 'snapshot', enabled: snapshot, then: [{ id: 'snapshot', kind: 'host-control', capability: 'current-system-snapshot', value: true }] },
    { id: 'body', then: [{ id: 'body', kind: 'inject-text', config: { layer: 'system-section', order: 3, text: body } }] },
  ] }))
  define()
  for (const plugin of [Llm, Sessions, Projections, Prompt, Tools, Native, Agents]) await root.plugin(plugin)
  await root.plugin(Persistence, { root: join(home, 'sessions'), compression: 'none' })
  root.tools.register({ name: 'FixtureTool', description: 'KEEP TOOL', parameters: { type: 'object', properties: {} }, output: { schema: { type: 'string' }, render: () => [{ type: 'text', text: 'RESULT' }] }, execute: () => 'RESULT' })
  await root.plugin(Loop, { agents: [] })
  root.provide('workingDirectory', { get: () => home, ensure: async () => home, set: async () => home })
  const registration = root.llm.registerAdapter(['fixture'], adapter), outcomes = []
  const runtime = createAgentAssembly(root, { moduleRoot, enabledModules: () => ['messages'], onOutcome: outcome => outcomes.push(outcome) })
  await runtime.settled()
  const handles = []
  const agent = async (id, child = false) => {
    const handle = await root.agents.create({ sessionId: id, agentOptions: { provider: 'fixture', model: 'probe' }, meta: { cwd: home, ...(child ? { origin: 'subagent', delegationDepth: 1 } : {}) } })
    handles.push(handle)
    return handle.agent
  }
  const prepare = async agent => {
    const selection = { ...agent.model.current() }, context = { ...assembleContextFor(agent, new AbortController().signal), modelSelection: selection }
    context.toolSet = await agent.loopCtx.tools.resolve(context)
    await agent.loopCtx.systemPrompt.assemble(context)
    const prepared = await providerSystemRolesBridge.prepare(agent, selection, () => adapter.prepareCall(selection.provider, selection.model, context.signal))
    t.after(() => context.toolSet.dispose())
    return { prepared, context, options: { ...selection, sessionId: agent.id, signal: context.signal } }
  }
  const send = async (agent, text = 'U') => {
    const start = requests.length
    const arrived = new Promise(resolve => waiters.push(resolve))
    agent.followup(user(text))
    await deadline(arrived)
    await deadline(agent.whenIdle())
    const request = requests.slice(start).find(request => JSON.stringify(request.body).includes(text))
    assert.ok(request, JSON.stringify(outcomes))
    return request
  }
  t.after(async () => { await runtime.dispose(); for (const handle of handles) await handle.dispose(); await root.fiber.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(home, { recursive: true, force: true }) })
  return { root, runtime, adapter, registration, agent, prepare, send, define, requests, responses, outcomes, nextRequest: () => new Promise(resolve => waiters.push(resolve)) }
}
async function consume(prepared, options) { for await (const chunk of prepared.stream(options)) assert.notEqual(chunk.type === 'finish' && chunk.reason.kind, 'error', JSON.stringify(chunk)) }
const history = () => [createSystemMessage('S_A'), user('U'), createAssistantMessage({ source: { provider: 'fixture', model: 'probe' }, content: [{ type: 'tool-call', id: 'c1', name: 'FixtureTool', arguments: '{}' }] }), createToolResultMessage({ callId: 'c1', content: [{ type: 'text', text: 'RESULT' }] }), createSystemMessage('S_B'), user('V')]

test('Messages 当前 system 是独立布尔动作，拒绝次数和非默认时机', () => {
  const action = { id: 'control', kind: 'host-control', capability: 'messages-current-system', value: true }
  assert.equal(compileRules([{ id: 'messages', then: [action] }]).length, 1)
  for (const patch of [{ value: false }, { maxPerTurn: 1 }, { waterfallPosition: 'last' }]) assert.throws(() => compileRules([{ id: 'bad', then: [{ ...action, ...patch }] }]))
})

test('真实 Messages HTTP 将晚到 system 保留在顶层，并保留前缀、工具和原认证', async t => {
  const world = await fixture(t), agent = await world.agent('pt25-history')
  const off = await world.prepare(agent)
  await consume(off.prepared, { ...off.options, system: 'PREFIX', messages: history() })
  assert.equal(world.requests.at(-1).body.system, 'PREFIX\n\nS_A')
  assert.ok(world.requests.at(-1).body.messages.some(message => message.role === 'system' && textOf(message.content) === 'S_B'))
  world.define(true)
  await world.runtime.refresh()
  const on = await world.prepare(agent)
  await consume(on.prepared, { ...on.options, system: 'PREFIX', messages: history() })
  const request = world.requests.at(-1)
  assert.equal(request.body.system, 'PREFIX\n\nS_B', JSON.stringify(world.outcomes))
  assert.deepEqual(request.body.messages, [
    { role: 'user', content: [{ type: 'text', text: 'U' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'FixtureTool', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: [{ type: 'text', text: 'RESULT' }] }, { type: 'text', text: 'V' }] },
  ])
  assert.equal(request.headers['x-api-key'], 'local-only')
  assert.equal(request.headers['anthropic-version'], '2023-06-01')
  assert.equal(request.headers['x-deepseek-harness-session-id'], agent.id)
})

test('关闭和未绑定的公开 adapter 原路径透传；开启时空 system 不擦正文且 developer 工具变更保留', async t => {
  const world = await fixture(t), agent = await world.agent('pt25-empty')
  await consume(world.adapter, { provider: 'fixture', model: 'probe', messages: [createSystemMessage('DIRECT'), user('U')] })
  assert.equal(world.requests.at(-1).body.system, 'DIRECT')
  world.define(true)
  await world.runtime.refresh()
  const on = await world.prepare(agent)
  const messages = [...history(), createSystemMessage(''), createDeveloperMessage({ source: { kind: 'tool-registry' }, content: [{ type: 'tool-addition', toolName: 'FixtureTool' }, { type: 'tool-removal', toolName: 'OldTool' }] })]
  await consume(on.prepared, { ...on.options, messages })
  assert.equal(world.requests.at(-1).body.system, 'S_B')
  assert.deepEqual(world.requests.at(-1).body.messages.at(-1), { role: 'system', content: [{ type: 'tool_addition', tool: { type: 'tool_reference', name: 'FixtureTool' } }, { type: 'tool_removal', tool: { type: 'tool_reference', name: 'OldTool' } }] })
  assert.ok(world.requests.at(-1).headers['anthropic-beta'])
  for (const invalid of [
    [user('U'), createToolResultMessage({ callId: 'missing', content: [{ type: 'text', text: 'bad' }] })],
    [user('U'), createAssistantMessage({ source: { provider: 'fixture', model: 'probe' }, content: [{ type: 'tool-call', id: 'c1', name: 'FixtureTool', arguments: '{}' }, { type: 'tool-call', id: 'c1', name: 'FixtureTool', arguments: '{}' }] })],
  ]) {
    const before = world.requests.length
    await assert.rejects(consume(on.prepared, { ...on.options, messages: invalid }), /matching call|duplicate tool call/)
    assert.equal(world.requests.length, before)
  }
})

test('22和25四格独立，真实请求正文与JSONL中的同step系统正文一致', async t => {
  const world = await fixture(t)
  for (const snapshot of [false, true]) for (const enabled of [false, true]) {
    world.define(enabled, snapshot, 'BODY_A')
    await world.runtime.refresh()
    const agent = await world.agent('pt25-matrix-' + snapshot + '-' + enabled)
    await world.send(agent, 'FIRST')
    world.define(enabled, snapshot, 'BODY_B')
    await world.runtime.refresh()
    const request = await world.send(agent, 'SECOND')
    const systems = agent.session.snapshotEvents().filter(event => event.type === 'system/message')
    const current = systems.at(-1), step = agent.session.snapshotEvents().findLast(event => event.type === 'step/start')
    assert.deepEqual({ turn: current.data.turn, step: current.data.step }, step.data)
    if (enabled || snapshot) assert.equal(request.body.system, textOf(current.data.message.content))
    else assert.equal(request.body.system, textOf(systems[0].data.message.content))
    if (!snapshot && !enabled) assert.ok(request.body.messages.some(message => message.role === 'system' && textOf(message.content).includes('BODY_B')))
    if (enabled) assert.ok(!request.body.messages.some(message => message.role === 'system' && textOf(message.content).includes('BODY_B')))
    await world.root.sessions.flush(agent.session)
    const persisted = await world.root.sessionPersistence.open(agent.id, 'read')
    try { assert.deepEqual((await persisted.read()).events.find(event => event.seq === current.seq), current) }
    finally { await persisted.close() }
  }
})

test('真实loop执行工具后晚到system仅进入顶层，工具call/result与JSONL保持同step', async t => {
  const world = await fixture(t), agent = await world.agent('pt25-real-tools')
  world.define(true, false, 'BODY_A')
  await world.runtime.refresh()
  world.responses.push((_respond, _req, res) => {
    const events = [
      { type: 'message_start', message: { id: 'tool_response', model: 'probe', usage: { input_tokens: 3, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'c1', name: 'FixtureTool', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } }, { type: 'message_stop' },
    ]
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(events.map(event => 'event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n').join(''))
  })
  const stop = world.root.on('tools/post-execute', async (_exec, _result, next) => {
    const decision = await next()
    world.define(true, false, 'BODY_B')
    await world.runtime.refresh()
    return decision
  })
  t.after(stop)
  await world.send(agent, 'U')
  assert.equal(world.requests.length, 2)
  const request = world.requests[1]
  assert.ok(request.body.system.includes('BODY_B') && !request.body.system.includes('BODY_A'))
  assert.ok(!request.body.messages.some(message => message.role === 'system'))
  assert.deepEqual(request.body.messages.flatMap(message => message.content.filter(block => block.type === 'tool_use' || block.type === 'tool_result')), [
    { type: 'tool_use', id: 'c1', name: 'FixtureTool', input: {} },
    { type: 'tool_result', tool_use_id: 'c1', content: [{ type: 'text', text: 'RESULT' }], is_error: false },
  ])
  const system = agent.session.snapshotEvents().findLast(event => event.type === 'system/message')
  assert.equal(request.body.system, textOf(system.data.message.content))
  const result = agent.session.snapshotEvents().find(event => event.type === 'tool/result')
  assert.equal(result.data.step + 1, system.data.step)
  assert.equal(result.data.turn, system.data.turn)
  await world.root.sessions.flush(agent.session)
  const persisted = await world.root.sessionPersistence.open(agent.id, 'read')
  try {
    const log = (await persisted.read()).events
    assert.deepEqual(log.find(event => event.seq === system.seq), system)
    assert.deepEqual(log.find(event => event.seq === result.seq), result)
  } finally { await persisted.close() }
})

test('22和25同时开启时保留当步正文及其他来源system贡献', async t => {
  const world = await fixture(t), agent = await world.agent('pt25-other-owner')
  world.define(true, true, 'BODY_A')
  await world.runtime.refresh()
  await world.send(agent, 'FIRST')
  const prior = agent.session.snapshotEvents().findLast(event => event.type === 'system/message')
  const sameBody = textOf(prior.data.message.content).replace('BODY_A', 'BODY_B')
  for (const [kind, text] of [['other-owner-a', ' OTHER_A\r\n '], ['other-owner-b', 'OTHER_B'], ['same-text-other-owner', sameBody], ['system-prompt', 'OLD_SAME_OWNER']]) {
    agent.session.append('system/message', { turn: prior.data.turn, step: prior.data.step, message: { ...createSystemMessage(text), source: { kind } } }, { surfaceOp: 'append' })
  }
  world.define(true, true, 'BODY_B')
  await world.runtime.refresh()
  const request = await world.send(agent, 'SECOND')
  assert.equal(request.body.system, [sameBody, ' OTHER_A\r\n ', 'OTHER_B', sameBody].join('\n\n'))
  assert.ok(!request.body.messages.some(message => message.role === 'system'))
})

test('同一启用配置下主子真实loop并发按受众隔离，切换受众后反向生效', async t => {
  const world = await fixture(t), main = await world.agent('pt25-audience-main'), child = await world.agent('pt25-audience-child', true)
  world.define(true, false, 'AUDIENCE_A', 'main')
  await world.runtime.refresh()
  await Promise.all([world.send(main, 'MAIN_A'), world.send(child, 'CHILD_A')])
  world.define(true, false, 'AUDIENCE_B', 'main')
  await world.runtime.refresh()
  const [mainB, childB] = await Promise.all([world.send(main, 'MAIN_B'), world.send(child, 'CHILD_B')])
  assert.ok(mainB.body.system.includes('AUDIENCE_B') && !mainB.body.system.includes('AUDIENCE_A'))
  assert.ok(childB.body.system.includes('AUDIENCE_A') && !childB.body.system.includes('AUDIENCE_B'))
  assert.ok(childB.body.messages.some(message => message.role === 'system' && textOf(message.content).includes('AUDIENCE_B')))
  assert.ok(!mainB.body.messages.some(message => message.role === 'system'))
  world.define(true, false, 'AUDIENCE_C', 'subagent')
  await world.runtime.refresh()
  const [mainC, childC] = await Promise.all([world.send(main, 'MAIN_C'), world.send(child, 'CHILD_C')])
  assert.ok(mainC.body.system.includes('AUDIENCE_A') && !mainC.body.system.includes('AUDIENCE_C'))
  assert.ok(childC.body.system.includes('AUDIENCE_C') && !childC.body.system.includes('AUDIENCE_A'))
  assert.ok(mainC.body.messages.some(message => message.role === 'system' && textOf(message.content).includes('AUDIENCE_C')))
  assert.ok(!childC.body.messages.some(message => message.role === 'system'))
})

test('prepared请求热更不混正文，旧步重试固定A、下一步采用B', async t => {
  const world = await fixture(t)
  world.define(true, false, 'BODY_A')
  await world.runtime.refresh()
  const main = await world.agent('pt25-retry')
  const a = await world.prepare(main)
  world.define(false, false, 'BODY_B')
  await world.runtime.refresh()
  await consume(a.prepared, { ...a.options, messages: history() })
  assert.equal(world.requests.find(request => request.headers['x-deepseek-harness-session-id'] === main.id).body.system, 'S_B')
  world.define(true, true, 'BODY_A')
  await world.runtime.refresh()
  await world.send(main, 'BEFORE_RETRY')
  const prior = main.session.snapshotEvents().findLast(event => event.type === 'system/message')
  main.session.append('system/message', { turn: prior.data.turn, step: prior.data.step, message: { ...createSystemMessage('RETRY_OTHER'), source: { kind: 'retry-other-owner' } } }, { surfaceOp: 'append' })
  let release
  const held = new Promise(resolve => { release = resolve })
  world.responses.push(async (_respond, _req, res) => {
    await held
    res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '0' })
    res.end(JSON.stringify({ error: { type: 'overloaded_error', message: 'local retry' } }))
  })
  const entered = world.nextRequest(), pending = world.send(main, 'RETRY_A')
  await deadline(entered)
  const stopRetry = world.root.on('agent/request-error', async () => ({ kind: 'retry' }))
  t.after(stopRetry)
  world.define(true, true, 'BODY_B')
  await world.runtime.refresh()
  release()
  await pending
  const attempts = world.requests.filter(request => JSON.stringify(request.body).includes('RETRY_A'))
  assert.equal(attempts.length, 2)
  assert.ok(attempts.every(request => request.body.system.includes('BODY_A') && !request.body.system.includes('BODY_B')))
  assert.ok(attempts.every(request => request.body.system.endsWith('\n\nRETRY_OTHER')))
  assert.equal(attempts[0].body.system, attempts[1].body.system)
  const next = await world.send(main, 'NEXT_B')
  assert.ok(next.body.system.includes('BODY_B'))
  assert.ok(next.body.system.endsWith('\n\nRETRY_OTHER'))
})

test('取消、步骤释放和adapter重挂不复活旧资格，必要owner失配只暂停关联正文', async t => {
  const world = await fixture(t)
  world.define(true)
  await world.runtime.refresh()
  const agent = await world.agent('pt25-release'), old = await world.prepare(agent)
  await old.context.toolSet.dispose()
  await consume(old.prepared, { ...old.options, messages: history() })
  assert.equal(world.requests.at(-1).body.system, 'S_A')
  const active = await world.prepare(agent)
  world.registration()
  const remounted = world.root.llm.registerAdapter(['fixture'], world.adapter)
  t.after(remounted)
  await consume(active.prepared, { ...active.options, messages: history() })
  assert.equal(world.requests.at(-1).body.system, 'S_A')
  const group = world.adapter[Symbol.for('prompt-tool:provider-system-roles-adapter')]
  const token = group.messages
  group.messages = 'unverified'
  const missing = await world.send(agent, 'MISSING')
  assert.ok(missing.body.system.includes('BODY_A'))
  assert.ok(!JSON.stringify(missing.body).includes('QUALIFIED'))
  group.messages = token
  const restored = await world.send(agent, 'RESTORED')
  assert.ok(restored.body.system.includes('QUALIFIED'))
  const cancelled = await world.prepare(agent), before = world.requests.length
  const abort = new AbortController()
  abort.abort()
  await assert.rejects(consume(cancelled.prepared, { ...cancelled.options, signal: abort.signal, messages: history() }))
  assert.equal(world.requests.length, before)
})

test('实际prepare之后热更不替换已接受正文，取消前请求无HTTP且后续步骤不混合', async t => {
  const world = await fixture(t), agent = await world.agent('pt25-prestream')
  world.define(true, true, 'BODY_A')
  await world.runtime.refresh()
  let stop = world.root.on('agent/request', async (_payload, next) => {
    stop()
    world.define(false, false, 'BODY_B')
    await world.runtime.refresh()
    await agent.loopCtx.systemPrompt.assemble({ agent, signal: new AbortController().signal })
    return next()
  })
  const accepted = await world.send(agent, 'ACCEPTED_A')
  assert.ok(accepted.body.system.includes('BODY_A') && accepted.body.system.includes('QUALIFIED'))
  assert.ok(!accepted.body.system.includes('BODY_B'))
  world.define(true, true, 'CANCELLED_BODY')
  await world.runtime.refresh()
  const start = agent.session.snapshotEvents().at(-1).seq, count = world.requests.length
  stop = world.root.on('agent/request', async (_payload, next) => { stop(); agent.cancel('user'); return next() })
  agent.followup(user('CANCEL'))
  await deadline(agent.whenIdle())
  const events = agent.session.snapshotEvents().filter(event => event.seq > start)
  assert.ok(events.some(event => event.type === 'turn/start'))
  assert.ok(events.some(event => event.type === 'turn/end'))
  assert.equal(world.requests.length, count)
  world.define(true, true, 'AFTER_CANCEL')
  await world.runtime.refresh()
  const next = await world.send(agent, 'AFTER')
  assert.ok(next.body.system.includes('AFTER_CANCEL') && !next.body.system.includes('CANCELLED_BODY'))
  const arrived = world.nextRequest(), beforeHeld = world.requests.length
  world.responses.push(() => {})
  const held = world.send(agent, 'CANCEL_IN_FLIGHT')
  await deadline(arrived)
  agent.cancel('user')
  await held
  assert.equal(world.requests.length, beforeHeld + 1)
  assert.equal(agent.session.snapshotEvents().at(-1).type, 'turn/end')
  world.define(true, true, 'AFTER_IN_FLIGHT_CANCEL')
  await world.runtime.refresh()
  const resumed = await world.send(agent, 'RESUMED')
  assert.ok(resumed.body.system.includes('AFTER_IN_FLIGHT_CANCEL'))
  await world.runtime.dispose()
  const released = await world.send(agent, 'RUNTIME_RELEASED')
  assert.ok(released.body.messages.some(message => message.role === 'system' && !textOf(message.content).includes('QUALIFIED')))
})

test('Messages发行目标不可读时局部暂停BODY，无关规则仍经真实HTTP执行', async t => {
  if (process.env.PT25_MISSING_TARGET) {
    const world = await fixture(t), agent = await world.agent('pt25-missing-target')
    world.define(true)
    await world.runtime.refresh()
    const request = await world.send(agent, 'UNAVAILABLE')
    assert.ok(request.body.system.includes('BODY_A'))
    assert.ok(!JSON.stringify(request.body).includes('QUALIFIED'))
    return
  }
  const preload = `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module'; const read = fs.readFileSync; fs.readFileSync = function(file, ...args) { if (String(file).replaceAll('\\\\','/').endsWith('dsh-llm-deepseek/lib/index.js') && new Error().stack.includes('at configure')) { const error = new Error('missing Messages fixture'); error.code = 'ENOENT'; throw error; } return read.call(this, file, ...args); }; syncBuiltinESMExports();`
  const env = { ...process.env, PT25_MISSING_TARGET: '1' }
  delete env.NODE_TEST_CONTEXT
  const child = spawnSync(process.execPath, [...process.execArgv, '--import', 'data:text/javascript,' + encodeURIComponent(preload), '--test', '--test-concurrency=1', '--test-name-pattern=Messages发行目标不可读', fileURLToPath(import.meta.url)], { env, encoding: 'utf8', timeout: 30000 })
  assert.equal(child.status, 0, child.stdout + child.stderr)
})
