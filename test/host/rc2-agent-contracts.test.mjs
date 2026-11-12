import '../../engine/instructions-budget-early.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { mkdtempSync, rmSync } from 'node:fs'
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
