import SessionProjections from '@deepseek-ai/dsh-session-projection'
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
const { default: Tools } = await import('@deepseek-ai/dsh-tools')
const Native = await import('@deepseek-ai/dsh-tool-executor-native')
const { default: Approval } = await import('@deepseek-ai/dsh-user-approval')
import { compileRules } from '../../engine/rule-spec.mjs'
import { createRuleRuntime } from '../../engine/rule-runtime.mjs'

test('文件读取服务缺失仅暂停依赖分支并保留独立正文', async t => {
  const root = new Context()
  await root.plugin(SessionProjections)
  await root.plugin(SystemPrompt)
  await root.plugin(Tools)
  await root.plugin(Native)
  const agent = { id: 'files', session: { id: 'files', header: {}, snapshotEvents: () => [] } }
  agent.ctx = createScope(root, agent).ctx
  const outcomes = []
  const runtime = createRuleRuntime(agent.ctx, { agent, onOutcome: value => outcomes.push(value) })
  t.after(async () => { runtime.dispose(); await root.fiber.dispose() })
  const body = (id, text) => ({ id, kind: 'inject-text', config: { layer: 'system-section', text } })
  runtime.replace([{ moduleId: 'files', rules: compileRules([{ id: 'limits', then: [
    { if: { scope: { audience: 'main' } }, then: [
      { id: 'limit', kind: 'host-control', capability: 'file-read-limits', value: { limit: 10 } },
      body('dependent', 'DEPENDENT FILE BODY'),
    ] },
    body('independent', 'INDEPENDENT BODY'),
  ] }]) }])
  let services
  await agent.ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(ctx) { services = { tools: ctx.tools, prompt: ctx.systemPrompt } } })
  const context = { agent, scope: scopeOf(agent.ctx), signal: new AbortController().signal }
  const toolSet = await services.tools.resolve(context)
  t.after(() => toolSet.dispose())
  const assembly = await services.prompt.assemble({ ...context, toolSet })
  assert.equal(assembly.sections.some(section => section.text.includes('DEPENDENT FILE BODY')), false)
  assert.ok(assembly.sections.some(section => section.text.includes('INDEPENDENT BODY')))
  assert.ok(outcomes.some(value => value.channel === 'host:file-read-limits' && value.outcome === 'unavailable'))
})

test('alpha.2 保留真实审批拒绝与审计事件', async t => {
  const root = new Context()
  const events = [{ type: 'turn/start', data: { turn: 1 } }]
  const session = { id: 'approval-owner', header: {}, snapshotEvents: () => events,
    append(type, data) { const event = { type, data, seq: events.length }; events.push(event); return event } }
  root.provide('sessionProjections', { register: async definition => ({ stateOf: target => target.snapshotEvents().reduce((state, event) => definition.apply(state, event), definition.init()) }) })
  await root.plugin(SystemPrompt)
  await root.plugin(Tools)
  await root.plugin(Native)
  await root.plugin(Approval, { policy: 'never' })

  const agent = { id: 'owners', session }
  agent.ctx = createScope(root, agent).ctx
  const child = { id: 'child', session }
  child.ctx = createScope(root, child, { parent: agent }).ctx
  const runtime = createRuleRuntime(agent.ctx, { agent })
  const childRuntime = createRuleRuntime(child.ctx, { agent: child })
  childRuntime.replace([])
  t.after(async () => { runtime.dispose(); childRuntime.dispose(); await root.fiber.dispose() })
  runtime.replace([])
  let tools, prompt, bodies = 0
  await root.plugin({ inject: ['tools', 'systemPrompt'], apply(ctx) {
    tools = ctx.tools; prompt = ctx.systemPrompt
    ctx.effect(() => ctx.tools.register({ name: 'owner_memory_fixture', description: 'Memory fixture', parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute() { bodies++; return 'owner executed' },
    }))
    ctx.on('tools/pre-execute', () => Promise.resolve({ kind: 'ask' }))
  } })
  const prepare = async (subject = agent) => {
    const context = { agent: subject, scope: scopeOf(subject.ctx), signal: new AbortController().signal }
    const toolSet = await tools.resolve(context)
    await prompt.assemble({ ...context, toolSet })
    t.after(() => toolSet.dispose())
    return { ...context, toolSet }
  }
  const call = context => tools.execute({ ...context, calls: [{ type: 'tool-call', id: 'owner', name: 'owner_memory_fixture', arguments: '{}' }] })
  for (const subject of [agent, child]) {
    const result = await call(await prepare(subject))
    assert.equal(result.results[0].result.error.info.code, 'APPROVAL_REJECTED')
  }
  assert.equal(bodies, 0)
  assert.equal(events.filter(event => event.type === 'approval/asked').length, 2)
  assert.deepEqual(events.filter(event => event.type === 'approval/decided').map(event => event.data.outcome), ['rejected', 'rejected'])
})
