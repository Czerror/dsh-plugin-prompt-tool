import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createAgentAssembly } from '../../src/runtime/agent-assembly.ts'
import { registerSettingsBridge } from '../../src/runtime/settings-bridge.ts'
import { registerRewind } from '../../src/runtime/routes/rewind.ts'
import { BRIDGE_ENDPOINTS } from '../../src/shared/bridge-contract.ts'

const require = createRequire(import.meta.url)
const peer = createRequire(require.resolve('@deepseek-ai/dsh-agent-loop'))
const load = name => import(pathToFileURL(peer.resolve(name)).href)
const [{ default: Llm, LlmAdapter, createUserMessage }, { default: Agents }, { default: Prompt }, { default: Sessions }, { default: Projections }, { default: Loop }, { default: Tools }, Native] = await Promise.all([
  load('@deepseek-ai/dsh-llm'), load('@deepseek-ai/dsh-agent'), load('@deepseek-ai/dsh-system-prompt'),
  load('@deepseek-ai/dsh-session'), load('@deepseek-ai/dsh-session-projection'), load('@deepseek-ai/dsh-agent-loop'), load('@deepseek-ai/dsh-tools'), load('@deepseek-ai/dsh-tool-executor-native'),
])

test('回退会话适配随最后一个 Agent 释放，重挂不覆盖第三方方法', async () => {
  const { Session } = await load('@deepseek-ai/dsh-session')
  const session = Session.create('rewind-lifecycle'), original = session.deriveMessages
  const handlers = new Map()
  const ctx = { agents: { list: () => [] }, on(name, handler) { handlers.set(name, handler); return () => {} }, get() {}, logger: { warn() {} } }
  const disposers = registerRewind({ agentScope: ctx, registerAgentRoute: () => () => {} })
  try {
    const first = { session }, second = { session }
    handlers.get('agent/created')({ agent: first })
    const wrapped = session.deriveMessages
    handlers.get('agent/created')({ agent: second })
    handlers.get('agent/disposed')({ agent: first })
    assert.equal(session.deriveMessages, wrapped, '同一 Session 仍有所有者时保留适配')
    handlers.get('agent/disposed')({ agent: second })
    assert.equal(session.deriveMessages, original, '最后一个所有者释放即恢复方法')
    handlers.get('agent/created')({ agent: first })
    const thirdParty = () => []
    session.deriveMessages = thirdParty
    handlers.get('agent/disposed')({ agent: first })
    assert.equal(session.deriveMessages, thirdParty, '不覆盖后来安装的第三方方法')
  } finally { for (const dispose of disposers) dispose() }
})
class Capture extends LlmAdapter {
  async resolveModel(provider, id) { return { provider, id, name: id } }
  async *stream() {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ANSWER' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
async function post(handlers, body) {
  const handler = handlers.get('/api/prompt-tool/settings' + BRIDGE_ENDPOINTS.rewind)
  assert.ok(handler, '会话回退公共 bridge 已注册')
  let status, payload
  await handler({ method: 'POST', socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'localhost' },
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) } }, {
    writeHead(value) { status = value }, end(value) { payload = JSON.parse(value) },
  })
  return { status, payload }
}

test('回退 bridge：真实 Agent 按输入身份提交且幂等，旧事件保全、陈旧边界拒绝', { timeout: 15000 }, async t => {
  const root = new Context(), handlers = new Map(), capture = new Capture()
  const home = mkdtempSync(join(tmpdir(), 'pt26-')), moduleRoot = join(home, 'modules'), moduleDir = join(moduleRoot, 'rewind')
  mkdirSync(moduleDir, { recursive: true })
  const definition = { id: 'rewind', modules: ['rule-engine'], rules: [{ id: 'rewind', then: [{ id: 'rewind', kind: 'host-control', capability: 'session-rewind', value: true }] }] }
  writeFileSync(join(moduleDir, 'module.yml'), JSON.stringify(definition))
  for (const plugin of [Llm, Sessions, Projections, Prompt, Tools, Native, Agents]) await root.plugin(plugin)
  await root.plugin(Loop, { agents: [] })
  root.provide('workingDirectory', { get: () => process.cwd(), ensure: async () => process.cwd(), set: async () => process.cwd() })
  root.provide('webServer', { register({ path, handler }) { handlers.set(path, handler); return () => handlers.delete(path) } })
  root.provide('remoteAccess', { decide: ({ principal }) => ({ kind: principal.kind === 'owner' ? 'allow' : 'deny' }) })
  root.llm.registerAdapter(['local'], capture)
  registerSettingsBridge(root, { ns: 'prompt-tool', models: () => ({ available: true, providers: [] }) })
  const warnings = []
  const assembly = createAgentAssembly(root, { moduleRoot, enabledModules: () => ['rewind'], warn: value => warnings.push(value) })
  await assembly.settled()
  const handle = await root.agents.create({ sessionId: 'pt26-repeated', agentOptions: { provider: 'local', model: 'probe' } })
  t.after(async () => { await assembly.dispose(); await handle.dispose(); await root.fiber.dispose(); rmSync(home, { recursive: true, force: true }) })
  const send = async text => {
    const message = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
    handle.agent.followup(message)
    await handle.agent.whenIdle()
    return message
  }
  const a = await send('再检查一次'), b = await send('再检查一次')
  const before = handle.agent.session.snapshotEvents()
  const preview = await post(handlers, { phase: 'preview', sessionId: handle.agent.id, mode: 'once', requestId: 'repeat-1', credential: 'invalid' })
  assert.equal(preview.status, 403, '没有真实页面凭据不能写任意已知 session')
  assert.deepEqual(handle.agent.session.snapshotEvents(), before)
  assert.notEqual(a.id, b.id)
  const table = []
  root.emit('webserver/index-inject', table, { principal: { kind: 'owner' } })
  const credential = table.find(row => row.name === '__PROMPT_TOOL_REWIND__').value
  const request = { phase: 'preview', sessionId: handle.agent.id, mode: 'once', requestId: 'repeat-1', credential }
  const unknown = await post(handlers, { ...request, childIds: ['other'] })
  assert.equal(unknown.status, 400, '客户端不能提交额外子目标')
  assert.deepEqual(handle.agent.session.snapshotEvents(), before)
  const prepared = await post(handlers, request)
  assert.equal(prepared.status, 200, JSON.stringify({ payload: prepared.payload, warnings }))
  const committed = await post(handlers, { ...request, phase: 'commit', boundary: prepared.payload.value.boundary })
  assert.equal(committed.status, 200, JSON.stringify(committed.payload))
  assert.equal(committed.payload.value.targets[0].status, 'committed', JSON.stringify(committed.payload))
  assert.equal(committed.payload.value.targets[0].text, '再检查一次')
  const events = handle.agent.session.snapshotEvents()
  assert.deepEqual(events.slice(0, before.length), before)
  assert.equal(events.length, before.length + 1)
  assert.deepEqual(handle.agent.session.deriveMessages().filter(message => message.source.kind === 'user').map(message => message.id), [a.id])
  assert.deepEqual(await post(handlers, { ...request, phase: 'commit', boundary: prepared.payload.value.boundary }), committed)
  assert.equal(handle.agent.session.snapshotEvents().length, events.length)
  await send('新轮')
  const stale = await post(handlers, { ...request, requestId: 'stale' })
  await send('后来新输入')
  const afterNewInput = handle.agent.session.snapshotEvents()
  const rejected = await post(handlers, { ...request, requestId: 'stale', phase: 'commit', boundary: stale.payload.value.boundary })
  assert.equal(rejected.status, 409)
  assert.deepEqual(handle.agent.session.snapshotEvents(), afterNewInput, '陈旧边界不能改选后来新轮')
})
