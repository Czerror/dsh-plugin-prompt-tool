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
import { BRIDGE_ENDPOINTS } from '../../src/shared/bridge-contract.ts'

const require = createRequire(import.meta.url)
const peer = createRequire(require.resolve('@deepseek-ai/dsh-agent-loop'))
const load = name => import(pathToFileURL(peer.resolve(name)).href)
const [{ default: Llm, LlmAdapter, createUserMessage }, { default: Agents }, { default: Prompt }, { default: Sessions }, { default: Projections }, { default: Loop }, { default: Tools }, Native] = await Promise.all([
  load('@deepseek-ai/dsh-llm'), load('@deepseek-ai/dsh-agent'), load('@deepseek-ai/dsh-system-prompt'),
  load('@deepseek-ai/dsh-session'), load('@deepseek-ai/dsh-session-projection'), load('@deepseek-ai/dsh-agent-loop'), load('@deepseek-ai/dsh-tools'), load('@deepseek-ai/dsh-tool-executor-native'),
])
class Capture extends LlmAdapter {
  requests = []
  hold = false
  entered = Promise.withResolvers()
  async resolveModel(provider, id) { return { provider, id, name: id } }
  async *stream(request) {
    this.requests.push(request)
    if (this.hold) {
      this.entered.resolve()
      await new Promise((_, reject) => {
        if (request.signal.aborted) reject(request.signal.reason)
        else request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true })
      })
    }
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

test('回退 bridge：真实 Agent 的重复提问按输入身份回退，durable 保全且后续 request 无空 marker', { timeout: 15000 }, async t => {
  const root = new Context(), handlers = new Map(), capture = new Capture()
  const home = mkdtempSync(join(tmpdir(), 'pt26-')), moduleRoot = join(home, 'modules'), moduleDir = join(moduleRoot, 'rewind')
  mkdirSync(moduleDir, { recursive: true })
  writeFileSync(join(moduleDir, 'module.yml'), JSON.stringify({ id: 'rewind', modules: ['rule-engine'], rules: [{ id: 'rewind', then: [{ id: 'rewind', kind: 'host-control', capability: 'session-rewind', value: true }] }] }))
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
  const replayed = await root.agents.create({ sessionId: 'pt26-cold-replay', seed: events, agentOptions: { provider: 'local', model: 'probe' } })
  t.after(() => replayed.dispose())
  assert.deepEqual(replayed.agent.session.deriveMessages().filter(message => message.source.kind === 'user').map(message => message.id), [a.id], '冷重放无需预览也解释既有 marker')
  replayed.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '冷重放后新输入' }] }))
  await replayed.agent.whenIdle()
  assert.equal(capture.requests.at(-1).messages.some(message => message.id.startsWith('rewind-pt-') || message.id === b.id), false)
  assert.deepEqual(events.slice(0, before.length), before)
  assert.equal(events.length, before.length + 1)
  assert.deepEqual(handle.agent.session.deriveMessages().filter(message => message.source.kind === 'user').map(message => message.id), [a.id])
  assert.deepEqual(await post(handlers, { ...request, phase: 'commit', boundary: prepared.payload.value.boundary }), committed)
  assert.equal(handle.agent.session.snapshotEvents().length, events.length)
  const next = { ...request, requestId: 'repeat-2' }
  const nextPreview = await post(handlers, next)
  assert.equal(nextPreview.status, 200, JSON.stringify(nextPreview.payload))
  const nextCommit = await post(handlers, { ...next, phase: 'commit', boundary: nextPreview.payload.value.boundary })
  assert.equal(nextCommit.payload.value.targets[0].status, 'committed')
  assert.deepEqual(handle.agent.session.deriveMessages().filter(message => message.source.kind === 'user'), [])
  await send('新轮')
  const last = capture.requests.at(-1)
  assert.equal(last.messages.some(message => message.id === b.id), false)
  assert.equal(last.messages.some(message => message.id.startsWith('rewind-pt-')), false)
  assert.equal(last.messages.some(message => message.id === a.id), false)
  const stale = await post(handlers, { ...request, requestId: 'stale' })
  await send('后来新输入')
  const afterNewInput = handle.agent.session.snapshotEvents()
  const rejected = await post(handlers, { ...request, requestId: 'stale', phase: 'commit', boundary: stale.payload.value.boundary })
  assert.equal(rejected.status, 409)
  assert.deepEqual(handle.agent.session.snapshotEvents(), afterNewInput, '陈旧边界不能改选后来新轮')
  capture.hold = true
  const running = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '取消这一轮' }] })
  handle.agent.followup(running); await capture.entered.promise
  const runningRequest = { ...request, requestId: 'running' }
  const runningPreview = await post(handlers, runningRequest)
  capture.hold = false
  const stopped = await post(handlers, { ...runningRequest, phase: 'commit', boundary: runningPreview.payload.value.boundary })
  assert.equal(stopped.payload.value.targets[0].status, 'committed', JSON.stringify(stopped.payload))
  assert.equal(handle.agent.session.deriveMessages().some(message => message.id === running.id), false)
  const maintenance = handle.agent.runMaintenance
  const queued = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '维护中排队的新输入' }] })
  handle.agent.runMaintenance = task => maintenance.call(handle.agent, async signal => {
    handle.agent.followup(queued)
    return task(signal)
  })
  const queuedRequest = { ...request, requestId: 'queued' }
  const queuedPreview = await post(handlers, queuedRequest)
  const queuedResult = await post(handlers, { ...queuedRequest, phase: 'commit', boundary: queuedPreview.payload.value.boundary })
  handle.agent.runMaintenance = maintenance
  assert.equal(queuedResult.payload.value.targets[0].status, 'committed', JSON.stringify(queuedResult.payload))
  await handle.agent.whenIdle()
  assert.ok(handle.agent.session.deriveMessages().some(message => message.id === queued.id), '维护中排队输入仍由官方正常接受，不属于被撤范围')
  const now = Date.now
  try {
    Date.now = () => now() + 11 * 60_000
    assert.equal((await post(handlers, request)).status, 403, '过期页面凭据不再授权')
  } finally { Date.now = now }
})

test('回退上一轮沿真实子代理启动与官方目录固定主子目标，保留旧主轮', { timeout: 15000 }, async t => {
  const root = new Context(), handlers = new Map(), home = mkdtempSync(join(tmpdir(), 'pt26-round-'))
  const moduleRoot = join(home, 'modules'), moduleDir = join(moduleRoot, 'rewind')
  mkdirSync(moduleDir, { recursive: true })
  writeFileSync(join(moduleDir, 'module.yml'), JSON.stringify({ id: 'rewind', modules: ['rule-engine'], rules: [{ id: 'rewind', then: [{ id: 'rewind', kind: 'host-control', capability: 'session-rewind', value: true }] }] }))
  const [Persistence, { default: Subagents }, Spawn, Tool] = await Promise.all([load('@deepseek-ai/dsh-session-persistence-jsonl'), load('@deepseek-ai/dsh-subagent'), import('@deepseek-ai/dsh-subagent-spawn-in-process'), import('@deepseek-ai/dsh-tool-subagent')])
  for (const plugin of [Llm, Sessions, Projections, Prompt, Tools, Native, Agents]) await root.plugin(plugin)
  await root.plugin(Persistence, { root: join(home, 'sessions'), compression: 'none' })
  await root.plugin(Loop, { agents: [] })
  root.provide('workingDirectory', { get: () => home, ensure: async () => home, set: async () => home })
  root.provide('webServer', { register({ path, handler }) { handlers.set(path, handler); return () => handlers.delete(path) } })
  root.provide('remoteAccess', { decide: () => ({ kind: 'allow' }) })
  await root.plugin(Subagents); await root.plugin(Spawn, { providerName: 'spawn' }); await root.plugin(Tool, { provider: 'spawn' })
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), childRelease = Promise.withResolvers()
  class RoundCapture extends Capture {
    async *stream(request) {
      if (request.sessionId !== 'round-parent') await childRelease.promise
      if (request.sessionId === 'round-parent' && request.messages.some(message => message.content.some(block => block.text === '主轮二'))) { entered.resolve(); await release.promise }
      yield* super.stream(request)
    }
  }
  const roundCapture = new RoundCapture()
  root.llm.registerAdapter(['local'], roundCapture)
  registerSettingsBridge(root, { ns: 'prompt-tool', models: () => ({ available: true, providers: [] }) })
  const assembly = createAgentAssembly(root, { moduleRoot, enabledModules: () => ['rewind'], warn: () => {} })
  await assembly.settled()
  const handle = await root.agents.create({ sessionId: 'round-parent', agentOptions: { provider: 'local', model: 'probe' }, meta: { cwd: home } })
  t.after(async () => { release.resolve(); childRelease.resolve(); await root.subagents.drainDescendants([handle.agent]); await assembly.dispose(); await handle.dispose(); await root.fiber.dispose(); rmSync(home, { recursive: true, force: true }) })
  const message = text => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
  const old = message('旧主轮'), current = message('主轮二'), second = message('同轮第二输入')
  handle.agent.followup(old); await handle.agent.whenIdle()
  handle.agent.followup(current); await entered.promise
  handle.agent.steer(second)
  const context = { agent: handle.agent, signal: new AbortController().signal }
  const toolSet = await handle.agent.ctx.tools.resolve(context)
  t.after(() => toolSet.dispose())
  await handle.agent.ctx.systemPrompt.assemble({ ...context, toolSet })
  const spawned = await handle.agent.ctx.tools.execute({ ...context, toolSet, calls: [{ type: 'tool-call', id: 'spawn-round', name: 'subagent', arguments: JSON.stringify({ name: 'reviewer', description: 'round fixture', prompt: '子轮输入' }) }] })
  assert.equal(spawned.results[0].result.isError, false, JSON.stringify(spawned))
  const childId = root.sessionProjections.snapshot(handle.agent.session).values.subagentCatalog.find(entry => entry.name === 'reviewer').id
  let child = root.agents.get(childId)
  assert.ok(child)
  release.resolve(); await handle.agent.whenIdle()
  const settled = Promise.withResolvers()
  const stopListening = root.on('subagent/end', info => { if (info.id === childId) settled.resolve() })
  t.after(stopListening)
  childRelease.resolve(); await settled.promise; await handle.agent.whenIdle()
  const history = handle.agent.session.snapshotEvents()
  const turnOf = input => history.findLast(event => event.type === 'turn/start' && event.seq < history.find(event => event.data?.id === input.id).seq).seq
  assert.equal(turnOf(current), turnOf(second), '夹具经真实 inbox 在同一轮接受两个输入')
  const notification = history.find(event => event.type === 'user/message' && event.data.source.kind === 'subagent-settled')
  assert.ok(notification, '真实官方子代理完成投递通知')
  assert.ok(history.findLast(event => event.type === 'turn/start').seq > history.find(event => event.data?.id === second.id).seq, '完成通知在无新增用户输入的后续自动轮接受')
  const table = []; root.emit('webserver/index-inject', table, { principal: { kind: 'owner' } })
  const credential = table.find(row => row.name === '__PROMPT_TOOL_REWIND__').value
  const request = { phase: 'preview', sessionId: handle.agent.id, mode: 'round', requestId: 'round-1', credential }
  const requestsBeforePreview = roundCapture.requests.length
  const preview = await post(handlers, request)
  assert.equal(preview.status, 200, JSON.stringify(preview.payload))
  child = root.agents.get(childId)
  assert.ok(child, '已完成子会话通过官方恢复为本次维护驻留')
  assert.equal(roundCapture.requests.length, requestsBeforePreview, '预览恢复不调用模型')
  assert.deepEqual(preview.payload.value.targets.map(target => target.sessionId), ['round-parent', childId])
  const before = [handle.agent, child].map(agent => agent.session.snapshotEvents())
  const maintenance = child.runMaintenance
  child.runMaintenance = () => { throw new Error('子会话维护暂不可用') }
  const committed = await post(handlers, { ...request, phase: 'commit', boundary: preview.payload.value.boundary })
  assert.deepEqual(committed.payload.value.targets.map(target => target.status), ['committed', 'failed'], JSON.stringify(committed.payload))
  assert.equal(committed.payload.value.targets[0].text, '主轮二\n\n同轮第二输入', '整轮按接受顺序回填全部真实用户原文，不含子代理或自动通知')
  const mainLength = handle.agent.session.snapshotEvents().length
  child.runMaintenance = maintenance
  const retry = { ...request, phase: 'retry', boundary: preview.payload.value.boundary, requestId: 'retry-child' }
  const retried = await post(handlers, retry)
  assert.deepEqual(retried.payload.value.targets.map(target => target.status), ['committed', 'committed'], JSON.stringify(retried.payload))
  assert.equal(retried.payload.value.targets[0].text, '主轮二\n\n同轮第二输入', '部分失败重试保留已提交主轮的完整回填')
  assert.ok(retried.payload.value.targets[1].text.startsWith('子轮输入'), '子会话回填自己的官方输入')
  assert.equal(retried.payload.value.targets[1].text.includes('主轮二'), false, '子会话不混入父轮原文')
  assert.equal(handle.agent.session.snapshotEvents().length, mainLength, '已提交主会话绝不重复回退')
  assert.deepEqual(await post(handlers, retry), retried)
  assert.equal(root.agents.get(childId), undefined, '成功后释放本次恢复的子会话驻留')
  const persistedChild = await root.sessionPersistence.open(childId, 'read')
  try {
    const persisted = await persistedChild.read(0)
    assert.ok(persisted.events.some(event => event.data?.id === retried.payload.value.targets[1].markerId), '释放维护驻留后官方持久层已刷盘回退标记')
  } finally { await persistedChild.close() }
  assert.deepEqual(handle.agent.session.deriveMessages().filter(message => message.source.kind === 'user').map(message => message.id), [old.id])
  for (const [index, agent] of [handle.agent, child].entries()) assert.deepEqual(agent.session.snapshotEvents().slice(0, before[index].length), before[index])
  const next = message('回退后新轮')
  const staleRequest = { ...request, requestId: 'round-stale' }
  const stalePreview = await post(handlers, staleRequest)
  assert.equal(stalePreview.status, 200, JSON.stringify(stalePreview.payload))
  handle.agent.followup(next); await handle.agent.whenIdle()
  assert.equal((await post(handlers, { ...staleRequest, phase: 'commit', boundary: stalePreview.payload.value.boundary })).status, 409, '预览后真实新用户轮拒绝陈旧边界')
  assert.deepEqual(roundCapture.requests.at(-1).messages.filter(row => row.source.kind === 'user').map(row => row.id), [old.id, next.id], '后续真实模型请求保留前轮与新轮，整轮两个输入均撤回')
  await handle.dispose()
  const reopened = await root.agents.resume({ resumeSessionId: 'round-parent', agentOptions: { provider: 'local', model: 'probe' } })
  t.after(() => reopened.dispose())
  assert.deepEqual(reopened.agent.session.deriveMessages().filter(row => row.source.kind === 'user').map(row => row.id), [old.id, next.id], 'JSONL重新打开仍保留同一可见历史')
})
