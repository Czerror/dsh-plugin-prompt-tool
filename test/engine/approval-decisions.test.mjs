import '../../engine/instructions-budget-early.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
const { default: Tools } = await import('@deepseek-ai/dsh-tools')
const Native = await import('@deepseek-ai/dsh-tool-executor-native')
const { default: Approval } = await import('@deepseek-ai/dsh-user-approval')
const AutoReview = await import('@deepseek-ai/dsh-experimental-auto-review')
import { compileRules } from '../../engine/rule-spec.mjs'
import { createRuleRuntime } from '../../engine/rule-runtime.mjs'

test('审批owner缺失仅暂停命中依赖分支并保留独立正文', async t => {
  const root = new Context()
  await root.plugin(SystemPrompt)
  await root.plugin(Tools)
  await root.plugin(Native)
  const agent = { id: 'approval', session: { id: 'approval', header: {}, snapshotEvents: () => [] } }
  agent.ctx = createScope(root, agent).ctx
  const outcomes = []
  const runtime = createRuleRuntime(agent.ctx, { agent, onOutcome: value => outcomes.push(value) })
  t.after(async () => { runtime.dispose(); await root.fiber.dispose() })
  const body = (id, text) => ({ id, kind: 'inject-text', config: { layer: 'system-section', text } })
  runtime.replace([{ moduleId: 'approval', rules: compileRules([{ id: 'approval', then: [
    { if: { scope: { audience: 'main' } }, then: [
      { id: 'grant', kind: 'host-control', capability: 'approval-decisions', value: { autoGrant: true } },
      body('dependent', 'DEPENDENT APPROVAL BODY'),
    ] },
    body('independent', 'INDEPENDENT BODY'),
  ] }]) }])
  let services
  await agent.ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(ctx) { services = { tools: ctx.tools, prompt: ctx.systemPrompt } } })
  const context = { agent, scope: scopeOf(agent.ctx), signal: new AbortController().signal }
  const toolSet = await services.tools.resolve(context)
  t.after(() => toolSet.dispose())
  const assembly = await services.prompt.assemble({ ...context, toolSet })
  assert.equal(assembly.sections.some(section => section.text.includes('DEPENDENT APPROVAL BODY')), false)
  assert.ok(assembly.sections.some(section => section.text.includes('INDEPENDENT BODY')))
  assert.ok(outcomes.some(value => value.channel === 'host:approval-decisions' && value.outcome === 'unavailable'))
})

test('真实工具管线按已接受步骤放行缺审批服务的ask，独立deny仍拒绝', async t => {
  const root = new Context()
  await root.plugin(SystemPrompt)
  await root.plugin(Tools)
  await root.plugin(Native)
  const agent = { id: 'ask', session: { id: 'ask', header: {}, snapshotEvents: () => [] } }
  agent.ctx = createScope(root, agent).ctx
  const runtime = createRuleRuntime(agent.ctx, { agent })
  t.after(async () => { runtime.dispose(); await root.fiber.dispose() })
  runtime.replace([{ moduleId: 'approval', rules: compileRules([{ id: 'ask', then: [
    { id: 'allow-ask', kind: 'host-control', capability: 'approval-decisions', value: { toolAskAllow: true } },
  ] }]) }])
  assert.throws(() => runtime.replace([{ moduleId: 'approval', rules: compileRules([{ id: 'conflict', then: [
    { id: 'yes', kind: 'host-control', capability: 'approval-decisions', value: { toolAskAllow: true } },
    { id: 'no', kind: 'host-control', capability: 'approval-decisions', value: { toolAskAllow: false } },
  ] }]) }]), /toolAskAllow conflict/)
  let tools, prompt, calls = 0, deny = false
  await root.plugin({ inject: ['tools', 'systemPrompt'], apply(ctx) {
    tools = ctx.tools; prompt = ctx.systemPrompt
    ctx.effect(() => ctx.tools.register({ name: 'in_memory_approval_fixture', description: 'In-memory fixture',
      parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute() { calls++; return 'executed once' },
    }))
    ctx.on('tools/pre-execute', () => Promise.resolve(deny ? { kind: 'deny', reason: 'independent guard' } : { kind: 'ask' }))
  } })
  const context = { agent, scope: scopeOf(agent.ctx), signal: new AbortController().signal }
  const toolSet = await tools.resolve(context)
  await prompt.assemble({ ...context, toolSet })
  t.after(() => toolSet.dispose())
  const call = () => tools.execute({ ...context, toolSet, calls: [{ type: 'tool-call', id: 'ask', name: 'in_memory_approval_fixture', arguments: '{}' }] })
  const allowed = await call()
  assert.equal(allowed.results[0].result.value, 'executed once')
  assert.equal(calls, 1)
  deny = true
  await call()
  assert.equal(calls, 1)
  deny = false
  runtime.replace([])
  const freshSet = await tools.resolve(context)
  await prompt.assemble({ ...context, toolSet: freshSet })
  t.after(() => freshSet.dispose())
  await tools.execute({ ...context, toolSet: freshSet, calls: [{ type: 'tool-call', id: 'withdrawn', name: 'in_memory_approval_fixture', arguments: '{}' }] })
  assert.equal(calls, 1, 'source withdrawal restores the original refusal on subsequent accepted steps')
})

test('真实审批审计与自动审核owner独立接受快照，取消、隔离和释放保留原边界', async t => {
  const root = new Context()
  const events = [{ type: 'turn/start', data: { turn: 1 } }]
  let onAsked, background
  const session = { id: 'approval-owner', header: {}, snapshotEvents: () => events,
    append(type, data) { const event = { type, data, seq: events.length }; events.push(event); if (type === 'approval/asked') onAsked?.(); return event } }
  root.provide('sessionProjections', { register: async definition => ({ stateOf: target => target.snapshotEvents().reduce((state, event) => definition.apply(state, event), definition.init()) }) })
  root.provide('permissionPresets', { current: () => 'auto', registerAuto: () => () => {} })
  let modelCalls = 0, reviewEntries = 0
  root.provide('llm', { stream() { modelCalls++; throw new Error('model forbidden in deterministic fixture') } })
  root.provide('sessions', { list: () => [] })
  root.provide('workingDirectory', { ensure: async () => { reviewEntries++; throw new Error('offline review sentinel') } })
  await root.plugin(SystemPrompt)
  await root.plugin(Tools)
  await root.plugin(Native)
  const approvalFiber = await root.plugin(Approval, { policy: 'never' })
  const reviewFiber = await root.plugin(AutoReview)
  const agent = { id: 'owners', session }
  agent.ctx = createScope(root, agent).ctx
  const child = { id: 'child', session }
  child.ctx = createScope(root, child, { parent: agent }).ctx
  const ownerOutcomes = []
  const runtime = createRuleRuntime(agent.ctx, { agent, onOutcome: value => ownerOutcomes.push(value) })
  const childRuntime = createRuleRuntime(child.ctx, { agent: child })
  childRuntime.replace([])
  t.after(async () => { runtime.dispose(); childRuntime.dispose(); await root.fiber.dispose() })
  const replace = value => runtime.replace([{ moduleId: 'approval', rules: compileRules([{ id: 'decision', then: [
    { id: 'owner', kind: 'host-control', capability: 'approval-decisions', value },
  ] }]) }])
  await reviewFiber.dispose()
  replace({ autoGrant: true })
  let tools, prompt, approval, bodies = 0, deny = false, ask = true
  approval = agent.ctx.get('approval')
  await root.plugin({ inject: ['tools', 'systemPrompt'], apply(ctx) {
    tools = ctx.tools; prompt = ctx.systemPrompt
    ctx.effect(() => ctx.tools.register({ name: 'owner_memory_fixture', description: 'Memory fixture', parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute() { bodies++; return 'owner executed' },
    }))
    ctx.on('tools/pre-execute', () => Promise.resolve(deny ? { kind: 'deny', reason: 'independent guard' } : ask ? { kind: 'ask' } : { kind: 'allow' }))
  } })
  const prepare = async (subject = agent) => {
    const context = { agent: subject, scope: scopeOf(subject.ctx), signal: new AbortController().signal }
    const toolSet = await tools.resolve(context)
    await prompt.assemble({ ...context, toolSet })
    t.after(() => toolSet.dispose())
    return { ...context, toolSet }
  }
  const call = context => tools.execute({ ...context, calls: [{ type: 'tool-call', id: 'owner', name: 'owner_memory_fixture', arguments: '{}' }] })
  // P9独立对照：auto-review关闭后，真实never审批仍由P9改变，且审计成对。
  const granted = await prepare()
  onAsked = () => { onAsked = undefined; background = approval.request({ agent, toolName: 'unrelated-background' }) }
  const grantedResult = await call(granted)
  assert.equal(grantedResult.results[0].result.value, 'owner executed', JSON.stringify([grantedResult, ownerOutcomes]))
  assert.equal(await background, 'rejected', 'inherited ALS cannot grant another request while the original approval is pending')
  const audits = events.filter(event => event.type.startsWith('approval/'))
  assert.equal(audits.filter(event => event.type === 'approval/asked').length, 2)
  assert.deepEqual(audits.filter(event => event.type === 'approval/decided').map(event => event.data.outcome).sort(), ['allowed-once', 'rejected'])
  assert.equal(await approval.request({ agent, toolName: 'owner_memory_fixture' }), 'rejected', 'a direct request cannot borrow the accepted tool step')
  await call(await prepare(child))
  assert.equal(bodies, 1, 'child cannot inherit main Agent grant')
  const aborted = { ...granted, signal: AbortSignal.abort() }
  await call(aborted)
  assert.equal(bodies, 1)
  // P59单独开启只跳审核：原never审批仍拒绝，独立deny也必须保留。
  const activeReview = await root.plugin(AutoReview)
  replace({ autoReviewPassthrough: true })
  const reviewed = await prepare()
  await call(reviewed)
  assert.equal(bodies, 1)
  assert.equal(reviewEntries, 0)
  ask = false
  assert.equal((await call(reviewed)).results[0].result.value, 'owner executed')
  assert.equal(bodies, 2, 'P59 reaches the remaining public pipeline exactly once')
  deny = true
  await call(reviewed)
  assert.equal(bodies, 2)
  deny = false
  replace({ autoReviewPassthrough: false })
  await call(await prepare())
  assert.equal(reviewEntries, 1, 'closing P59 restores the actual review callback')
  await activeReview.dispose()
  await approvalFiber.dispose()
  replace({ autoGrant: true })
  ask = true
  await call(await prepare())
  assert.equal(bodies, 2, 'disposed approval owner cannot be revived')
  assert.equal(modelCalls, 0)
})
