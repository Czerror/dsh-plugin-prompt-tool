import test from 'node:test'
import assert from 'node:assert/strict'
import { Context, Service } from '@deepseek-ai/cordis'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import * as Native from '@deepseek-ai/dsh-tool-executor-native'
import { compileRules } from '../../engine/rule-spec.mjs'
import { createRuleRuntime } from '../../engine/rule-runtime.mjs'
import { filesystemPolicyState as state, filesystemPolicyStatus } from '../../engine/filesystem-policy.mjs'

test('文件策略缺少真实owner只暂停依赖分支，独立正文仍投递且启用意图保留', async t => {
  const root = new Context()
  await root.plugin(SystemPrompt)
  await root.plugin(Tools)
  await root.plugin(Native)
  const agent = { id: 'filesystem', session: { id: 'filesystem', header: {}, snapshotEvents: () => [] } }
  agent.ctx = createScope(root, agent).ctx
  const outcomes = []
  const runtime = createRuleRuntime(agent.ctx, { agent, onOutcome: value => outcomes.push(value) })
  t.after(async () => { runtime.dispose(); await root.fiber.dispose() })
  const body = (id, text) => ({ id, kind: 'inject-text', config: { layer: 'system-section', text } })
  const rules = compileRules([{ id: 'files', then: [
    { if: { scope: { audience: 'main' } }, then: [
      { id: 'fence', kind: 'host-control', capability: 'filesystem-fence', value: true }, body('dependent', 'DEPENDENT FILE BODY'),
  ] }, body('sibling', 'SIBLING FILE BODY'),
  ] }])
  runtime.replace([{ moduleId: 'files', rules }])
  let services
  await agent.ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(ctx) { services = { tools: ctx.tools, prompt: ctx.systemPrompt } } })
  const context = { agent, scope: scopeOf(agent.ctx), signal: new AbortController().signal }
  const toolSet = await services.tools.resolve(context)
  const assembly = await services.prompt.assemble({ ...context, toolSet })
  assert.equal(assembly.sections.some(section => section.text.includes('DEPENDENT FILE BODY')), false)
  assert.ok(assembly.sections.some(section => section.text.includes('SIBLING FILE BODY')))
  assert.equal(rules[0].enabled, true)
  assert.ok(outcomes.some(value => value.channel === 'host:filesystem-fence' && value.outcome === 'unavailable'))
  toolSet.dispose()
})

test('真实Cordis工具策略按Agent隔离，压缩重判、取消及owner释放保留边界', async t => {
  const previous = new Map(state.status)
  const root = new Context()
  let provider
  class MemoryFilesystem extends Service {
    constructor(ctx) {
      super(ctx, 'fs')
      provider = ctx
      state.provider(ctx, this)
    }
  }
  await root.plugin(MemoryFilesystem)
  await root.plugin(SystemPrompt)
  await root.plugin(Tools)
  await root.plugin(Native)
  const events = []
  const agent = { id: 'file-tool', session: { id: 'file-tool', header: {}, snapshotEvents: () => events } }
  agent.ctx = createScope(root, agent).ctx
  const child = { id: 'file-child', session: { id: 'file-child', header: {}, snapshotEvents: () => [] } }
  child.ctx = createScope(root, child, { parent: agent }).ctx
  const childRuntime = createRuleRuntime(child.ctx, { agent: child })
  childRuntime.replace([])
  const runtime = createRuleRuntime(agent.ctx, { agent })
  runtime.replace([{ moduleId: 'files', rules: compileRules([{ id: 'initial', then: [
    { id: 'policy', kind: 'host-control', capability: 'filesystem-fence', value: true },
  ] }]) }])
  t.after(async () => { runtime.dispose(); childRuntime.dispose(); await root.fiber.dispose(); state.status.clear(); for (const [key, value] of previous) state.status.set(key, value) })
  let tools, prompt, owner
  await root.plugin({ inject: ['fs'], apply(ctx) {
    owner = ctx
    state.observer(ctx)
  } })
  await root.plugin({ inject: ['tools', 'systemPrompt'], apply(ctx) {
    tools = ctx.tools; prompt = ctx.systemPrompt
    for (const id of ['fence', 'tool', 'observation']) state.status.set(id, { available: true, reason: '' })
    ctx.effect(() => ctx.tools.register({ name: 'inspect_file_policy', description: 'policy fixture',
      parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute(_args, exec) {
        const policy = state.policy({ mode: 'read-only' }, exec)
        return JSON.stringify([state.fence(policy, provider), state.intent(exec, owner), policy.mode])
      },
    }))
  } })
  const replace = capability => runtime.replace(capability === undefined ? [] : [{ moduleId: 'files', rules: compileRules([
    { id: 'selected', then: [{ id: 'policy', kind: 'host-control', capability, value: true }] },
  ]) }])
  const prepare = async (subject = agent) => {
    const context = { agent: subject, scope: scopeOf(subject.ctx), signal: new AbortController().signal }
    const toolSet = await tools.resolve(context)
    await prompt.assemble({ ...context, toolSet })
    t.after(() => toolSet.dispose())
    return { ...context, toolSet }
  }
  const call = async frame => (await tools.execute({ ...frame, calls: [{ type: 'tool-call', id: 'policy', name: 'inspect_file_policy', arguments: '{}' }] })).results[0].result.value
  replace('filesystem-fence')
  const first = await prepare()
  assert.equal(filesystemPolicyStatus('filesystem-fence', agent).available, true)
  assert.equal(await call(first), '[true,false,"read-only"]')
  const childStep = await prepare(child)
  assert.equal(await call(childStep), '[false,false,"read-only"]')
  assert.equal(await call(first), '[true,false,"read-only"]')
  replace('filesystem-observation')
  const observed = await prepare()
  assert.equal(await call(observed), '[false,true,"read-only"]')
  assert.equal(await call(childStep), '[false,false,"read-only"]')
  replace(undefined)
  assert.equal(await call(await prepare()), '[false,false,"read-only"]')
  assert.equal(await call(first), '[true,false,"read-only"]')
  runtime.replace([{ moduleId: 'files', rules: compileRules([{ id: 'before-compaction',
    if: { phase: { promoted: 'ignore', compacted: false } },
    then: [{ id: 'policy', kind: 'host-control', capability: 'filesystem-fence', value: true }],
  }]) }])
  assert.equal(await call(await prepare()), '[true,false,"read-only"]')
  const compact = { seq: events.length, type: 'compaction/end', data: {} }
  events.push(compact)
  await root.emit('session/event', agent.session, compact)
  assert.equal(await call(await prepare()), '[false,false,"read-only"]')
  assert.equal(await call(first), '[true,false,"read-only"]')
  assert.equal(await call(childStep), '[false,false,"read-only"]')
  assert.equal(await call(await prepare(child)), '[false,false,"read-only"]')
  const cancelled = new AbortController()
  const failure = new Error('filesystem assembly cancelled')
  const cancelledContext = { agent, scope: scopeOf(agent.ctx), signal: cancelled.signal }
  const cancelledSet = await tools.resolve(cancelledContext)
  t.after(() => cancelledSet.dispose())
  cancelled.abort(failure)
  await assert.rejects(prompt.assemble({ ...cancelledContext, toolSet: cancelledSet }), error => error === failure)
  assert.equal(await call(first), '[true,false,"read-only"]')
  await owner.fiber.dispose()
  assert.equal(await call(observed), '[false,false,"read-only"]')
  assert.equal(await call(first), '[true,false,"read-only"]')
  await provider.fiber.dispose()
  assert.equal(await call(first), '[false,false,"read-only"]')
})
