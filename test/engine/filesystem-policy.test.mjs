import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
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

test('真实工具exec读取各自规则快照，围栏和观察独立且关闭后不改旧步骤', async t => {
  const previous = new Map(state.status)
  const root = new Context()
  root.provide('fs', {})
  await root.plugin(SystemPrompt)
  await root.plugin(Tools)
  await root.plugin(Native)
  const agent = { id: 'file-tool', session: { id: 'file-tool', header: {}, snapshotEvents: () => [] } }
  agent.ctx = createScope(root, agent).ctx
  const runtime = createRuleRuntime(agent.ctx, { agent })
  runtime.replace([{ moduleId: 'files', rules: compileRules([{ id: 'initial', then: [
    { id: 'policy', kind: 'host-control', capability: 'filesystem-fence', value: true },
  ] }]) }])
  t.after(async () => { runtime.dispose(); await root.fiber.dispose(); state.status.clear(); for (const [key, value] of previous) state.status.set(key, value) })
  let tools, prompt, owner
  await agent.ctx.plugin({ inject: ['tools', 'systemPrompt', 'fs'], apply(ctx) {
    tools = ctx.tools; prompt = ctx.systemPrompt; owner = ctx
    state.provider(ctx, ctx.get('fs')); state.observer(ctx)
    for (const id of ['fence', 'tool', 'observation']) state.status.set(id, { available: true, reason: '' })
    ctx.effect(() => ctx.tools.register({ name: 'inspect_file_policy', description: 'policy fixture',
      parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute(_args, exec) {
        const policy = state.policy({ mode: 'read-only' }, exec)
        return JSON.stringify([state.fence(policy, ctx), state.intent(exec, ctx), policy.mode])
      },
    }))
  } })
  const replace = capability => runtime.replace(capability === undefined ? [] : [{ moduleId: 'files', rules: compileRules([
    { id: 'selected', then: [{ id: 'policy', kind: 'host-control', capability, value: true }] },
  ]) }])
  const prepare = async () => {
    const context = { agent, scope: scopeOf(agent.ctx), signal: new AbortController().signal }
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
  replace('filesystem-observation')
  assert.equal(await call(await prepare()), '[false,true,"read-only"]')
  replace(undefined)
  assert.equal(await call(await prepare()), '[false,false,"read-only"]')
  assert.equal(await call(first), '[true,false,"read-only"]')
  await owner.fiber.dispose()
  assert.equal(state.fence({}, owner), false)
})
