import '../../engine/instructions-budget-early.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { compileRules } from '../../engine/rule-spec.mjs'
import { createRuleRuntime } from '../../engine/rule-runtime.mjs'
import { escalationDecisionStatus } from '../../engine/escalation-decisions.mjs'
const { default: Tools } = await import('@deepseek-ai/dsh-tools')
const Native = await import('@deepseek-ai/dsh-tool-executor-native')
const { default: Approval } = await import('@deepseek-ai/dsh-user-approval')
const require = createRequire(import.meta.url)
const ptcEntry = require.resolve('@deepseek-ai/dsh-tool-executor-ptc')
const Ptc = await import(pathToFileURL(ptcEntry).href)
const { default: PtcRuntime } = await import(pathToFileURL(createRequire(ptcEntry).resolve('@deepseek-ai/dsh-ptc-runtime')).href)

test('rc2 PTC真实调度按超时额度拒绝超额调用，并在取消后排空已启动调用', { timeout: 5000 }, async t => {
  const root = new Context()
  await root.plugin(SystemPrompt)
  await root.plugin(Tools)
  root.provide('workingDirectory', { ensure: async () => process.cwd() })
  let program, started = 0, finished = 0
  // 只替代进程执行边界；bindings、额度、排队和排空均由官方 PtcExecutor 持有。
  class BindingRuntime extends PtcRuntime {
    get language() { return 'typescript' }
    get timeout() { return { defaultMs: 60000, maxMs: 60000 } }
    resolve(request) { return { ...request, timeoutMs: request.timeoutMs ?? 60000 } }
    async run(spec) {
      try { return { logs: [], value: await program(spec.bindings[0].functions, spec.signal) } }
      catch (error) { return { logs: [], error: { kind: spec.signal.aborted ? 'abort' : 'runtime', message: error.message } } }
    }
  }
  await root.plugin(BindingRuntime)
  await root.plugin(Ptc, { maxSubCallsPerMinute: 2, maxParallelSubCalls: 1 })
  t.after(() => root.fiber.dispose())
  let entered, release
  root.tools.register({ name: 'memory_step', description: 'Memory-only scheduler observation',
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'number' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    async execute() { started++; entered?.resolve(); if (release) await release.promise; finished++; return finished },
  })
  const run = async (signal = new AbortController().signal, timeoutMs = 60000) => (await root.tools.execute({ signal,
    calls: [{ type: 'tool-call', id: 'scheduler', name: 'run_code', arguments: JSON.stringify({ code: '', description: 'Controlled process boundary', timeoutMs }) }],
  })).results[0].result
  program = async tools => [await tools.memory_step({}), await tools.memory_step({})]
  assert.deepEqual((await run()).value.result, [1, 2])
  const exceeded = await run(undefined, 30000)
  assert.equal(exceeded.isError, true)
  assert.match(exceeded.error.message, /limit of 1 tool calls.*call 2 was not dispatched/)
  assert.equal(started, 3, 'half-minute allowance dispatches only one body at two calls per minute')
  entered = Promise.withResolvers(); release = Promise.withResolvers()
  t.after(() => release.resolve())
  const cancellation = new AbortController()
  program = async tools => {
    const first = tools.memory_step({})
    const queued = tools.memory_step({})
    return Promise.all([first, queued])
  }
  let settled = false
  const pending = run(cancellation.signal).then(result => { settled = true; return result })
  await entered.promise
  cancellation.abort(new Error('caller scheduler cancellation'))
  await Promise.resolve()
  assert.equal(settled, false, 'started body must reach quiescence before cancellation settles')
  release.resolve()
  const cancelled = await pending
  assert.deepEqual(cancelled.error.info, { name: 'AbortError', code: 'ABORTED' })
  assert.equal(started, 4, 'queued second body is abandoned after cancellation')
  assert.equal(finished, 4, 'started body drains before result is delivered')
})

test('真实审批owner与工具步骤独立处理升级三分支、拒绝、撤回及任务取消', { timeout: 5000 }, async t => {
  const root = new Context()
  const events = [{ type: 'turn/start', data: { turn: 1 } }]
  const session = { id: 'escalation', header: {}, snapshotEvents: () => events,
    append(type, data) { const event = { type, data, seq: events.length }; events.push(event); return event } }
  root.provide('sessionProjections', { register: async definition => ({ stateOf: target => target.snapshotEvents().reduce((state, event) => definition.apply(state, event), definition.init()) }) })
  await root.plugin(SystemPrompt)
  await root.plugin(Tools)
  await root.plugin(Native)
  const approvalFiber = await root.plugin(Approval, { policy: 'ask' })
  let standing = 'workspace-write'
  root.provide('sandboxPolicy', { resolve: () => ({ mode: standing, writableRoots: [] }) })
  root.provide('workingDirectory', { ensure: async () => process.cwd() })
  const agent = { id: 'escalation', session }
  agent.ctx = createScope(root, agent).ctx
  const child = { id: 'child', session }
  child.ctx = createScope(root, child, { parent: agent }).ctx
  await child.ctx.plugin(Native)
  const outcomes = []
  const runtime = createRuleRuntime(agent.ctx, { agent, onOutcome: value => outcomes.push(value) })
  const childRuntime = createRuleRuntime(child.ctx, { agent: child, onOutcome: value => outcomes.push(value) })
  childRuntime.replace([])
  t.after(async () => { runtime.dispose(); childRuntime.dispose(); await root.fiber.dispose() })
  let outcome = 'rejected', bodies = 0, deny = false, mode = 'danger-full-access', tools, prompt, waitForApproval
  class MemoryRuntime extends PtcRuntime {
    get language() { return 'typescript' }
    get programFormat() { return 'function-body' }
    get sandboxMode() { return 'workspace-write' }
    resolve(request) { return request }
    async release() {}
    async run(request) { bodies++; return { logs: [], value: request.sandboxPolicy.mode } }
  }
  await root.plugin(MemoryRuntime)
  const ptcFiber = await agent.ctx.plugin(Ptc)
  await root.plugin({ inject: ['tools', 'systemPrompt'], apply(ctx) {
    tools = ctx.tools; prompt = ctx.systemPrompt
    ctx.on('approval/request', () => waitForApproval ? waitForApproval() : Promise.resolve(outcome))
    ctx.on('tools/pre-execute', () => Promise.resolve(deny ? { kind: 'deny', reason: 'independent refusal' } : { kind: 'ask' }))
  } })
  const replace = capabilities => {
    const sources = [{ moduleId: 'escalation', rules: compileRules([{ id: 'decision', then: [
    { id: 'ask', kind: 'host-control', capability: 'approval-decisions', value: { toolAskAllow: true } },
    { if: { scope: {} }, then: [
      ...capabilities.map(capability => ({ id: capability, kind: 'host-control', capability, value: true })),
      { id: 'dependent', kind: 'inject-text', config: { layer: 'system-section', text: 'DEPENDENT EXECUTOR BODY' } },
    ] },
    { id: 'independent', kind: 'inject-text', config: { layer: 'system-section', text: 'INDEPENDENT EXECUTOR BODY' } },
  ] }]) }]
    runtime.replace(sources); childRuntime.replace(sources)
  }
  const prepare = async (subject = agent) => {
    await subject.ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(ctx) { tools = ctx.tools; prompt = ctx.systemPrompt } })
    const context = { agent: subject, scope: scopeOf(subject.ctx), signal: new AbortController().signal }
    const toolSet = await tools.resolve(context)
    const assembly = await prompt.assemble({ ...context, toolSet })
    if (capabilityBodyCheck) {
      assert.equal(assembly.sections.some(section => section.text === 'DEPENDENT EXECUTOR BODY'), subject === agent && selectedPtc,
        `${subject.id}: actual selected executor controls dependent BODY`)
      assert.ok(assembly.sections.some(section => section.text === 'INDEPENDENT EXECUTOR BODY'))
    }
    t.after(() => toolSet.dispose())
    return { ...context, toolSet }
  }
  const call = async context => {
    const batch = await tools.execute({ ...context, calls: [{ type: 'tool-call', id: 'mode', name: 'run_code', arguments: JSON.stringify({ code: '', description: 'Memory-only mode consumer', sandbox_permissions: mode, justification: 'fixture' }) }] })
    return { ...batch, results: batch.results.map(item => ({ ...item, result: { ...item.result, value: item.result.value?.result } })) }
  }
  let capabilityBodyCheck = true
  let selectedPtc = true
  replace(['escalation-grant'])
  const granted = await prepare()
  await prepare(child)
  assert.ok(outcomes.some(value => value.agentId === child.id && value.outcome === 'unavailable'))
  capabilityBodyCheck = false
  const first = await call(granted)
  assert.equal(first.results[0].result.value, 'danger-full-access', JSON.stringify(first))
  assert.equal(events.filter(event => event.type === 'approval/asked').length, 0, 'P14 bypasses this approval only')
  const childContext = { agent: child, scope: scopeOf(child.ctx), signal: new AbortController().signal }
  const childToolSet = await tools.resolve(childContext)
  t.after(() => childToolSet.dispose())
  assert.equal(escalationDecisionStatus(child, { ...childContext, toolSet: childToolSet }).available, false,
    `子 Agent 的当前工具面不能继承父 Agent 的 PTC 可达性: ${JSON.stringify([...childToolSet.view(child).keys()])}`)
  replace([])
  await call(await prepare())
  assert.equal(bodies, 1, 'P62 alone cannot mask escalation rejection')
  replace(['escalation-criteria'])
  mode = 'workspace-write'; standing = 'danger-full-access'
  await call(await prepare())
  assert.equal(bodies, 1, 'P13 skips criteria but still respects a rejected grant')
  outcome = 'allowed-once'
  assert.equal((await call(await prepare())).results[0].result.value, 'workspace-write')
  mode = 'danger-full-access'; standing = 'workspace-write'
  replace(['escalation-outcome'])
  for (outcome of ['rejected', 'cancelled', 'unavailable']) assert.equal((await call(await prepare())).results[0].result.value, 'danger-full-access')
  const before = bodies
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  t.after(() => release.resolve('cancelled'))
  waitForApproval = () => { entered.resolve(); return release.promise }
  const cancellation = new AbortController()
  const pending = call({ ...await prepare(), signal: cancellation.signal })
  await entered.promise
  cancellation.abort(new Error('task total cancellation'))
  release.resolve('cancelled')
  await pending
  waitForApproval = undefined
  assert.equal(bodies, before, 'P35 cannot turn in-flight task cancellation into execution')
  await call(await prepare(child))
  assert.equal(bodies, before)
  deny = true
  await call(await prepare())
  assert.equal(bodies, before, 'independent tool rejection remains')
  deny = false
  await call({ ...await prepare(), signal: AbortSignal.abort() })
  assert.equal(bodies, before)
  replace([])
  await call(await prepare())
  assert.equal(bodies, before)
  assert.equal((await call(granted)).results[0].result.value, 'danger-full-access', 'accepted snapshot is unchanged by later rule replacement')
  for (const event of events.filter(event => event.type === 'approval/asked')) {
    assert.equal('toolSet' in event.data, false)
    assert.equal('modelSelection' in event.data, false)
  }
  await approvalFiber.dispose()
  replace(['escalation-criteria'])
  const noService = await call(await prepare())
  assert.equal(bodies, before + 1, 'P13 does not synthesize an absent approval service')
  assert.ok(noService.results[0].result.isError)
  await ptcFiber.dispose()
  await assert.rejects(call(granted), { code: 'TOOL_EXECUTOR_UNAVAILABLE' })
  await agent.ctx.plugin(Native)
  selectedPtc = false
  capabilityBodyCheck = true
  replace(['escalation-grant'])
  await prepare()
})

test('同名非官方caller不借其他已加载caller就绪，缺依赖仅暂停当前分支', async t => {
  const root = new Context()
  await root.plugin(SystemPrompt)
  await root.plugin(Tools)
  await root.plugin(Native)
  const agent = { id: 'unverified-caller', session: { id: 'unverified-caller', header: {}, snapshotEvents: () => [] } }
  agent.ctx = createScope(root, agent).ctx
  root.tools.register({ name: 'bash', description: 'Memory fixture with no official owner', parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: () => 'memory' })
  const outcomes = []
  const runtime = createRuleRuntime(agent.ctx, { agent, onOutcome: value => outcomes.push(value) })
  t.after(async () => { runtime.dispose(); await root.fiber.dispose() })
  const body = (id, text) => ({ id, kind: 'inject-text', config: { layer: 'system-section', text } })
  runtime.replace([{ moduleId: 'unverified', rules: compileRules([{ id: 'dependency', then: [
    { if: { scope: { audience: 'main' } }, then: [
      { id: 'escalation', kind: 'host-control', capability: 'escalation-grant', value: true }, body('dependent', 'DEPENDENT ESCALATION BODY'),
    ] }, body('independent', 'SIBLING ESCALATION BODY'),
  ] }]) }])
  let tools, prompt
  await agent.ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(ctx) { tools = ctx.tools; prompt = ctx.systemPrompt } })
  const context = { agent, scope: scopeOf(agent.ctx), signal: new AbortController().signal }
  const toolSet = await tools.resolve(context)
  t.after(() => toolSet.dispose())
  const assembly = await prompt.assemble({ ...context, toolSet })
  assert.equal(assembly.sections.some(section => section.text.includes('DEPENDENT ESCALATION BODY')), false)
  assert.ok(assembly.sections.some(section => section.text.includes('SIBLING ESCALATION BODY')))
  assert.ok(outcomes.some(value => value.outcome === 'unavailable'))
})
