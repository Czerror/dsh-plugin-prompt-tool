import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
await import('../../engine/provider-system-roles-early.mjs')
await import('../../engine/request-budget-early.mjs')
const { createAgentAssembly } = await import('../../src/runtime/agent-assembly.ts')

const { providerSystemRolesStatus } = await import('../../engine/provider-system-roles.mjs')
const require = createRequire(import.meta.url), peer = createRequire(require.resolve('@deepseek-ai/dsh-agent-loop'))
const load = name => import(pathToFileURL(peer.resolve('@deepseek-ai/' + name)).href)
const [{ default: Llm, createUserMessage }, { default: Agents }, { default: Prompt }, { default: Sessions }, { default: Projections }, { default: Loop }, { default: Tools }, Native, Persistence] = await Promise.all([
  load('dsh-llm'), load('dsh-agent'), load('dsh-system-prompt'), load('dsh-session'), load('dsh-session-projection'), load('dsh-agent-loop'), load('dsh-tools'), load('dsh-tool-executor-native'), load('dsh-session-persistence-jsonl'),
])
const { PiAiAdapter } = await import('@deepseek-ai/dsh-llm-pi-ai')
const adapterRequire = createRequire(require.resolve('@deepseek-ai/dsh-llm-pi-ai'))
const piRoot = join(realpathSync(join(dirname(adapterRequire.resolve('@deepseek-ai/dsh-llm-pi-ai')), '../../../@earendil-works/pi-ai')), 'dist')
const protocols = Object.fromEntries(await Promise.all(['anthropic-messages', 'openai-completions'].map(async api => [api, await import(pathToFileURL(join(piRoot, 'api', api + '.js')).href)])))
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
      ] : [
        { choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } },
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
