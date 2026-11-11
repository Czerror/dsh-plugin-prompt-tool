import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { createAgentAssembly } from '../../src/runtime/agent-assembly.ts'
import { currentSystemSnapshotStatus } from '../../engine/current-system-snapshot.mjs'
await import('../../engine/request-budget-early.mjs')

const require = createRequire(import.meta.url)
const contentText = value => Array.isArray(value) ? value.map(block => typeof block === 'string' ? block : block?.text ?? '').join('') : String(value ?? '')
const peerRequire = createRequire(require.resolve('@deepseek-ai/dsh-agent-loop'))
const loadPeer = name => import(pathToFileURL(peerRequire.resolve(name)).href)
const [{ default: Llm, LlmAdapter, createUserMessage, createSystemMessage }, { default: Agents }, { default: Prompt }, { default: Sessions }, { default: Projections }, Persistence, { default: Loop }, { default: Tools }, Native] = await Promise.all([
  loadPeer('@deepseek-ai/dsh-llm'), loadPeer('@deepseek-ai/dsh-agent'), loadPeer('@deepseek-ai/dsh-system-prompt'),
  loadPeer('@deepseek-ai/dsh-session'), loadPeer('@deepseek-ai/dsh-session-projection'),
  loadPeer('@deepseek-ai/dsh-session-persistence-jsonl'), loadPeer('@deepseek-ai/dsh-agent-loop'), loadPeer('@deepseek-ai/dsh-tools'), loadPeer('@deepseek-ai/dsh-tool-executor-native'),
])

class Capture extends LlmAdapter {
  requests = []
  waiters = []
  hold
  failOnce
  armHold(sessionId) {
    const entered = Promise.withResolvers(), release = Promise.withResolvers()
    this.hold = { entered, release, sessionId }
    return { entered: entered.promise, release: () => { release.resolve(); this.hold = undefined } }
  }
  async resolveModel(provider, id) { return { provider, id, name: id, ...(id === 'head' ? {} : { systemPromptUpdate: 'in-history' }) } }
  async *stream(request) {
    this.requests.push(request)
    this.waiters.splice(0).filter(waiter => waiter.sessionId === request.sessionId).forEach(waiter => waiter.resolve(request))
    if (this.hold?.sessionId === request.sessionId) { this.hold.entered.resolve(request); await this.hold.release.promise }
    if (this.failOnce === request.sessionId) {
      this.failOnce = undefined
      yield { type: 'finish', reason: { kind: 'error', failure: { message: 'retry frozen step', code: 'SERVER' } } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'OK' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
const deadline = async (promise, label) => {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), 12000) })]) }
  finally { clearTimeout(timer) }
}

test('每步当前系统正文：真实 Agent request 与 JSONL 日志采用热更新后的完整快照', async t => {
  const root = new Context(), home = mkdtempSync(join(tmpdir(), 'pt22-home-')), moduleRoot = join(home, 'modules'), moduleDir = join(moduleRoot, 'current-system'), capture = new Capture()
  const writeModule = (text, enabled = true, audience = 'main') => {
    mkdirSync(moduleDir, { recursive: true })
    writeFileSync(join(moduleDir, 'module.yml'), JSON.stringify({ id: 'current-system', modules: ['rule-engine'], rules: [{ id: 'snapshot', enabled, if: { scope: { audience } }, then: [{ id: 'snapshot', kind: 'host-control', capability: 'current-system-snapshot', value: true }, { id: 'dependent', kind: 'inject-text', config: { layer: 'system-section', order: 11, text: 'QUALIFIED' } }] }, { id: 'current', enabled: true, then: [{ id: 'body', kind: 'inject-text', config: { layer: 'system-section', order: 10, text } }] }] }))
  }
  await writeModule('A\r\n完整正文\r\n尾部', false)
  for (const plugin of [Llm, Sessions, Projections, Prompt, Tools, Native, Agents]) await root.plugin(plugin)
  await root.plugin(Persistence, { root: join(home, 'sessions'), compression: 'none' })
  await root.plugin(Loop, { agents: [] })
  root.provide('workingDirectory', { get: session => session.header.cwd ?? home, ensure: async () => home, set: async () => home })
  root.llm.registerAdapter(['local'], capture)
  const runtime = createAgentAssembly(root, { moduleRoot, enabledModules: () => ['current-system'] })
  await runtime.settled()
  const handle = await root.agents.create({ sessionId: 'pt22-current', agentOptions: { provider: 'local', model: 'probe' }, meta: { cwd: home } })
  const other = await root.agents.create({ sessionId: 'pt22-other', agentOptions: { provider: 'local', model: 'probe' }, meta: { cwd: home, origin: 'subagent', delegationDepth: 1 } })
  assert.equal(currentSystemSnapshotStatus({}).available, false)
  assert.equal(currentSystemSnapshotStatus({ [Symbol.for('prompt-tool:current-system-snapshot-owner')]: true }).available, false)
  assert.equal(currentSystemSnapshotStatus(handle.agent).available, true)
  t.after(async () => { await runtime.dispose(); await handle.dispose(); await other.dispose(); await root.fiber.dispose(); rmSync(home, { recursive: true, force: true }) })
  const send = async (agent, text) => {
    const before = capture.requests.length
    const requestPromise = new Promise(resolve => capture.waiters.push({ sessionId: agent.id, resolve }))
    agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
    const request = await deadline(requestPromise, 'request timed out')
    await deadline(agent.whenIdle(), 'agent idle timed out')
    assert.ok(request)
    assert.equal(capture.requests.slice(before).find(value => value.sessionId === agent.id), request)
    return request
  }
  const off = await send(handle.agent, 'off')
  assert.match(contentText(off.messages.find(message => message.role === 'system')?.content), /A\r?\n完整正文/)
  await writeModule('A\r\n完整正文\r\n尾部')
  await runtime.refresh()
  for (const model of ['probe', 'head']) {
    const fresh = await root.agents.create({ sessionId: `pt22-fresh-${model}`, agentOptions: { provider: 'local', model }, meta: { cwd: home } })
    t.after(() => fresh.dispose())
    const earlierSystem = { ...createSystemMessage('EARLIER OTHER OWNER'), source: { kind: 'another-owner' } }
    const earlierEvent = fresh.agent.session.append('system/message', { turn: 1, step: 1, message: earlierSystem }, { surfaceOp: 'append' })
    const firstRequest = await send(fresh.agent, 'first-enabled')
    const full = contentText(firstRequest.messages.find(message => message.role === 'system')?.content)
    assert.match(full, /A\r?\n完整正文\r?\n尾部/)
    assert.match(full, /QUALIFIED/)
    assert.deepEqual(firstRequest.messages.filter(message => message.source?.kind === 'another-owner'), [earlierSystem])
    assert.deepEqual(fresh.agent.session.snapshotEvents()[earlierEvent.seq].data.message, earlierSystem)
    assert.equal(firstRequest.messages.filter(message => message.role === 'system' && message.source.kind === 'system-prompt').length, 1)
    const others = [
      { ...createSystemMessage('OTHER SYSTEM \r\n '), source: { kind: 'another-owner' } },
      createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'OTHER USER' }] }),
    ]
    fresh.agent.session.append('system/message', { turn: 1, step: 1, message: others[0] }, { surfaceOp: 'append' })
    fresh.agent.session.append('user/message', others[1], { surfaceOp: 'append' })
    for (const [name, text] of [
      ['blank', ' \r\n '], ['head', 'A'], ['tail', '尾部'], ['truncated', 'A\r\n完整'],
      ['lf', full.replaceAll('\r\n', '\n')], ['crlf', full.replace(/\r?\n/g, '\r\n')], ['complete', full],
    ]) {
      const seeded = fresh.agent.session.append('system/message', { turn: 1, step: 1, message: createSystemMessage(text) }, { surfaceOp: 'append' })
      const request = await send(fresh.agent, `integrity-${name}`)
      assert.equal(contentText(request.messages[0].content), full, `${model}/${name}: complete first body`)
      assert.equal(request.messages.filter(message => message.role === 'system' && message.source.kind === 'system-prompt').length, 1, `${model}/${name}: no duplicate`)
      assert.equal(contentText(fresh.agent.session.snapshotEvents().find(event => event.seq === seeded.seq).data.message.content), text, 'historical event remains exact')
      const retained = request.messages.filter(message => message.source?.kind === 'another-owner' || contentText(message.content) === 'OTHER USER')
      assert.deepEqual(retained, [earlierSystem, ...others], `${model}/${name}: other contributions and order preserved`)
      const latest = fresh.agent.session.snapshotEvents().findLast(event => event.type === 'system/message' && event.data.message.source.kind === 'system-prompt' && contentText(event.data.message.content) !== '')
      assert.equal(contentText(latest.data.message.content), full, `${model}/${name}: durable body matches request`)
    }
  }
  const marker = Symbol.for('prompt-tool:current-system-snapshot-owner')
  delete handle.agent[marker]
  assert.equal(currentSystemSnapshotStatus(handle.agent).available, false)
  const unavailable = await send(handle.agent, 'missing-early-owner')
  assert.doesNotMatch(contentText(unavailable.messages.findLast(message => message.role === 'system')?.content), /QUALIFIED/)
  assert.match(contentText(unavailable.messages.findLast(message => message.role === 'system')?.content), /完整正文/)
  handle.agent[marker] = true
  const restored = await send(handle.agent, 'owner-restored')
  assert.match(contentText(restored.messages[0].content), /QUALIFIED/)
  const settledSystems = handle.agent.session.snapshotEvents().filter(event => event.type === 'system/message').length
  await send(handle.agent, 'same-body')
  assert.equal(handle.agent.session.snapshotEvents().filter(event => event.type === 'system/message').length, settledSystems, 'stable body does not add dormant replacements')
  const beforeCancel = capture.requests.length
  handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'enabled-cancel' }], source: { kind: 'user' } }))
  handle.agent.cancel('user')
  await deadline(handle.agent.whenIdle(), 'enabled cancellation did not settle')
  assert.equal(capture.requests.length, beforeCancel)
  const otherFirst = await send(other.agent, 'other')
  assert.match(contentText(otherFirst.messages.find(message => message.role === 'system')?.content), /A\r?\n完整正文/)
  const hold = capture.armHold(handle.agent.id)
  handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'first' }], source: { kind: 'user' } }))
  const first = await deadline(hold.entered, 'held request did not enter')
  const firstIdle = handle.agent.whenIdle()
  const firstMessages = first.messages
  assert.match(contentText(first.messages.find(message => message.role === 'system')?.content), /A\r?\n完整正文/, 'in-flight request captured before refresh')
  const concurrentOther = await send(other.agent, 'parallel-other')
  assert.doesNotMatch(contentText(concurrentOther.messages[0].content), /QUALIFIED/)
  await writeModule('B\n新正文\n尾部')
  await runtime.refresh()
  assert.equal(capture.requests.findLast(request => request.sessionId === handle.agent.id), first)
  assert.equal(first.messages, firstMessages)
  assert.match(contentText(first.messages.find(message => message.role === 'system')?.content), /A\r?\n完整正文/)
  hold.release()
  await deadline(firstIdle, 'held request did not settle')
  const secondStart = handle.agent.session.snapshotEvents().at(-1).seq
  const secondRequestStart = capture.requests.length
  capture.failOnce = handle.agent.id
  const stopRetry = root.on('agent/request-error', async () => ({ kind: 'retry' }))
  const stopRequestRefresh = root.on('agent/request', async (payload, next) => {
    await writeModule('B\n新正文\n尾部', false)
    await runtime.refresh()
    await handle.agent.loopCtx.systemPrompt.assemble({ agent: handle.agent, signal: payload.signal })
    await Promise.all([0, 1].map(async () => {
      const context = { agent: handle.agent, signal: payload.signal, modelSelection: { ...handle.agent.model.current() } }
      const toolSet = await handle.agent.loopCtx.tools.resolve(context)
      try { await handle.agent.loopCtx.systemPrompt.assemble({ ...context, toolSet }) }
      finally { toolSet.dispose() }
    }))
    return next()
  })
  const second = await send(handle.agent, 'second')
  stopRequestRefresh()
  stopRetry()
  const retryRequests = capture.requests.slice(secondRequestStart).filter(request => request.sessionId === handle.agent.id)
  assert.equal(retryRequests.length, 2, 'real loop retries the accepted step once')
  assert.deepEqual(retryRequests.map(request => contentText(request.messages[0].content)), [
    'You are an AI agent powered by DeepSeek Harness.\n\nQUALIFIED\n\nB\n新正文\n尾部',
    'You are an AI agent powered by DeepSeek Harness.\n\nQUALIFIED\n\nB\n新正文\n尾部',
  ], 'hot disable, bare assembly and concurrent same-Agent assemblies do not replace the accepted step')
  const otherSecond = await send(other.agent, 'other-after-update')
  const firstSystem = contentText(first.messages.find(message => message.role === 'system')?.content)
  const secondSystem = contentText(second.messages.find(message => message.role === 'system')?.content)
  assert.match(firstSystem, /A\r?\n完整正文/)
  assert.match(secondSystem, /B\n新正文/, `in-history actual first=${JSON.stringify(firstSystem)} second=${JSON.stringify(secondSystem)} events=${JSON.stringify(handle.agent.session.snapshotEvents())}`)
  assert.doesNotMatch(secondSystem, /A\r?\n完整正文/)
  const bEvent = handle.agent.session.snapshotEvents().findLast(event => event.type === 'system/message' && contentText(event.data.message.content).includes('B'))
  assert.ok(bEvent)
  assert.equal(secondSystem, contentText(bEvent.data.message.content))
  const secondStep = handle.agent.session.snapshotEvents().find(event => event.seq > secondStart && event.type === 'step/start')
  assert.ok(secondStep)
  assert.deepEqual({ turn: bEvent.data.turn, step: bEvent.data.step }, secondStep.data)
  assert.ok(handle.agent.session.snapshotEvents().some(event => event.seq > bEvent.seq && event.type === 'step/end' && event.data.turn === secondStep.data.turn && event.data.step === secondStep.data.step))
  assert.match(contentText(otherSecond.messages.find(message => message.role === 'system')?.content), /A\r?\n完整正文/)
  await writeModule('SUB\n子代理当前正文', true, 'subagent')
  await runtime.refresh()
  const childEnabled = await send(other.agent, 'child-enabled')
  assert.match(contentText(childEnabled.messages[0].content), /SUB\n子代理当前正文/)
  assert.match(contentText(childEnabled.messages[0].content), /QUALIFIED/)
  const cancelling = capture.armHold(other.agent.id)
  other.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'inflight-cancel' }], source: { kind: 'user' } }))
  const cancelRequest = await deadline(cancelling.entered, 'cancellable request did not enter')
  const cancelIdle = other.agent.whenIdle()
  other.agent.cancel('user')
  cancelling.release()
  await deadline(cancelIdle, 'inflight cancellation did not settle')
  assert.match(contentText(cancelRequest.messages[0].content), /SUB\n子代理当前正文/)
  await writeModule('C\n关闭后正文\n尾部', false)
  await runtime.refresh()
  const released = await send(handle.agent, 'released')
  assert.equal(contentText(released.messages.find(message => message.role === 'system')?.content), secondSystem)
  assert.match(contentText(released.messages.findLast(message => message.role === 'system')?.content), /C\n关闭后正文/)
  const requestCount = capture.requests.length
  handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'cancelled' }], source: { kind: 'user' } }))
  handle.agent.cancel('user')
  await deadline(handle.agent.whenIdle(), 'cancelled request did not settle')
  assert.equal(capture.requests.length, requestCount)
  const log = JSON.stringify(handle.agent.session.snapshotEvents())
  const systems = handle.agent.session.snapshotEvents().filter(event => event.type === 'system/message')
  assert.ok(systems.some(event => contentText(event.data.message.content).includes('A')))
  assert.ok(systems.some(event => contentText(event.data.message.content).includes('B')))
  const bSystem = systems.find(event => contentText(event.data.message.content).includes('B'))
  assert.ok(bSystem)
  assert.match(log, /first/)
  assert.match(log, /second/)
  assert.match(log, /新正文/)
  await root.sessions.flush(handle.agent.session)
  const stored = await root.sessionPersistence.open(handle.agent.id, 'read')
  try {
    const persisted = await stored.read()
    assert.deepEqual(persisted.events.find(event => event.seq === bEvent.seq), bEvent)
  } finally { await stored.close() }
  await runtime.dispose()
  assert.equal(currentSystemSnapshotStatus(handle.agent).available, false)
  const afterDispose = await send(handle.agent, 'disposed')
  assert.doesNotMatch(contentText(afterDispose.messages.findLast(message => message.role === 'system')?.content), /QUALIFIED|关闭后正文/)
})
