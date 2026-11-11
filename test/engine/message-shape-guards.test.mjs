import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { createAgentAssembly } from '../../src/runtime/agent-assembly.ts'
import { messageShapeGuardsStatus } from '../../engine/message-shape-guards.mjs'
await import('../../engine/request-budget-early.mjs')
await import('../../engine/message-shape-guards-early.mjs')

const require = createRequire(import.meta.url), peer = createRequire(require.resolve('@deepseek-ai/dsh-agent-loop'))
const load = name => import(pathToFileURL(peer.resolve(`@deepseek-ai/${name}`)).href)
const [{ default: Llm, LlmAdapter, createUserMessage, createSystemMessage }, { default: Agents }, { default: Prompt, renderPrompt, renderContextSections }, { default: Sessions, deriveEventMessage }, { default: Projections }, Persistence, { default: Loop }, { default: Tools }, Native] = await Promise.all([
  load('dsh-llm'), load('dsh-agent'), load('dsh-system-prompt'), load('dsh-session'), load('dsh-session-projection'), load('dsh-session-persistence-jsonl'), load('dsh-agent-loop'), load('dsh-tools'), load('dsh-tool-executor-native'),
])
class Capture extends LlmAdapter {
  requests = []
  async resolveModel(provider, id) { return { provider, id, name: id } }
  async *stream(request) {
    this.requests.push(request)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'OK' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
const deadline = async promise => {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Agent did not settle')), 10000) })]) }
  finally { clearTimeout(timer) }
}
async function world(t) {
  const root = new Context(), home = mkdtempSync(join(tmpdir(), 'pt23-home-')), moduleRoot = join(home, 'modules'), directory = join(moduleRoot, 'guards'), capture = new Capture()
  mkdirSync(directory, { recursive: true })
  const define = (enabled = true, audience = 'main') => writeFileSync(join(directory, 'module.yml'), JSON.stringify({ id: 'guards', modules: ['rule-engine'], rules: [{ id: 'guards', enabled, if: { scope: { audience } }, then: [{ id: 'shape', kind: 'host-control', capability: 'message-shape-guards', value: true }, { id: 'body', kind: 'inject-text', config: { layer: 'system-section', text: 'BODY' } }] }] }))
  define()
  for (const plugin of [Llm, Sessions, Projections, Prompt, Tools, Native, Agents]) await root.plugin(plugin)
  const { installModelSelection } = await load('dsh-agent')
  const releaseModelSelection = installModelSelection(root)
  await root.plugin(Persistence, { root: join(home, 'sessions'), compression: 'none' })
  await root.plugin(Loop, { agents: [] })
  root.provide('workingDirectory', { get: () => home, ensure: async () => home, set: async () => home })
  root.llm.registerAdapter(['local'], capture)
  const outcomes = []
  const runtime = createAgentAssembly(root, { moduleRoot, enabledModules: () => ['guards'], onOutcome: outcome => outcomes.push(outcome) })
  await runtime.settled()
  const handle = await root.agents.create({ sessionId: 'pt23-main', agentOptions: { provider: 'local', model: 'probe' }, meta: { cwd: home } })
  t.after(async () => { releaseModelSelection(); await runtime.dispose(); await handle.dispose(); await root.fiber.dispose(); rmSync(home, { recursive: true, force: true }) })
  const assemble = async agent => {
    const { assembleContextFor } = await load('dsh-agent')
    const context = { ...assembleContextFor(agent, new AbortController().signal), modelSelection: { ...agent.model.current() } }
    context.toolSet = await agent.loopCtx.tools.resolve(context)
    const assembly = await agent.loopCtx.systemPrompt.assemble(context)
    return { assembly, context, dispose: () => context.toolSet.dispose() }
  }
  const send = async (agent, text = 'U') => { agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })); await deadline(agent.whenIdle()) }
  return { root, runtime, handle, capture, define, assemble, send, outcomes }
}

test('系统段容错通过最终公开 assemble/render 保留合法正文并覆盖 complete 与 refreshContext', async t => {
  const { root, handle, assemble, outcomes } = await world(t)
  const off = root.on('system-prompt/assemble', async (assembly, _context, next) => {
    const result = await next()
    result.sections.push({ name: 'a', text: ' A ', interpolate: false }, { name: 'bad', text: 42 }, { name: 'b', text: 'B', interpolate: false })
    result.contexts.push({ name: 'bad-context', text: false }, { name: 'one', text: 'C' }, { name: 'two', text: ' D ', interpolate: false })
    return result
  })
  t.after(off)
  const accepted = await assemble(handle.agent)
  assert.deepEqual(messageShapeGuardsStatus(handle.agent), { available: true })
  t.after(accepted.dispose)
  assert.match(renderPrompt(accepted.assembly), /BODY/, JSON.stringify(outcomes))
  assert.ok(renderPrompt(accepted.assembly).endsWith([' A ', 'B'].join(String.fromCharCode(10, 10))))
  assert.deepEqual(renderContextSections(accepted.assembly), [{ name: 'one', text: 'C' }, { name: 'two', text: ' D ' }])
  off()
  const removeComplete = handle.agent.loopCtx.systemPrompt.section({ name: 'guard-complete', order: 1, text: () => undefined, complete: true })
  t.after(removeComplete)
  const complete = await assemble(handle.agent)
  t.after(complete.dispose)
  assert.equal(renderPrompt(complete.assembly), '')
  removeComplete()
  const removeContext = handle.agent.loopCtx.systemPrompt.context({ name: 'refresh-bad', order: 1, text: () => false })
  t.after(removeContext)
  const refreshed = await assemble(handle.agent)
  t.after(refreshed.dispose)
  assert.deepEqual(renderContextSections(handle.agent.loopCtx.systemPrompt.refreshContext(refreshed.assembly, refreshed.context)), [])
})

test('缺 messages 的首步和结束判据经真实 Agent 保持空数组语义，content 过滤保留 durable 与运行上下文', async t => {
  const { root, handle, capture, send } = await world(t)
  let mode = 'missing', calls = 0
  const release = root.on('agent/pre-step', async (_payload, next) => {
    const value = await next()
    calls++
    if (mode === 'missing') return { kind: 'enter' }
    if (mode === 'non-array') return { kind: 'enter', messages: {} }
    return calls % 2 === 0 ? { kind: 'enter' } : value
  })
  t.after(release)
  await send(handle.agent)
  assert.equal(capture.requests.length, 0)
  assert.equal(handle.agent.session.snapshotEvents().findLast(event => event.type === 'turn/end').data.reason.kind, 'completed', JSON.stringify(handle.agent.session.snapshotEvents().at(-1)))
  mode = 'non-array'
  await send(handle.agent)
  assert.equal(capture.requests.length, 0)
  assert.equal(handle.agent.session.snapshotEvents().findLast(event => event.type === 'turn/end').data.reason.kind, 'completed')
  mode = 'normal'; calls = 0
  const innerMissing = root.on('agent/pre-step', () => ({ kind: 'enter' }))
  await send(handle.agent)
  assert.equal(handle.agent.session.snapshotEvents().findLast(event => event.type === 'turn/end').data.reason.kind, 'completed', 'official model-selection consumes the guarded inner decision')
  innerMissing(); calls = 0
  const stopping = root.on('agent/turn-stopping', () => { handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'ENDING CLAIM' }], source: { kind: 'user' } })) })
  t.after(stopping)
  const recorded = []
  const runtimeContext = handle.agent.loopCtx.systemPrompt.context({ name: 'guard-context', order: 1, text: 'LIVE CONTEXT' })
  t.after(runtimeContext)
  const derived = []
  const observe = root.on('agent/request', async (_payload, next) => {
    const session = handle.agent.session
    const position = session.snapshotEvents().findLast(event => event.type === 'step/start').data
    if (recorded.length === 0) recorded.push(session.append('system/message', { ...position, message: { ...createSystemMessage(''), content: [] } }, { surfaceOp: 'append' }))
    const before = session.deriveMessages()
    const extra = session.append('system/message', { ...position, message: { ...createSystemMessage(''), content: [] } }, { surfaceOp: 'append' })
    assert.deepEqual(session.deriveMessages(), before, 'incremental derive filters only the newly appended bad target')
    assert.equal(session.deriveEventMessage(extra), null)
    for (const type of ['system/message', 'developer/message', 'assistant/message']) {
      for (const message of [undefined, { content: undefined }, { content: {} }, { content: [] }]) assert.equal(session.deriveEventMessage({ type, seq: extra.seq, data: { message } }), null)
      const message = { role: type.split('/')[0], content: [{ type: 'text', text: ' EXACT ' }] }
      assert.equal(session.deriveEventMessage({ type, seq: extra.seq, data: { message } }), message)
    }
    const user = { content: {} }, tool = { content: undefined }
    assert.equal(session.deriveEventMessage({ type: 'user/message', seq: extra.seq, data: user }), user)
    assert.equal(session.deriveEventMessage({ type: 'tool/result', seq: extra.seq, data: { message: tool } }), tool)
    derived.push(before)
    return next()
  })
  t.after(observe)
  await send(handle.agent, 'EXACT U')
  assert.equal(capture.requests.length, 1, JSON.stringify(handle.agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')))
  assert.equal(calls, 2, 'continuing turn checks the empty enter decision')
  const request = capture.requests[0]
  assert.equal(request.messages.filter(message => message.source?.kind === 'runtime-context').length, 1)
  assert.equal(request.messages.filter(message => message.content?.[0]?.text === 'EXACT U').length, 1)
  assert.match(request.messages[0].content[0].text, /BODY/)
  assert.equal(derived.length, 1)
  for (const event of recorded) assert.deepEqual(handle.agent.session.snapshotEvents().find(value => value.seq === event.seq), event)
  await root.sessions.flush(handle.agent.session)
  const stored = await root.sessionPersistence.open(handle.agent.id, 'read')
  try { assert.deepEqual((await stored.read()).events.find(event => event.seq === recorded[0].seq), recorded[0]) } finally { await stored.close() }
  assert.throws(() => deriveEventMessage({ type: 'system/message', seq: 0, data: {} }), TypeError, 'unscoped public export preserves official rejection')
})

test('关闭、来源异常与 owner 失配维持原拒绝，已接受步骤不被热更新或并发裸装配替换', async t => {
  const { root, runtime, handle, capture, define, assemble, send } = await world(t)
  const accepted = await assemble(handle.agent)
  t.after(accepted.dispose)
  const missing = { name: 'unknown', text: '{{missing}}' }, malformed = { name: 'malformed', text: '{{bad-name}}' }
  assert.throws(() => renderPrompt({ ...accepted.assembly, sections: [missing] }), /unknown prompt variable/)
  assert.throws(() => renderPrompt({ ...accepted.assembly, sections: [malformed] }), /malformed prompt variable/)
  const independent = new Error('provider failure')
  const failProvider = root.on('system-prompt/assemble', () => { throw independent })
  await assert.rejects(assemble(handle.agent), error => error === independent)
  failProvider()
  const child = await root.agents.create({ sessionId: 'pt23-child', agentOptions: { provider: 'local', model: 'probe' }, meta: { origin: 'subagent', delegationDepth: 1 } })
  t.after(() => child.dispose())
  const childStep = await assemble(child.agent)
  t.after(childStep.dispose)
  assert.doesNotMatch(renderPrompt(childStep.assembly), /BODY/)
  const sessionMarker = Symbol.for('prompt-tool:message-shape-session')
  delete handle.agent.session.surface[sessionMarker]
  const missingSession = await assemble(handle.agent)
  t.after(missingSession.dispose)
  assert.doesNotMatch(renderPrompt(missingSession.assembly), /BODY/)
  handle.agent.session.surface[sessionMarker] = handle.agent.session
  const marker = Symbol.for('prompt-tool:message-shape-agent-owner')
  delete handle.agent.model[marker]
  const unavailable = await assemble(handle.agent)
  t.after(unavailable.dispose)
  assert.doesNotMatch(renderPrompt(unavailable.assembly), /BODY/)
  handle.agent.model[marker] = true
  const restored = await assemble(handle.agent)
  t.after(restored.dispose)
  assert.match(renderPrompt(restored.assembly), /BODY/)
  let didRefresh = false
  const refresh = root.on('agent/pre-step', async (_payload, next) => {
    const decision = await next()
    if (!didRefresh) { didRefresh = true; define(false); await runtime.refresh(); const bare = await assemble(handle.agent); bare.dispose() }
    return { ...decision, messages: undefined }
  })
  t.after(refresh)
  await send(handle.agent)
  assert.equal(capture.requests.length, 0, 'accepted enabled step keeps its missing-message guard')
  refresh()
  const off = await assemble(handle.agent)
  t.after(off.dispose)
  const bad = root.on('system-prompt/assemble', async (_assembly, _context, next) => { const value = await next(); value.sections.push({ name: 'bad', text: undefined }); return value })
  const disabled = await assemble(handle.agent)
  t.after(disabled.dispose)
  assert.throws(() => renderPrompt(disabled.assembly), TypeError)
  bad()
  define(); await runtime.refresh()
  const reject = root.on('agent/pre-step', () => ({ kind: 'reject' }))
  await send(handle.agent)
  assert.equal(capture.requests.length, 0)
  reject()
  const unknown = root.on('agent/pre-step', () => ({ kind: 'unknown' }))
  await send(handle.agent)
  assert.equal(capture.requests.length, 0)
  assert.equal(handle.agent.session.snapshotEvents().findLast(event => event.type === 'turn/end').data.reason.kind, 'error')
  unknown()
  const beforeCancel = capture.requests.length
  handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'cancelled' }], source: { kind: 'user' } }))
  handle.agent.cancel('user')
  await deadline(handle.agent.whenIdle())
  assert.equal(capture.requests.length, beforeCancel)
  const badElement = root.on('agent/pre-step', () => ({ kind: 'enter', messages: [null] }))
  await send(handle.agent)
  assert.equal(handle.agent.session.snapshotEvents().findLast(event => event.type === 'turn/end').data.reason.kind, 'error')
  badElement()
  await runtime.dispose()
  assert.equal(messageShapeGuardsStatus(handle.agent).available, false)
})
