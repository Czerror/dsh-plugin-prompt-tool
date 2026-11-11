import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import * as Native from '@deepseek-ai/dsh-tool-executor-native'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { compileRules } from '../../engine/rule-spec.mjs'
import { createRuleRuntime } from '../../engine/rule-runtime.mjs'
import { delegationLimitsState } from '../../engine/delegation-limits.mjs'

const control = value => ({ id: 'control', kind: 'host-control', capability: 'delegation-limits', value })
const source = (moduleId, value) => ({ moduleId, rules: compileRules([{ id: 'limits', then: [control(value)] }], { moduleId }) })

test('委派额度沿普通规则校验，同值共存，异值候选拒绝并保留原贡献', async t => {
  const root = new Context()
  await root.plugin(SystemPrompt)
  const agent = { id: 'delegation-candidate', session: { id: 'delegation-candidate', header: {}, snapshotEvents: () => [] } }
  agent.ctx = createScope(root, agent).ctx
  const runtime = createRuleRuntime(agent.ctx, { agent })
  t.after(async () => { runtime.dispose(); await root.fiber.dispose() })
  for (const value of [{}, { maxDepth: -1 }, { askTimeout: 0 }, { askTimeout: 2147484 }, { maxDepth: '2e' }, { unknown: 2 }]) {
    assert.throws(() => source('bad', value), /delegation-limits/)
  }
  for (const field of ['maxDepth', 'askTimeout']) {
    const good = [source('a', { [field]: 10 }), source('b', { [field]: 10 })]
    assert.doesNotThrow(() => runtime.replace(good))
    assert.throws(() => runtime.replace([...good, source('c', { [field]: 11 })]), new RegExp(`${field}.*conflict`))
    assert.doesNotThrow(() => runtime.replace(good))
  }
})

test('缺少委派owner只暂停关联正文，独立规则与主子受众保持', async t => {
  const root = new Context()
  await root.plugin(SystemPrompt)
  await root.plugin(Tools)
  await root.plugin(Native)
  const agent = { id: 'delegation-main', session: { id: 'delegation-main', header: {}, snapshotEvents: () => [] } }
  agent.ctx = createScope(root, agent).ctx
  const observations = []
  const runtime = createRuleRuntime(agent.ctx, { agent, onOutcome: value => observations.push(value) })
  t.after(async () => { runtime.dispose(); await root.fiber.dispose() })
  const body = (id, text) => ({ id, kind: 'inject-text', config: { layer: 'system-section', text } })
  const rules = compileRules([{ id: 'dependent', then: [{ if: { scope: { audience: 'main' } }, then: [
    control({ maxDepth: 10 }), body('dependent', 'DEPENDENT DELEGATION BODY'),
  ] }, body('sibling', 'INDEPENDENT SIBLING')] }, { id: 'child', if: { scope: { audience: 'subagent' } }, then: [control({ askTimeout: 80 })] }])
  runtime.replace([{ moduleId: 'delegation', rules }])
  let services
  await agent.ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(ctx) { services = { tools: ctx.tools, prompt: ctx.systemPrompt } } })
  for (let index = 0; index < 2; index++) {
    const context = { agent, scope: scopeOf(agent.ctx), signal: new AbortController().signal }
    const toolSet = await services.tools.resolve(context)
    const assembly = await services.prompt.assemble({ ...context, toolSet })
    assert.equal(assembly.sections.some(value => value.text.includes('DEPENDENT DELEGATION BODY')), false)
    assert.ok(assembly.sections.some(value => value.text.includes('INDEPENDENT SIBLING')))
    toolSet.dispose()
  }
  assert.equal(rules[0].enabled, true)
  assert.ok(observations.some(value => value.channel === 'host:delegation-limits' && value.outcome === 'unavailable'))
  assert.ok(observations.some(value => value.channel === 'host:delegation-limits' && value.ruleId === 'child' && value.identityOutcome === 'condition-miss'))
})

test('真实工具出口保留已接受额度，热改和关闭仅作用后续步骤，超时与取消沿调用信号', async t => {
  const root = new Context()
  await root.plugin(SystemPrompt)
  await root.plugin(Tools)
  await root.plugin(Native)
  root.provide('subagents', { getProvider: () => ({ capabilities: { depthLimit: true } }) })
  root.provide('userQuestions', { askTimed() {} })
  const previous = { maxDepth: { ...delegationLimitsState.maxDepth }, askTimeout: { ...delegationLimitsState.askTimeout } }
  delegationLimitsState.maxDepth.available = delegationLimitsState.askTimeout.available = true
  const agent = { id: 'delegation-execute', session: { id: 'delegation-execute', header: {}, snapshotEvents: () => [] } }
  agent.ctx = createScope(root, agent).ctx
  let hot = 'no'
  const runtime = createRuleRuntime(agent.ctx, { agent, variableStore: { read: () => ({ effective: { hot } }) } })
  t.after(async () => {
    runtime.dispose(); await root.fiber.dispose()
    Object.assign(delegationLimitsState.maxDepth, previous.maxDepth)
    Object.assign(delegationLimitsState.askTimeout, previous.askTimeout)
  })
  let tools, prompt
  let questionMode = 'inspect', waiting, answer
  runtime.replace([source('a', { maxDepth: 10 }), {
    moduleId: 'question', rules: compileRules([{ id: 'legal-question',
      if: { variable: { key: 'hot', value: 'no' } }, then: [control({ askTimeout: 300 })],
    }], { moduleId: 'question' }),
  }, {
    moduleId: 'dynamic', rules: compileRules([{ id: 'dynamic-conflict',
      if: { variable: { key: 'hot', value: 'yes' } }, then: [control({ maxDepth: 11, askTimeout: 80 })],
    }], { moduleId: 'dynamic' }),
  }])
  await agent.ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(ctx) {
    tools = ctx.tools; prompt = ctx.systemPrompt
    for (const [kind, name] of [['maxDepth', 'subagent'], ['askTimeout', 'ask_user_question']]) {
      ctx.effect(() => ctx.tools.register(delegationLimitsState.mark(kind, ctx, { name, description: name,
        parameters: { type: 'object', properties: { timeout: { type: 'integer' }, depth: { type: 'integer' } } },
        output: { schema: { type: 'number' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
        execute: (args, exec) => {
          if (kind === 'maxDepth') return delegationLimitsState.depth(ctx, args.depth) ?? 1
          if (questionMode === 'inspect') return args.timeout ?? 120
          return new Promise((resolve, reject) => {
            const timer = setTimeout(() => resolve(0), args.timeout * 1000)
            answer = () => { clearTimeout(timer); resolve(1) }
            exec.signal.addEventListener('abort', () => { clearTimeout(timer); reject(exec.signal.reason) }, { once: true })
            waiting.resolve()
          })
        },
      })))
    }
  } })
  const prepare = async () => {
    const context = { agent, scope: scopeOf(agent.ctx), signal: new AbortController().signal }
    const toolSet = await tools.resolve(context)
    await prompt.assemble({ ...context, toolSet })
    return { ...context, toolSet }
  }
  const call = async (frame, name, args) => (await tools.execute({ ...frame, calls: [{ type: 'tool-call', id: name, name, arguments: JSON.stringify(args) }] })).results[0].result
  const first = await prepare()
  assert.match(first.toolSet.view(agent).get('subagent').description, /10/)
  assert.match(first.toolSet.view(agent).get('ask_user_question').description, /300/)
  assert.equal((await call(first, 'subagent', {})).value, 10)
  assert.equal((await call(first, 'ask_user_question', { timeout: -1 })).value, 300)
  hot = 'yes'
  assert.throws(() => runtime.prepareAssembly({}), /delegation-limits.*maxDepth.*conflict/)
  const rejected = { agent, scope: scopeOf(agent.ctx), signal: new AbortController().signal }
  rejected.toolSet = await tools.resolve(rejected)
  try {
    await assert.rejects(() => prompt.assemble(rejected), /delegation-limits.*conflict/)
  } finally { rejected.toolSet.dispose() }
  assert.equal((await call(first, 'subagent', {})).value, 10)
  assert.equal((await call(first, 'ask_user_question', { timeout: -1 })).value, 300)
  hot = 'no'
  const recovered = await prepare()
  assert.equal((await call(recovered, 'subagent', {})).value, 10)
  assert.equal((await call(recovered, 'ask_user_question', { timeout: -1 })).value, 300)
  recovered.toolSet.dispose()
  runtime.replace([source('a', { maxDepth: 7, askTimeout: 80 })])
  const second = await prepare()
  assert.equal((await call(second, 'subagent', {})).value, 7)
  assert.equal((await call(second, 'ask_user_question', { timeout: -1 })).value, 80)
  assert.equal((await call(first, 'ask_user_question', { timeout: -1 })).value, 300)
  assert.equal((await call(second, 'subagent', { depth: 3 })).value, 3)
  runtime.replace([])
  const closed = await prepare()
  assert.equal((await call(closed, 'subagent', {})).value, 1)
  assert.equal((await call(closed, 'ask_user_question', { timeout: -1 })).value, -1)
  assert.equal((await call(second, 'ask_user_question', {})).value, 120)
  questionMode = 'wait'
  t.mock.timers.enable({ apis: ['setTimeout'] })
  waiting = Promise.withResolvers()
  const timed = call(second, 'ask_user_question', { timeout: -1 })
  await waiting.promise
  t.mock.timers.tick(79999)
  let settled = false
  timed.then(() => { settled = true })
  await Promise.resolve()
  assert.equal(settled, false)
  t.mock.timers.tick(1)
  assert.equal((await timed).value, 0)
  waiting = Promise.withResolvers()
  const answered = call(first, 'ask_user_question', { timeout: -1 })
  await waiting.promise
  t.mock.timers.tick(1000)
  answer()
  assert.equal((await answered).value, 1)
  waiting = Promise.withResolvers()
  const cancellation = new AbortController()
  const cancelled = call({ ...second, signal: cancellation.signal }, 'ask_user_question', { timeout: -1 })
  await waiting.promise
  cancellation.abort(new Error('caller cancelled'))
  const cancellationResult = await cancelled
  assert.equal(cancellationResult.isError, true)
  assert.match(cancellationResult.error.message, /caller cancelled/)
  t.mock.timers.reset()
  for (const frame of [first, second, closed]) frame.toolSet.dispose()
})
