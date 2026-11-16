import '../../engine/instructions-budget-early.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { compileRules } from '../../engine/rule-spec.mjs'
import { createRuleRuntime } from '../../engine/rule-runtime.mjs'
import { delegationLimitsStatus } from '../../engine/delegation-limits.mjs'

const require = createRequire(import.meta.url)
const peerRequire = createRequire(require.resolve('@deepseek-ai/dsh-agent-loop'))
const peer = name => import(pathToFileURL(peerRequire.resolve(name)).href)
const [{ default: Llm, LlmAdapter }, { default: Agents }, { default: Sessions }, { default: Projections },
  { default: Prompt }, { default: Tools }, Native, { default: Loop }, Persistence, { default: Subagents }, Spawn, Tool] = await Promise.all([
  peer('@deepseek-ai/dsh-llm'), peer('@deepseek-ai/dsh-agent'), peer('@deepseek-ai/dsh-session'), peer('@deepseek-ai/dsh-session-projection'),
  peer('@deepseek-ai/dsh-system-prompt'), peer('@deepseek-ai/dsh-tools'), peer('@deepseek-ai/dsh-tool-executor-native'),
  peer('@deepseek-ai/dsh-agent-loop'), peer('@deepseek-ai/dsh-session-persistence-jsonl'), peer('@deepseek-ai/dsh-subagent'),
  import('@deepseek-ai/dsh-subagent-spawn-in-process'), import('@deepseek-ai/dsh-tool-subagent'),
])

test('连续记录沿真实消息和工具执行，重放不增原文，旧历史与关闭后材料不纳入', { timeout: 10000 }, async t => {
  const root = new Context(), home = mkdtempSync(join(tmpdir(), 'soul-record-'))
  const dir = join(home, 'modules', 'alice')
  mkdirSync(join(dir, 'data'), { recursive: true })
  writeFileSync(join(dir, 'module.yml'), 'id: alice\nmodules: []\nrules: []\n')
  const storage = await import('@deepseek-ai/dsh-storage')
  const json = await import('@deepseek-ai/dsh-storage-json')
  const domain = await import('@deepseek-ai/dsh-storage-domain')
  const { createUserMessage } = await peer('@deepseek-ai/dsh-llm')
  const { openSoulKnowledge } = await import('../../src/host/soul-knowledge.ts')
  const { installSoulRuntime } = await import('../../src/runtime/soul-runtime.ts')
  const { registerSoulLedgerTools } = await import('../../src/runtime/soul-ledger-tools.ts')
  const { readSoulLedgerProjection } = await import('../../src/host/soul-ledger.ts')
  for (const plugin of [Llm, Sessions, Projections, Prompt, Tools, Native, Agents, storage.default]) await root.plugin(plugin)
  await root.plugin(json, { root: join(home, 'storage') })
  await root.plugin(domain, { backend: 'json' })
  await root.plugin(Persistence, { root: join(home, 'sessions'), compression: 'none' })
  await root.plugin(Loop, { agents: [] })
  class Model extends LlmAdapter {
    async resolveModel(provider, id) { return { provider, id, name: id } }
    async *stream(request) {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      if (request.model === 'held') await new Promise((_, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }))
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'fixture response' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  root.llm.registerAdapter(['fixture'], new Model())
  root.provide('workingDirectory', { get: session => session.header.cwd ?? home, ensure: async () => home, set: async () => home })
  await root.plugin(Subagents)
  await root.plugin(Spawn, { providerName: 'spawn' })
  await root.plugin(Tool, { provider: 'spawn', agentOptions: { provider: 'fixture', model: 'held' } })
  const handle = await root.agents.create({ sessionId: 'record-parent', agentOptions: { provider: 'fixture', model: 'normal' }, meta: { cwd: home } })
  const agent = handle.agent
  const handles = [handle]
  let failDerived = false
  const facility = { async open(definition) {
    const domain = await root.storageDomain.open(definition)
    return { close: () => domain.close(), table(name) {
      const table = domain.table(name)
      return new Proxy(table, { get(target, key) {
        if (key === 'put') return async (id, value) => {
          if (failDerived && value.records?.length > 1) { failDerived = false; throw new Error('injected derived persistence failure') }
          return target.put(id, value)
        }
        const value = target[key]
        return typeof value === 'function' ? value.bind(target) : value
      } })
    } }
  } }
  let owner = await openSoulKnowledge(facility, async id => root.sessions.get(id))
  t.after(async () => { await root.subagents.drainDescendants([agent]); for (const handle of handles) await handle.dispose(); await owner.dispose(); await root.fiber.dispose(); rmSync(home, { recursive: true, force: true }) })
  const host = { root: join(home, 'modules'), target: () => ({ id: 'alice', dir }) }
  const excluded = new Set()
  installSoulRuntime(root, host, id => root.agents.get(id) && !excluded.has(id) ? ['alice'] : [], () => undefined, () => owner)
  registerSoulLedgerTools(root, host, () => owner)
  await new Promise(resolve => setImmediate(resolve))
  const signal = new AbortController().signal
  const previewRequest = { moduleId: 'alice', action: 'preview', write: ['general', 'projects'] }
  const preview = owner.preview(dir, previewRequest)
  await owner.confirm(dir, { ...previewRequest, action: 'confirm', expectedRevision: preview.revision }, signal)
  const manage = async action => owner.manage(dir, { moduleId: 'alice', ...action, expectedRevision: owner.status(dir).binding.revision }, agent.session.id, signal)
  await manage({ action: 'project', projectDirectory: home })
  const send = async message => { agent.send(message, 'next-turn', true); await agent.whenIdle(); await owner.observe(dir, agent.session.id) }
  await send(createUserMessage({ content: [{ type: 'text', text: 'OLD HISTORY' }], source: { kind: 'user' } }))
  await manage({ action: 'enable' })
  await owner.observe(dir, agent.session.id)
  const message = createUserMessage({ content: [{ type: 'text', text: 'keep this project decision' }], source: { kind: 'user' } })
  await send(message)
  const fresh = await root.agents.create({ sessionId: 'record-new-main', agentOptions: { provider: 'fixture', model: 'normal' }, meta: { cwd: home } })
  handles.push(fresh)
  fresh.agent.send(createUserMessage({ content: [{ type: 'text', text: 'new same-project material' }], source: { kind: 'user' } }), 'next-turn', true)
  await fresh.agent.whenIdle()
  await owner.observe(dir, fresh.agent.session.id)
  assert.equal(owner.status(dir).binding.participants.find(row => row.sessionId === fresh.agent.session.id).scope, owner.status(dir).binding.projects.find(row => row.sessionId === agent.session.id).identity, '新主会话只复用已声明且真实身份相同的项目')
  const call = async (id = 'stable-operation') => (await root.tools.execute({ agent, signal, calls: [{ type: 'tool-call', id, name: 'soul_ledger', arguments: JSON.stringify({ moduleId: 'alice', action: 'append', type: 'fact', text: 'project decision' }) }] })).results[0].result
  const first = await call()
  assert.equal(first.isError, false, JSON.stringify(first))
  assert.equal(first.value.persisted, true)
  assert.equal(first.value.reference.rootMessageId, message.id)
  assert.equal(first.value.derived.state, 'pending')
  const id = first.value.reference.entryId
  await send(message)
  assert.equal((await call()).isError, false)
  assert.equal(readSoulLedgerProjection(dir).total, 1)
  assert.equal(owner.records(dir, agent.session.id)[0].entryId, id)
  assert.equal(owner.sources(dir, agent.session.id).histories.some(row => row.sessionId === agent.session.id && row.seqs.includes(agent.session.snapshotEvents().find(event => event.type === 'user/message').seq)), false)
  await send(createUserMessage({ content: [{ type: 'text', text: 'AUTOMATIC FOLLOWUP' }], source: { kind: 'agent-message' } }))
  assert.equal(owner.status(dir).binding.participants.findLast(row => row.sessionId === agent.session.id).rootMessageId, message.id)
  failDerived = true
  const partial = await call('partial-operation')
  assert.equal(partial.value.persisted, true)
  assert.equal(partial.value.derived.state, 'failed')
  assert.deepEqual(owner.recording(dir, agent.session.id), { persisted: 2, pending: 1, derivedFailed: 1 })
  await owner.dispose()
  owner = await openSoulKnowledge(facility, async id => root.sessions.get(id))
  assert.equal(owner.records(dir, agent.session.id).length, 2, 'seed无需session/event即可恢复对账')
  assert.equal(readSoulLedgerProjection(dir).total, 2)
  await manage({ action: 'revoke', sourceId: first.value.reference.sourceId })
  await send(createUserMessage({ content: [{ type: 'text', text: 'unrelated new decision' }], source: { kind: 'user' } }))
  assert.equal((await call('after-single-revoke')).isError, false)
  assert.equal(readSoulLedgerProjection(dir).total, 3, '单项撤权不阻断无关新材料')
  const parentSourceIds = owner.sources(dir, agent.session.id).histories.map(row => row.id)
  const context = { agent, scope: scopeOf(agent.ctx), signal }
  const toolSet = await root.tools.resolve(context)
  t.after(() => toolSet.dispose())
  await root.systemPrompt.assemble({ ...context, toolSet })
  const spawned = (await root.tools.execute({ ...context, toolSet, calls: [{ type: 'tool-call', id: 'delegate', name: 'subagent', arguments: JSON.stringify({ name: 'worker', description: 'record fixture', prompt: 'Task experience; this is not a new human input.' }) }] })).results[0].result
  assert.equal(spawned.isError, false, JSON.stringify(spawned))
  const childId = root.sessionProjections.snapshot(agent.session).values.subagentCatalog.find(entry => entry.name === 'worker').id
  const child = root.agents.get(childId)
  assert.equal(root.subagents.rootOf(child), agent)
  const childResult = (await root.tools.execute({ agent: child, signal, calls: [{ type: 'tool-call', id: 'child-fact', name: 'soul_ledger', arguments: JSON.stringify({ moduleId: 'alice', action: 'append', type: 'fact', text: 'task experience' }) }] })).results[0].result
  assert.equal(childResult.isError, false, JSON.stringify(childResult))
  const childParticipation = owner.status(dir).binding.participants.findLast(row => row.sessionId === childId)
  assert.equal(childParticipation.rootSessionId, agent.session.id)
  assert.equal(childResult.value.reference.rootMessageId, owner.status(dir).binding.participants.findLast(row => row.sessionId === agent.session.id).rootMessageId)
  assert.ok(parentSourceIds.every(id => childParticipation.grants.includes(id)))
  await send(createUserMessage({ content: [{ type: 'text', text: 'later private parent input' }], source: { kind: 'user' } }))
  const laterSource = owner.sources(dir, agent.session.id).histories.findLast(row => row.sessionId === agent.session.id).id
  assert.equal(owner.sources(dir, childId).histories.some(row => row.id === laterSource), false)
  await manage({ action: 'disable' })
  assert.equal(owner.sources(dir, childId).histories.some(row => row.id === laterSource), false, '关闭不能丢失子任务范围上限')
  await manage({ action: 'enable' })
  assert.equal(owner.sources(dir, childId).histories.some(row => row.id === laterSource), false)
  await root.subagents.drainDescendants([agent])
  excluded.add(agent.id)
  const beforeRelease = owner.status(dir).binding.histories.length
  agent.send(createUserMessage({ content: [{ type: 'text', text: 'RELEASED MATERIAL' }], source: { kind: 'user' } }), 'next-turn', true)
  await agent.whenIdle()
  await owner.dispose()
  owner = await openSoulKnowledge(facility, async id => root.sessions.get(id))
  assert.equal(owner.status(dir).binding.histories.length, beforeRelease, '启动只恢复原文登记，不追溯释放期间事件')
  await manage({ action: 'disable' })
  const count = owner.status(dir).binding.histories.length
  await send(createUserMessage({ content: [{ type: 'text', text: 'AFTER DISABLE' }], source: { kind: 'user' } }))
  assert.equal(owner.status(dir).binding.histories.length, count)
  assert.equal((await call()).isError, true)
})

test('rc2具名spawn沿真实Agent血缘执行已接受深度，取消后释放子Agent', { timeout: 10000 }, async t => {
  const root = new Context(), home = mkdtempSync(join(tmpdir(), 'pt36-lineage-'))
  const runtimes = [], handles = [], entered = new Map(), starts = [], ends = []
  t.after(async () => {
    for (const runtime of runtimes) runtime.dispose()
    for (const handle of handles) await handle.dispose()
    await root.fiber.dispose()
    rmSync(home, { recursive: true, force: true })
  })
  class HeldModel extends LlmAdapter {
    async resolveModel(provider, id) { return { provider, id, name: id } }
    async *stream(request) {
      entered.get(request.sessionId)?.resolve()
      yield { type: 'block-start', index: 0, blockType: 'text' }
      await new Promise((_, reject) => {
        if (request.signal.aborted) reject(request.signal.reason)
        else request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true })
      })
    }
  }
  for (const plugin of [Llm, Sessions, Projections, Prompt, Tools, Native, Agents]) await root.plugin(plugin)
  await root.plugin(Persistence, { root: join(home, 'sessions'), compression: 'none' })
  await root.plugin(Loop, { agents: [] })
  root.provide('workingDirectory', { get: session => session.header.cwd ?? home, ensure: async () => home, set: async () => home })
  await root.plugin(Subagents)
  await root.plugin(Spawn, { providerName: 'spawn' })
  const toolOwner = await root.plugin(Tool, { provider: 'spawn' })
  root.llm.registerAdapter(['memory'], new HeldModel())
  root.on('subagent/start', info => {
    starts.push(info)
    entered.set(info.id, Promise.withResolvers())
  })
  root.on('subagent/end', info => { ends.push(info) })
  const parentHandle = await root.agents.create({ sessionId: 'pt36-parent', agentOptions: { provider: 'memory', model: 'held' }, meta: { cwd: home } })
  handles.push(parentHandle)
  const parent = parentHandle.agent
  const rules = depth => [{ moduleId: 'lineage', rules: compileRules([{ id: 'depth', then: [
    { id: 'depth', kind: 'host-control', capability: 'delegation-limits', value: { maxDepth: depth } },
  ] }]) }]
  const parentRuntime = createRuleRuntime(parent.ctx, { agent: parent })
  runtimes.push(parentRuntime)
  parentRuntime.replace(rules(2))
  const prepare = async agent => {
    const context = { agent, scope: scopeOf(agent.ctx), signal: new AbortController().signal }
    const toolSet = await agent.ctx.tools.resolve(context)
    t.after(() => toolSet.dispose())
    await agent.ctx.systemPrompt.assemble({ ...context, toolSet })
    return { ...context, toolSet }
  }
  const call = async (frame, name) => (await frame.agent.ctx.tools.execute({ ...frame, calls: [
    { type: 'tool-call', id: name, name: 'subagent', arguments: JSON.stringify({ name, description: 'lineage fixture', prompt: 'Wait for cancellation' }) },
  ] })).results[0].result
  const accepted = await prepare(parent)
  assert.equal(delegationLimitsStatus(parent, accepted, 'maxDepth').available, true)
  parentRuntime.replace(rules(0))
  const denied = await call(await prepare(parent), 'blocked')
  assert.equal(denied.isError, true)
  assert.match(denied.error.message, /depth 1 exceeds maxDepth 0/)
  assert.equal(starts.length, 0)
  const spawned = await call(accepted, 'reviewer')
  assert.equal(spawned.isError, false, JSON.stringify(spawned))
  assert.deepEqual(spawned.value, { kind: 'activation', name: 'reviewer' })
  const childId = root.sessionProjections.snapshot(parent.session).values.subagentCatalog.find(entry => entry.name === 'reviewer').id
  assert.notEqual(childId, 'reviewer')
  assert.notEqual(childId, parent.session.id)
  const child = root.agents.get(childId)
  assert.ok(child)
  await entered.get(childId).promise
  assert.equal(child.session.header.parentSession, parent.session.id)
  assert.equal(starts[0].parentSessionId, parent.session.id)
  assert.equal(starts[0].id, childId)
  assert.deepEqual(root.subagents.namesOf(child), { self: 'reviewer', parent: 'lead' })
  assert.equal(root.subagents.rootOf(child), parent)
  const childRuntime = createRuleRuntime(child.ctx, { agent: child })
  runtimes.push(childRuntime)
  childRuntime.replace(rules(1))
  const childDenied = await call(await prepare(child), 'nested')
  assert.equal(childDenied.isError, true)
  assert.match(childDenied.error.message, /depth 2 exceeds maxDepth 1/)
  assert.equal(starts.length, 1, 'child cannot borrow parent accepted depth 2')
  await root.subagents.drainDescendants([parent])
  assert.equal(root.agents.get(childId), undefined)
  assert.equal(ends.length, 1)
  assert.equal(ends[0].id, childId)
  assert.equal(ends[0].parentSessionId, parent.session.id)
  assert.equal(ends[0].stopReason, 'aborted')
  assert.equal(child.session.snapshotEvents().findLast(event => event.type === 'turn/end').data.reason.kind, 'aborted')
  await toolOwner.dispose()
  assert.equal(delegationLimitsStatus(parent, accepted, 'maxDepth').available, false)
})
