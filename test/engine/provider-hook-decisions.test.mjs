import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { createAgentAssembly } from '../../src/runtime/agent-assembly.ts'
await import('../../engine/provider-hook-decisions-early.mjs')

const require = createRequire(import.meta.url)
const peer = createRequire(require.resolve('@deepseek-ai/dsh-agent-loop'))
const load = name => import(pathToFileURL(peer.resolve(name)).href)
const [{ default: Llm, LlmAdapter, createUserMessage }, { default: Agents, agentEvents, assembleContextFor }, { default: Prompt }, { default: Sessions }, { default: Projections }, { default: Loop }, { default: Tools }, Native] = await Promise.all([
  load('@deepseek-ai/dsh-llm'), load('@deepseek-ai/dsh-agent'), load('@deepseek-ai/dsh-system-prompt'), load('@deepseek-ai/dsh-session'), load('@deepseek-ai/dsh-session-projection'), load('@deepseek-ai/dsh-agent-loop'), load('@deepseek-ai/dsh-tools'), load('@deepseek-ai/dsh-tool-executor-native'),
])
const Hooks = await import('@deepseek-ai/dsh-hooks-codex')
class Capture extends LlmAdapter {
  async resolveModel(provider, id) { return { provider, id, name: id } }
  async *stream() { yield { type: 'finish', reason: { kind: 'stop' } } }
}

test('官方 Hook consumer 使用事件显式模型，保留上下文、审计与来源释放', async t => {
  const home = mkdtempSync(join(tmpdir(), 'pt-hook-')), root = new Context()
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const moduleRoot = join(home, 'modules'), moduleDir = join(moduleRoot, 'hook'), configPath = join(home, 'hooks.json')
  mkdirSync(moduleDir, { recursive: true })
  const writeModule = (condition = { scope: { modelScope: 'flash' } }, enabled = true) => writeFileSync(join(moduleDir, 'module.yml'), JSON.stringify({ id: 'hook', modules: ['rule-engine'], rules: [{ id: 'bypass', enabled, if: condition, then: [{ id: 'hook', kind: 'host-control', capability: 'provider-hook-decisions', value: { codex: true } }] }] }))
  writeModule()
  writeFileSync(configPath, JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'fixture-hook' }] }] } }))
  for (const plugin of [Llm, Sessions, Projections, Prompt, Tools, Native, Agents]) await root.plugin(plugin)
  await root.plugin(Loop, { agents: [] })
  root.provide('workingDirectory', { get: () => home, ensure: async () => home })
  root.provide('shell', { resolve: request => request, execute: async () => ({ result: async () => ({ exitCode: 0, stdout: { text: JSON.stringify({ decision: 'block', reason: 'fixture block', hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'HOOK CONTEXT' } }) }, stderr: { text: '' } }) }) })
  root.llm.registerAdapter(['local'], new Capture())
  const hookFiber = await root.plugin(Hooks, { configPath })
  const runtime = createAgentAssembly(root, { moduleRoot, enabledModules: () => ['hook'] })
  await runtime.settled()
  const main = await root.agents.create({ sessionId: 'hook-main', agentOptions: { provider: 'local', model: 'pro' }, meta: { cwd: home } })
  const child = await root.agents.create({ sessionId: 'hook-child', agentOptions: { provider: 'local', model: 'flash' }, meta: { cwd: home, origin: 'subagent', delegationDepth: 1 } })
  t.after(async () => { await runtime.dispose(); await main.dispose(); await child.dispose(); await root.fiber.dispose(); if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome; rmSync(home, { recursive: true, force: true }) })
  const user = createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })
  const fire = (agent, model) => agentEvents(root, agent).waterfall('agent/pre-step', { messages: [user], turn: 1, step: 1, signal: new AbortController().signal, ...(model === undefined ? {} : { modelSelection: { provider: 'local', model } }) }, () => Promise.resolve({ kind: 'enter', messages: [user] }))
  assert.equal((await fire(main.agent, 'pro')).kind, 'reject')
  const entered = await fire(main.agent, 'flash')
  assert.equal(entered.kind, 'enter')
  assert.deepEqual(entered.messages.map(message => message.content[0].text), ['hello', 'HOOK CONTEXT'])
  assert.equal((await fire(child.agent)).kind, 'reject', 'Agent flash cannot supply missing event model')
  assert.equal((await fire(child.agent, 'flash')).kind, 'enter')
  const audit = main.agent.session.snapshotEvents().filter(event => event.type === 'hook/result')
  assert.deepEqual(audit.map(event => ({ point: event.data.point, decision: event.data.decision, exitCode: event.data.exitCode })), [
    { point: 'UserPromptSubmit', decision: 'block', exitCode: 0 },
    { point: 'UserPromptSubmit', decision: 'block', exitCode: 0 },
  ], 'official audit preserves block even when its control result is bypassed')
  writeModule({ not: { scope: { modelScope: 'pro' } } })
  await runtime.refresh()
  assert.equal((await fire(child.agent)).kind, 'reject', 'not cannot turn missing event facts into qualification')
  writeModule(undefined, false)
  await runtime.refresh()
  assert.equal((await fire(main.agent, 'flash')).kind, 'reject')
  writeModule()
  await runtime.refresh()
  assert.equal((await fire(main.agent, 'flash')).kind, 'enter')
  await hookFiber.dispose()
  writeFileSync(join(moduleDir, 'module.yml'), JSON.stringify({ id: 'hook', modules: ['rule-engine'], rules: [
    { id: 'availability', enabled: true, then: [{ if: { scope: { audience: 'main' } }, then: [
      { id: 'owner', kind: 'host-control', capability: 'provider-hook-decisions', value: { codex: true } },
      { id: 'dependent', kind: 'inject-text', config: { layer: 'system-section', order: 1, text: 'OWNER-DEPENDENT' } },
    ] }] },
    { id: 'independent', enabled: true, then: [{ id: 'body', kind: 'inject-text', config: { layer: 'system-section', order: 2, text: 'INDEPENDENT-BODY' } }] },
  ] }))
  await runtime.refresh()
  const context = { ...assembleContextFor(main.agent, new AbortController().signal), modelSelection: { ...main.agent.model.current() } }
  context.toolSet = await main.agent.loopCtx.tools.resolve(context)
  let missing
  try { missing = await main.agent.loopCtx.systemPrompt.assemble(context) }
  finally { context.toolSet.dispose() }
  assert.match(JSON.stringify(missing), /INDEPENDENT-BODY/)
  assert.doesNotMatch(JSON.stringify(missing), /OWNER-DEPENDENT/)
  const unavailable = runtime.ruleDiagnostics().records.find(record => record.ruleId === 'availability' && record.channel === 'host:provider-hook-decisions')
  assert.ok(unavailable, JSON.stringify(runtime.ruleDiagnostics()))
  assert.equal(unavailable.moduleId, 'hook')
  assert.equal(unavailable.actionId, 'owner')
  assert.equal(unavailable.agentId, main.agent.id)
  assert.equal(unavailable.identityOutcome, 'condition-unavailable')
  assert.match(unavailable.reason, /hook owner not mounted/)
  assert.ok(unavailable.definitionRevision)
  const replacement = await root.plugin(Hooks, { configPath })
  const restoredContext = { ...assembleContextFor(main.agent, new AbortController().signal), modelSelection: { ...main.agent.model.current() } }
  restoredContext.toolSet = await main.agent.loopCtx.tools.resolve(restoredContext)
  let restored
  try { restored = await main.agent.loopCtx.systemPrompt.assemble(restoredContext) }
  finally { restoredContext.toolSet.dispose() }
  assert.match(JSON.stringify(restored), /OWNER-DEPENDENT/)
  assert.match(JSON.stringify(restored), /INDEPENDENT-BODY/)
  writeModule()
  await runtime.refresh()
  assert.equal((await fire(main.agent, 'flash')).kind, 'enter', 'replacement owner receives the current source')
  await hookFiber.dispose()
  assert.equal((await fire(main.agent, 'pro')).kind, 'reject', 'old disposer does not remove the replacement consumer')
  assert.equal((await fire(child.agent, 'flash')).kind, 'enter')
  await runtime.dispose()
  assert.equal((await fire(main.agent, 'flash')).kind, 'reject')
  await replacement.dispose()
})
