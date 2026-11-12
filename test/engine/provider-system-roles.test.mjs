import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
await import('../../engine/provider-system-roles-early.mjs')
await import('../../engine/request-budget-early.mjs')
const { createAgentAssembly } = await import('../../src/runtime/agent-assembly.ts')
const { compileRules } = await import('../../engine/rule-spec.mjs')
const { providerSystemRolesStatus, providerSystemRolesBridge } = await import('../../engine/provider-system-roles.mjs')
const require = createRequire(import.meta.url), peer = createRequire(require.resolve('@deepseek-ai/dsh-agent-loop'))
const load = name => import(pathToFileURL(peer.resolve('@deepseek-ai/' + name)).href)
const [{ default: Llm, createUserMessage, createSystemMessage, createDeveloperMessage }, { default: Agents, assembleContextFor }, { default: Prompt }, { default: Sessions }, { default: Projections }, { default: Loop }, { default: Tools }, Native, Persistence] = await Promise.all([
  load('dsh-llm'), load('dsh-agent'), load('dsh-system-prompt'), load('dsh-session'), load('dsh-session-projection'), load('dsh-agent-loop'), load('dsh-tools'), load('dsh-tool-executor-native'), load('dsh-session-persistence-jsonl'),
])
const { PiAiAdapter } = await import('@deepseek-ai/dsh-llm-pi-ai')
const adapterRequire = createRequire(require.resolve('@deepseek-ai/dsh-llm-pi-ai'))
const piRoot = join(realpathSync(join(dirname(adapterRequire.resolve('@deepseek-ai/dsh-llm-pi-ai')), '../../../@earendil-works/pi-ai')), 'dist')
const protocols = Object.fromEntries(await Promise.all(['anthropic-messages', 'openai-completions', 'openai-responses'].map(async api => [api, await import(pathToFileURL(join(piRoot, 'api', api + '.js')).href)])))
const identity = "You are Claude Code, Anthropic's official CLI for Claude."
const deadline = async promise => {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('provider request timeout')), 10000) })]) }
  finally { clearTimeout(timer) }
}
const textOf = content => content?.map(block => block.text ?? '').join('') ?? ''
async function fixture(t, api = 'anthropic-messages', logical = 'https://anthropic.test/v1', reasoning = false, compat = {}) {
  const requests = [], responses = [], root = new Context(), home = mkdtempSync(join(tmpdir(), 'pt24-')), moduleRoot = join(home, 'modules'), moduleDir = join(moduleRoot, 'provider')
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    requests.push({ path: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString()) })
    const respond = () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const events = api === 'anthropic-messages' ? [
        { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'probe', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 3, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'OK' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }, { type: 'message_stop' },
      ] : api === 'openai-completions' ? [
        { choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } },
      ] : [
        { type: 'response.created', response: { id: 'resp_1', object: 'response', status: 'in_progress', output: [] } },
        { type: 'response.output_item.added', output_index: 0, item: { id: 'msg_1', type: 'message', role: 'assistant', content: [] } },
        { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'OK' },
        { type: 'response.output_item.done', output_index: 0, item: { id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'OK', annotations: [] }] } },
        { type: 'response.completed', response: { id: 'resp_1', object: 'response', status: 'completed', output: [{ id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'OK', annotations: [] }] }], usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 } } },
      ]
      for (const event of events) res.write((api === 'openai-completions' ? '' : 'event: ' + event.type + String.fromCharCode(10)) + 'data: ' + JSON.stringify(event) + String.fromCharCode(10, 10))
      res.end(api === 'openai-completions' ? 'data: [DONE]' + String.fromCharCode(10, 10) : '')
    }
    const behavior = responses.shift()
    if (behavior === undefined) respond(); else behavior(respond, req, res)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const local = 'http://127.0.0.1:' + server.address().port
  const model = { id: 'probe', name: 'Probe', provider: 'fixture', api, baseUrl: logical, reasoning, input: ['text'], contextWindow: 32768, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat }
  // The real adapter accepts a public PI Provider. Only its public per-call
  // fetch transport is redirected; model identity and the serializer stay real.
  const piProvider = { id: 'fixture', name: 'Fixture', baseUrl: logical, auth: { apiKey: { name: 'Fixture', resolve: async ({ credential }) => ({ auth: { apiKey: credential?.key ?? 'sk-test-local' } }) } }, getModels: () => [model],
    streamSimple: (model, context, options) => protocols[api].streamSimple(model, context, { ...options, fetch: (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input.url)
      return fetch(typeof input === 'string' ? local + url.pathname + url.search : new Request(local + url.pathname + url.search, input), init)
    } }),
  }
  const profiles = new Map([['fixture', { provider: 'fixture', displayName: 'Fixture', piProvider, modelErrors: new Map(), configuredMaxTokens: new Map(), streamIdleTimeoutMs: 10000, cacheRetention: 'short' }]])
  let key = api === 'anthropic-messages' ? 'sk-ant-oat-local-fixture' : 'sk-test-local'
  const adapter = new PiAiAdapter({ profiles: () => profiles, resolveApiKey: async () => key, auth: { credentials: { read: async () => undefined }, authContext: { env: async () => undefined, fileExists: async () => false } } })
  mkdirSync(moduleDir, { recursive: true })
  const define = (enabled = true, audience = 'main', body = 'KEEP BODY') => writeFileSync(join(moduleDir, 'module.yml'), JSON.stringify({ id: 'provider', modules: ['rule-engine'], rules: [
    { id: 'identity', enabled, if: { scope: { audience } }, then: [{ id: 'identity', kind: 'host-control', capability: api === 'anthropic-messages' ? 'oauth-identity-prefix' : 'provider-system-role', value: true }, { id: 'dependent', kind: 'inject-text', config: { layer: 'system-section', order: 2, text: 'QUALIFIED' } }] },
    { id: 'body', enabled: true, then: [{ id: 'body', kind: 'inject-text', config: { layer: 'system-section', order: 3, text: body } }] },
  ] }))
  define(false)
  for (const plugin of [Llm, Sessions, Projections, Prompt, Tools, Native, Agents]) await root.plugin(plugin)
  await root.plugin(Persistence, { root: join(home, 'sessions'), compression: 'none' })
  root.tools.register({ name: 'FixtureTool', description: 'KEEP TOOL', parameters: { type: 'object', properties: { value: { type: 'string' } } }, output: { schema: { type: 'string' }, render: () => [] }, execute: () => 'unused' })
  await root.plugin(Loop, { agents: [] })
  root.provide('workingDirectory', { get: () => home, ensure: async () => home, set: async () => home })
  const registration = root.llm.registerAdapter(['fixture'], adapter)
  const outcomes = []
  const runtime = createAgentAssembly(root, { moduleRoot, enabledModules: () => ['provider'], onOutcome: outcome => outcomes.push(outcome) })
  await runtime.settled()
  const handles = []
  const agent = async (id, child = false) => {
    const handle = await root.agents.create({ sessionId: id, agentOptions: { provider: 'fixture', model: 'probe' }, meta: { cwd: home, ...(child ? { origin: 'subagent', delegationDepth: 1 } : {}) } })
    handles.push(handle)
    return handle.agent
  }
  const send = async (agent, text = 'U') => {
    const start = requests.length
    agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
    await deadline(agent.whenIdle())
    const request = requests.slice(start).find(request => JSON.stringify(request.body).includes(text))
    assert.ok(request, JSON.stringify(outcomes))
    return request
  }
  t.after(async () => { await runtime.dispose(); for (const handle of handles) await handle.dispose(); await root.fiber.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(home, { recursive: true, force: true }) })
  return { root, runtime, adapter, registration, agent, send, define, requests, responses, outcomes, setKey: value => { key = value }, model }
}

test('请求身份首段与角色映射使用独立普通动作，拒绝次数预算', () => {
  for (const capability of ['oauth-identity-prefix', 'provider-system-role']) {
    const rules = [{ id: capability, then: [{ id: 'control', kind: 'host-control', capability, value: true }] }]
    assert.equal(compileRules(rules).length, 1)
    assert.throws(() => compileRules([{ id: 'bad', then: [{ id: 'control', kind: 'host-control', capability, value: true, maxPerTurn: 1 }] }]), /maxPerTurn/)
  }
})

test('一个provider目标读取失败不阻断另一能力的真实HTTP请求', async t => {
  if (process.env.PT24_MISSING_TARGET) {
    const missingOAuth = process.env.PT24_MISSING_TARGET === 'anthropic-messages.js'
    for (const api of missingOAuth ? ['openai-completions', 'openai-responses'] : ['anthropic-messages']) {
      const world = await fixture(t, api, 'https://third-party.test/v1', true, { supportsDeveloperRole: true }), agent = await world.agent('pt24-isolated-' + api)
      world.define(true)
      await world.runtime.refresh()
      const request = await world.send(agent, 'isolated-provider')
      if (missingOAuth) assert.equal((request.body.messages ?? request.body.input)[0].role, 'system', JSON.stringify(world.outcomes))
      else assert.equal(request.body.system.length, 1, JSON.stringify(world.outcomes))
      assert.equal(providerSystemRolesStatus(agent, missingOAuth ? 'oauth-identity-prefix' : 'provider-system-role', agent.model.current()).available, false)
      assert.ok(JSON.stringify(request.body).includes('QUALIFIED'))
    }
    return
  }
  const preload = `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module'; const read = fs.readFileSync; fs.readFileSync = function(file, ...args) { if (String(file).endsWith(process.env.PT24_MISSING_TARGET) && new Error().stack.includes('at target')) { const error = new Error('missing provider fixture'); error.code = 'ENOENT'; throw error; } return read.call(this, file, ...args); }; syncBuiltinESMExports();`
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  for (const missing of ['anthropic-messages.js', 'openai-responses-shared.js']) {
    const child = spawnSync(process.execPath, [...process.execArgv, '--import', 'data:text/javascript,' + encodeURIComponent(preload), '--test', '--test-concurrency=1', '--test-name-pattern=一个provider目标读取失败', fileURLToPath(import.meta.url)], { env: { ...env, PT24_MISSING_TARGET: missing }, encoding: 'utf8', timeout: 30000 })
    assert.equal(child.status, 0, missing + '\n' + child.stdout + child.stderr)
  }
})

test('OAuth最终HTTP仅移除自动首块，用户同句、headers、工具与日志正文保持', async t => {
  const world = await fixture(t), main = await world.agent('pt24-main')
  const off = await world.send(main, 'off')
  assert.equal(off.body.system[0].text, identity)
  world.define(true, 'main', 'KEEP BODY ' + identity)
  await world.runtime.refresh()
  const on = await world.send(main, 'on')
  assert.ok(on.body.system.length === 1, JSON.stringify(world.outcomes))
  assert.ok(on.body.system[0].text.includes('KEEP BODY ' + identity))
  assert.ok(on.body.system[0].text.includes('QUALIFIED'))
  assert.deepEqual(on.body.tools, off.body.tools)
  assert.deepEqual(on.body.system[0].cache_control, off.body.system[1].cache_control)
  for (const header of ['authorization', 'user-agent', 'x-app', 'anthropic-beta', 'anthropic-version']) assert.equal(on.headers[header], off.headers[header], header)
  const system = main.session.snapshotEvents().findLast(event => event.type === 'system/message')
  assert.equal(on.body.system[0].text, textOf(system.data.message.content))
  const step = main.session.snapshotEvents().findLast(event => event.type === 'step/start')
  assert.deepEqual({ turn: system.data.turn, step: system.data.step }, step.data)
  await world.root.sessions.flush(main.session)
  const persisted = await world.root.sessionPersistence.open(main.id, 'read')
  try { assert.deepEqual((await persisted.read()).events.find(event => event.seq === system.seq), system) }
  finally { await persisted.close() }
  assert.equal(providerSystemRolesStatus(main, 'oauth-identity-prefix', main.model.current()).available, true)
})

test('两条真实OpenAI HTTP序列化路径按精确hostname保留developer，推理和compat门控保持', async t => {
  const cases = [
    ['https://api.openai.com/v1', true, true, 'developer'],
    ['https://a.openai.azure.com/openai', true, true, 'developer'],
    ['https://api.deepseek.com/v1', true, true, 'system'],
    ['https://api.openai.com.evil.test/v1', true, true, 'system'],
    ['https://evilazure.com/v1', true, true, 'system'],
    ['https://proxy.test/v1?upstream=api.openai.com', true, true, 'system'],
    ['https://api.openai.com@proxy.test/v1', true, true, 'system'],
    ['https://api.openai.com/v1', false, true, 'system'],
    ['https://api.openai.com/v1', true, false, 'system'],
  ]
  for (const api of ['openai-completions', 'openai-responses']) for (const [url, reasoning, supportsDeveloperRole, expected] of cases) await t.test(api + ' ' + url + ' ' + reasoning + '/' + supportsDeveloperRole, async t => {
    const world = await fixture(t, api, url, reasoning, { supportsDeveloperRole }), agent = await world.agent('pt24-role')
    world.define(true)
    await world.runtime.refresh()
    const request = await world.send(agent, 'role')
    const messages = request.body.messages ?? request.body.input
    assert.equal(messages[0].role, expected, JSON.stringify(world.outcomes))
    assert.ok(JSON.stringify(messages[0]).includes('QUALIFIED'), JSON.stringify({ status: providerSystemRolesStatus(agent, 'provider-system-role', agent.model.current()), group: world.adapter[Symbol.for('prompt-tool:provider-system-roles-adapter')], outcomes: world.outcomes }))
    const system = agent.session.snapshotEvents().findLast(event => event.type === 'system/message')
    assert.equal(typeof messages[0].content === 'string' ? messages[0].content : textOf(messages[0].content), textOf(system.data.message.content))
    world.define(false)
    await world.runtime.refresh()
    const off = await world.send(agent, 'role-off')
    assert.equal((off.body.messages ?? off.body.input)[0].role, reasoning && supportsDeveloperRole ? 'developer' : 'system')
  })
})

test('OAuth步骤热更、并行主子、缺目标局部暂停及释放保持请求隔离', async t => {
  const world = await fixture(t), main = await world.agent('pt24-lifecycle'), child = await world.agent('pt24-child', true)
  world.define(true)
  await world.runtime.refresh()
  let stopRefresh = world.root.on('agent/request', async (_payload, next) => {
    stopRefresh()
    world.define(false, 'main', 'BEFORE STREAM UPDATE')
    await world.runtime.refresh()
    await main.loopCtx.systemPrompt.assemble({ agent: main, signal: new AbortController().signal })
    return next()
  })
  const frozen = await world.send(main, 'accepted-before-refresh')
  assert.equal(frozen.body.system.length, 1, 'accepted step survives refresh before actual prepare and stream')
  assert.ok(frozen.body.system[0].text.includes('QUALIFIED'))
  const next = await world.send(main, 'later-after-refresh')
  assert.equal(next.body.system[0].text, identity)
  const beforeAbort = world.requests.length
  stopRefresh = world.root.on('agent/request', async (_payload, invoke) => { stopRefresh(); main.cancel('user'); return invoke() })
  main.followup(createUserMessage({ content: [{ type: 'text', text: 'cancel-in-prepare' }], source: { kind: 'user' } }))
  await deadline(main.whenIdle())
  assert.equal(world.requests.length, beforeAbort)
  world.define(true)
  await world.runtime.refresh()
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  world.responses.push(respond => { entered.resolve(); release.promise.then(respond) })
  const pending = world.send(main, 'held')
  await deadline(entered.promise)
  const other = await world.send(child, 'parallel-child')
  assert.equal(other.body.system[0].text, identity)
  assert.equal(world.requests[0].body.system.length, 1)
  world.define(false, 'main', 'NEXT BODY')
  await world.runtime.refresh()
  release.resolve()
  await pending
  const off = await world.send(main, 'after-disable')
  assert.equal(off.body.system[0].text, identity)
  assert.ok(off.body.system[1].text.includes('NEXT BODY'))
  world.define(true)
  await world.runtime.refresh()
  const group = world.adapter[Symbol.for('prompt-tool:provider-system-roles-adapter')], completions = group.completions
  group.completions = undefined
  const independent = await world.send(main, 'independent-oauth')
  assert.equal(independent.body.system.length, 1, 'P47 stays live when unrelated P57 owner is missing')
  group.completions = completions
  world.setKey('sk-local-non-oauth')
  const ordinary = await world.send(main, 'normal-key')
  assert.equal(ordinary.body.system.length, 1)
  assert.ok(ordinary.body.system[0].text.includes('KEEP BODY'))
  world.setKey('sk-ant-oat-local-fixture')
  const beforeCancel = world.requests.length
  main.followup(createUserMessage({ content: [{ type: 'text', text: 'cancel-before-request' }], source: { kind: 'user' } }))
  main.cancel('user')
  await deadline(main.whenIdle())
  assert.equal(world.requests.length, beforeCancel)
  await world.runtime.dispose()
  const released = await world.send(main, 'runtime-disposed')
  assert.equal(released.body.system[0].text, identity)
})

test('Responses真实HTTP保持官方工具增删集合与developer声明，只映射系统正文', async t => {
  const world = await fixture(t, 'openai-responses', 'https://third-party.test/v1', true, { supportsDeveloperRole: true, supportsMidConvoSystemMessages: true, supportsAdditionalTools: true })
  const agent = await world.agent('pt24-tool-notice')
  world.define(true)
  await world.runtime.refresh()
  const selection = { ...agent.model.current() }, context = { ...assembleContextFor(agent, new AbortController().signal), modelSelection: selection }
  context.toolSet = await agent.loopCtx.tools.resolve(context)
  t.after(() => context.toolSet.dispose())
  await agent.loopCtx.systemPrompt.assemble(context)
  const prepared = await providerSystemRolesBridge.prepare(agent, selection, () => world.adapter.prepareCall(selection.provider, selection.model, context.signal))
  const base = { name: 'BaseTool', description: 'KEEP BASE', parameters: { type: 'object', properties: {} } }
  const tool = { name: 'FixtureTool', description: 'KEEP TOOL', parameters: { type: 'object', properties: {} }, deferLoading: true }
  const user = text => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
  const addition = createDeveloperMessage({ source: { kind: 'tool-registry' }, content: [{ type: 'tool-addition', toolName: 'FixtureTool' }] })
  const removal = createDeveloperMessage({ source: { kind: 'tool-registry' }, content: [{ type: 'text', text: 'MIXED BODY' }, { type: 'tool-removal', toolName: 'FixtureTool' }] })
  const request = { ...selection, tools: [base, tool], messages: [createSystemMessage('BASE'), user('one'), addition, user('two')], sessionId: agent.id, signal: context.signal }
  const send = async (call, value) => {
    for await (const chunk of call.stream(value)) assert.notEqual(chunk.type === 'finish' && chunk.reason.kind, 'error', JSON.stringify(chunk))
    return world.requests.at(-1).body
  }
  const added = await send(prepared, request)
  const declarations = added.input.filter(message => message.type === 'additional_tools')
  assert.equal(declarations.length, 1)
  assert.equal(declarations[0].role, 'developer')
  assert.deepEqual(declarations[0].tools.map(item => item.name), ['FixtureTool'])
  assert.deepEqual(added.tools.map(item => item.name), ['BaseTool'])
  assert.equal(added.input.find(message => message.content === 'BASE').role, 'system')
  const removedRequest = { ...request, messages: [...request.messages, removal, user('three')] }
  const removed = await send(prepared, removedRequest)
  assert.deepEqual(removed.tools.map(item => item.name), ['BaseTool'], '初始BaseTool加FixtureTool再移除FixtureTool，仅留下BaseTool')
  assert.equal(removed.input.filter(message => message.type === 'additional_tools').length, 0)
  assert.deepEqual(removed.input.map(message => [message.role, typeof message.content === 'string' ? message.content : textOf(message.content)]), [
    ['system', 'BASE'], ['user', 'one'], ['user', 'two'], ['system', 'MIXED BODY'], ['user', 'three'],
  ])
  world.define(false)
  await world.runtime.refresh()
  const offPrepared = await world.adapter.prepareCall(selection.provider, selection.model, context.signal)
  const off = await send(offPrepared, removedRequest)
  assert.deepEqual(off.tools, removed.tools)
  assert.deepEqual(off.input, removed.input.map(message => message.role === 'system' ? { ...message, role: 'developer' } : message))
  const invalid = { ...request, messages: [createSystemMessage('BASE'), user('one'), createDeveloperMessage({ source: { kind: 'tool-registry' }, content: [{ type: 'tool-addition', toolName: 'MissingTool' }] })] }
  const count = world.requests.length
  await assert.rejects(async () => { for await (const chunk of offPrepared.stream(invalid)) void chunk }, { code: 'INVALID_REQUEST' })
  assert.equal(world.requests.length, count, '未声明工具仍由官方拒绝，不发HTTP')
})

test('compat省略保留两路各自默认，缺一个OpenAI目标仅暂停角色能力与依赖正文', async t => {
  for (const api of ['openai-completions', 'openai-responses']) await t.test(api, async t => {
    const world = await fixture(t, api, 'https://api.deepseek.com/v1', true), agent = await world.agent('pt24-defaults')
    world.define(false)
    const off = await world.send(agent, 'default-off')
    assert.equal((off.body.messages ?? off.body.input)[0].role, api === 'openai-completions' ? 'system' : 'developer')
    world.define(true)
    await world.runtime.refresh()
    const on = await world.send(agent, 'default-on')
    assert.equal((on.body.messages ?? on.body.input)[0].role, 'system')
    const group = world.adapter[Symbol.for('prompt-tool:provider-system-roles-adapter')], original = group.responses
    group.responses = undefined
    const missing = await world.send(agent, 'missing-provider')
    assert.equal((missing.body.messages ?? missing.body.input)[0].role, api === 'openai-completions' ? 'system' : 'developer')
    assert.ok(!JSON.stringify(missing.body).includes('QUALIFIED'))
    assert.equal(providerSystemRolesStatus(agent, 'provider-system-role', agent.model.current()).available, false)
    group.responses = original
    const restored = await world.send(agent, 'restored-provider')
    assert.ok(JSON.stringify(restored.body).includes('QUALIFIED'))
  })
})

test('固定PI缓存与完整Messages请求在身份与角色映射开关后保持官方行为', async t => {
  for (const promptCacheKeyMode of ['enabled', 'disabled']) await t.test('completions ' + promptCacheKeyMode, async t => {
    const world = await fixture(t, 'openai-completions', 'https://third-party.test/v1', true, { supportsDeveloperRole: true, promptCacheKeyMode }), agent = await world.agent('pt24-cache-' + promptCacheKeyMode)
    const off = await world.send(agent, 'cache-off')
    world.define(true)
    await world.runtime.refresh()
    const on = await world.send(agent, 'cache-on')
    assert.equal(off.body.messages[0].role, 'developer')
    assert.equal(on.body.messages[0].role, 'system')
    assert.equal(off.body.prompt_cache_key, undefined)
    assert.equal(on.body.prompt_cache_key, off.body.prompt_cache_key)
  })
  await t.test('anthropic完整请求', async t => {
    const world = await fixture(t, 'anthropic-messages', 'https://anthropic.test/v1', false, { supportsMessageThreads: true }), agent = await world.agent('pt24-threads')
    world.define(true)
    await world.runtime.refresh()
    const on = await world.send(agent, 'thread-on')
    assert.equal(on.body.thread, undefined)
    assert.equal(on.body.system.length, 1)
    world.define(false)
    await world.runtime.refresh()
    const off = await world.send(agent, 'thread-off')
    assert.equal(off.body.thread, undefined)
    assert.equal(off.body.system[0].text, identity)
    assert.deepEqual(off.body.tools, on.body.tools)
    assert.equal(off.headers['anthropic-beta'], on.headers['anthropic-beta'])
    const continued = await world.send(agent, 'thread-continue')
    assert.equal(continued.body.thread, undefined)
    assert.deepEqual(continued.body.system, off.body.system)
    assert.deepEqual(continued.body.tools, off.body.tools)
  })
})

test('adapter注册释放重挂不复活旧prepared身份，原始独立错误传播', async t => {
  const world = await fixture(t), agent = await world.agent('pt24-registration')
  world.define(true)
  await world.runtime.refresh()
  const selection = { ...agent.model.current() }, context = { ...assembleContextFor(agent, new AbortController().signal), modelSelection: selection }
  context.toolSet = await agent.loopCtx.tools.resolve(context)
  t.after(() => context.toolSet.dispose())
  await agent.loopCtx.systemPrompt.assemble(context)
  const prepared = await providerSystemRolesBridge.prepare(agent, selection, () => world.adapter.prepareCall(selection.provider, selection.model, context.signal))
  world.registration()
  world.root.llm.registerAdapter(['fixture'], world.adapter)
  const request = { ...selection, messages: [createSystemMessage('OLD BODY'), createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'old-call' }] })], sessionId: agent.id, signal: context.signal }
  for await (const chunk of prepared.stream(request)) assert.notEqual(chunk.type === 'finish' && chunk.reason.kind, 'error', JSON.stringify(chunk))
  assert.equal(world.requests.at(-1).body.system[0].text, identity)
  assert.equal(world.requests.at(-1).body.system[1].text, 'OLD BODY')
  const error = new Error('independent prepare error')
  assert.throws(() => providerSystemRolesBridge.prepare(agent, selection, () => { throw error }), value => value === error)
})
