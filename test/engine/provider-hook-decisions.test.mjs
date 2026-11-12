import '../../engine/instructions-budget-early.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRuleRuntime } from '../../engine/rule-runtime.mjs'
import { Context } from '@deepseek-ai/cordis'
import { createScope, scopeOf, scopeTarget } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { mkdtemp, writeFile, readFile, rm, mkdir, copyFile, symlink, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { parseDocument } from 'yaml'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { compileRules } from '../../engine/rule-spec.mjs'

test('Hook 决定规则拒绝不会消费的投递预算与外层排序', () => {
  for (const options of [{ maxPerTurn: 1 }, { waterfallPosition: 'outermost' }]) assert.throws(() => compileRules([{ id: 'invalid', then: [
    { id: 'hook', kind: 'host-control', capability: 'provider-hook-decisions', value: { codex: true }, ...options },
  ] }]), /does not support|provider-hook-decisions/)
})

for (const kind of ['claude-code', 'codex']) test(`${kind} 官方四事件保留审计与下游拒绝，普通规则只绕过本 owner`, async t => {
  const root = new Context()
  const dir = await mkdtemp(join(tmpdir(), 'pt-hook-'))
  const path = join(dir, 'hooks.json')
  const hooks = Object.fromEntries(['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'].map(event => [event, [{ hooks: [{ type: 'command', command: 'fixture-never-executed' }] }]]))
  await writeFile(path, JSON.stringify({ hooks }))
  const events = [{ type: 'turn/start', data: { turn: 1 } }]
  const session = { id: kind, header: {}, snapshotEvents: () => events,
    append(type, data) { events.push({ type, data, seq: events.length }); return events.at(-1) } }
  let steers = 0, calls = 0, gate, ask = false, releases = []
  root.provide('agents', { get: () => undefined, turnBoundaryOf: () => ({ lastTurn: 1 }) })
  root.provide('workingDirectory', { ensure: async () => dir, get: () => dir })
  root.provide('shell', { resolve: request => request, execute: async request => {
    assert.equal(request.command, 'fixture-never-executed')
    calls++
    if (gate) await gate()
    const payload = JSON.parse(request.stdin)
    return { result: async () => ({ exitCode: 0, stdout: { text: JSON.stringify({ decision: 'block', reason: 'fixture refusal', hookSpecificOutput: { hookEventName: payload.hook_event_name, permissionDecision: ask ? 'ask' : 'deny', additionalContext: 'hook context' } }) }, stderr: { text: '' } }) }
  } })
  const hook = await root.plugin(await import(`@deepseek-ai/dsh-hooks-${kind}`), { configPath: path })
  const agent = { id: kind, session, model: { current: () => ({ model: 'deepseek-flash' }) }, steer() { steers++ } }
  agent.ctx = createScope(root, agent).ctx
  const outcomes = []
  let assemblyCtx
  const assemblyScope = await agent.ctx.plugin({ name: 'prompt-tool-assembly', apply(ctx) { assemblyCtx = ctx } })
  const runtime = createRuleRuntime(assemblyCtx, { agent, onOutcome: outcome => outcomes.push(outcome) })
  t.after(async () => { runtime.dispose(); await root.fiber.dispose(); await rm(dir, { recursive: true }) })
  const definition = parseDocument(await readFile(new URL('../../modules/limit-breaker/module.yml', import.meta.url), 'utf8')).toJS()
  const card = definition.rules.find(rule => rule.id === `${kind}-hook-decisions`)
  assert.equal(card.enabled, true)
  const replace = enabled => runtime.replace([{ moduleId: 'hook', rules: compileRules([{ ...card, enabled,
    if: { scope: { modelScope: 'flash' } } }]) }])
  const signal = new AbortController().signal
  const input = { agent, signal, turn: 1, messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }], modelSelection: { model: 'deepseek-flash' }, name: 'fixture', input: {} }
  const pre = (payload = input) => agent.ctx.waterfall(scopeTarget(payload.agent, scopeOf(payload.agent.ctx)), 'agent/pre-step', payload, async () => ({ kind: 'enter', messages: [] }))
  const tool = () => agent.ctx.waterfall('tools/pre-execute', input, async () => ({ kind: 'deny', reason: 'independent guard' }))
  const post = () => agent.ctx.waterfall('tools/post-execute', input, { content: [] }, async () => ({ kind: 'block', feedback: [], marker: 'downstream' }))
  replace(false)
  assert.equal((await pre()).kind, 'reject')
  assert.equal((await tool()).reason, 'fixture refusal')
  await agent.ctx.serial('agent/turn-stopping', input)
  assert.equal(steers, 1)
  replace(true)
  assert.equal((await pre()).kind, 'enter')
  const originalPath = await realpath(createRequire(import.meta.url).resolve(`@deepseek-ai/dsh-hooks-${kind}`))
  const copy = join(dir, 'second')
  await mkdir(join(copy, 'lib'), { recursive: true })
  await copyFile(join(dirname(originalPath), '../package.json'), join(copy, 'package.json'))
  await copyFile(originalPath, join(copy, 'lib/index.js'))
  await mkdir(join(copy, 'node_modules/@deepseek-ai'), { recursive: true })
  const manifest = JSON.parse(await readFile(join(copy, 'package.json'), 'utf8'))
  for (const name of Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies })) {
    await symlink(await realpath(join(dirname(originalPath), '../../..', name)), join(copy, 'node_modules', name), 'junction')
  }
  const secondName = pathToFileURL(join(copy, 'lib/index.js')).href
  const second = await root.plugin(await import(secondName), { configPath: path })
  assert.equal((await pre()).kind, 'enter', '每一份实际挂载的官方同版本副本都应验证并接入')
  const broken = join(dir, 'broken')
  await mkdir(join(broken, 'lib'), { recursive: true })
  const brokenSource = (await readFile(originalPath, 'utf8')).replace('const detached', 'const  detached')
  await writeFile(join(broken, 'package.json'), await readFile(join(copy, 'package.json')))
  await writeFile(join(broken, 'lib/index.js'), brokenSource)
  await mkdir(join(broken, 'node_modules/@deepseek-ai'), { recursive: true })
  for (const name of Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies })) await symlink(await realpath(join(dirname(originalPath), '../../..', name)), join(broken, 'node_modules', name), 'junction')
  const brokenName = pathToFileURL(join(broken, 'lib/index.js')).href
  const brokenModule = await import(brokenName)
  const sibling = { id: `${kind}-sibling`, session, steer() {}, model: agent.model }
  const siblingScope = createScope(root, sibling)
  sibling.ctx = siblingScope.ctx
  const siblingOutcomes = []
  const siblingRuntime = createRuleRuntime(sibling.ctx, { agent: sibling, onOutcome: outcome => siblingOutcomes.push(outcome) })
  siblingRuntime.replace([{ moduleId: 'hook', rules: compileRules([{ ...card, enabled: true }]) }])
  const siblingBroken = await sibling.ctx.plugin(brokenModule, { configPath: path })
  assert.equal((await pre()).kind, 'enter', '同 root 不可达副本不能暂停其他 Agent')
  assert.equal((await pre({ ...input, agent: sibling })).kind, 'reject')
  assert.ok(siblingOutcomes.some(outcome => outcome.outcome === 'unavailable' && /artifact mismatch/.test(outcome.reason)))
  await siblingBroken.dispose()
  assert.equal((await pre({ ...input, agent: sibling })).kind, 'enter')
  siblingRuntime.dispose()
  await siblingScope.dispose()
  const brokenOwner = await root.plugin(brokenModule, { configPath: path })
  outcomes.length = 0
  assert.equal((await pre()).kind, 'reject', '实际失配副本暂停该 Agent 对应能力')
  assert.ok(outcomes.some(outcome => outcome.outcome === 'unavailable'), JSON.stringify(outcomes))
  await brokenOwner.dispose()
  assert.equal((await pre()).kind, 'enter', '移除失配副本后下一次重判恢复')
  await second.dispose()
  const cancelled = new AbortController()
  cancelled.abort()
  assert.equal((await pre({ ...input, signal: cancelled.signal })).kind, 'reject')
  assert.equal((await tool()).reason, 'independent guard')
  const result = await post()
  assert.equal(result.marker, 'downstream')
  assert.equal(result.additionalContexts[0].content[0].text, 'hook context')
  await agent.ctx.serial('agent/turn-stopping', input)
  assert.equal(steers, 1)
  outcomes.length = 0
  agent.model.current = () => { throw new Error('Hook cannot read next model') }
  const withoutModel = { ...input }
  delete withoutModel.modelSelection
  assert.equal((await pre(withoutModel)).kind, 'reject')
  assert.ok(outcomes.some(outcome => outcome.outcome === 'unavailable'))
  agent.model.current = () => ({ model: 'deepseek-flash' })
  let started
  const accepted = new Promise(resolve => { started = resolve })
  let release
  let gateResolve
  const gatePromise = new Promise(resolve => { gateResolve = resolve })
  gate = () => { started(); return gatePromise }
  release = gateResolve
  const pending = pre()
  await accepted
  replace(false)
  release()
  assert.equal((await pending).kind, 'enter')
  gate = undefined
  assert.equal((await pre()).kind, 'reject')
  replace(true)
  const during = new AbortController()
  const cancellationStarted = new Promise(resolve => { started = resolve })
  gate = () => { started(); return new Promise(resolve => { releases.push(resolve); release = () => { for (const resolve of releases.splice(0)) resolve() } }) }
  const cancelling = pre({ ...input, signal: during.signal })
  await cancellationStarted
  during.abort()
  release()
  assert.equal((await cancelling).kind, 'reject')
  gate = undefined
  if (kind === 'claude-code') {
    replace(false)
    ask = true
    assert.equal((await tool()).kind, 'ask')
    replace(true)
    assert.equal((await tool()).reason, 'independent guard')
  }
  assert.ok(calls > 5)
  assert.equal(events.filter(event => event.type === 'hook/invoked').length, events.filter(event => event.type === 'hook/result').length)
  assert.ok(events.some(event => event.type === 'hook/result'))
  ask = false
  const child = { id: `${kind}-child`, session, steer() {} }
  child.ctx = createScope(root, child, { parent: agent }).ctx
  const childRuntime = createRuleRuntime(child.ctx, { agent: child })
  childRuntime.replace([])
  assert.equal((await pre({ ...input, agent: child })).kind, 'reject')
  childRuntime.dispose()
  const isolated = new Context()
  await isolated.plugin(SystemPrompt)
  const otherAgent = { id: 'isolated', session, ctx: isolated }
  const otherOutcomes = []
  const otherRuntime = createRuleRuntime(isolated, { agent: otherAgent, onOutcome: outcome => otherOutcomes.push(outcome) })
  const body = (id, text) => ({ id, kind: 'inject-text', config: { layer: 'system-section', text } })
  otherRuntime.replace([{ moduleId: 'other', rules: compileRules([{ ...card, enabled: true,
    then: [{ if: { scope: { audience: 'main' } }, then: [...card.then, body('dependent', 'DEPENDENT HOOK BODY')] }, body('independent', 'INDEPENDENT BODY')] }]) }])
  assert.ok(otherOutcomes.some(outcome => outcome.channel === 'host:provider-hook-decisions' && outcome.outcome === 'unavailable'))
  let prompt
  await isolated.plugin({ inject: ['systemPrompt'], apply(ctx) { prompt = ctx.systemPrompt } })
  const assembly = await prompt.assemble({ agent: otherAgent, signal })
  assert.equal(assembly.sections.some(section => section.text.includes('DEPENDENT HOOK BODY')), false)
  assert.ok(assembly.sections.some(section => section.text.includes('INDEPENDENT BODY')))
  otherRuntime.dispose()
  await isolated.fiber.dispose()
  const disposalStarted = new Promise(resolve => { started = resolve })
  gate = () => { started(); return new Promise(resolve => { releases.push(resolve); release = () => { for (const resolve of releases.splice(0)) resolve() } }) }
  const disposing = pre()
  await disposalStarted
  await hook.dispose()
  release()
  assert.equal((await disposing).kind, 'reject')
  gate = undefined
  const malformed = await root.plugin(await import(`@deepseek-ai/dsh-hooks-${kind}`), { configPath: join(dir, 'missing.json') })
  outcomes.length = 0
  replace(true)
  assert.ok(outcomes.some(outcome => outcome.channel === 'host:provider-hook-decisions' && outcome.outcome === 'unavailable'))
  await malformed.dispose()
  const restored = await root.plugin(await import(`@deepseek-ai/dsh-hooks-${kind}`), { configPath: path })
  assert.equal((await pre()).kind, 'enter')
  await assemblyScope.dispose()
  ask = false
  assert.equal((await pre()).kind, 'reject')
  await restored.dispose()
})
