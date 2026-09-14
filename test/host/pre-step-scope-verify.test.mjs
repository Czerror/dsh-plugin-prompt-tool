/**
 * W0 前置验证（PLAN.md §6.3）：固定版本真实 Cordis/scope 接线证明。
 *
 * 这些用例不使用假 ctx，而是用已安装的 @deepseek-ai/cordis、@deepseek-ai/dsh-scope
 * 与 @deepseek-ai/dsh-agent 的真实 dispatch（agentEvents → ctx.waterfall + scopeTarget），
 * 证明 W3 拟用的宿主机制成立：
 *   1. 全局（untagged）监听器收到任一本地 Agent 的 scoped pre-step，payload 携带真实
 *      agent/session，且 scopeOf(agent.ctx) 就是 agent 本身——协调器无需依赖 UI 选择。
 *   2. 父/子 scope：事件向上流动（祖先监听器收到后代事件）、注册层向下继承、
 *      最近 scope 遮蔽更远 scope；兄弟 scope 互不串。
 *   3. createScope/dispose 释放全部注册；dispose 后注册被拒。旧接线先撤、新接线再启的
 *      单执行器切换不会双跑。
 *   4. 真实 PreStepDecision：enter/reject 与 startsRequestSeries 透传。
 *   5. prepend 是 LIFO：与 context-gate 真实 apply() 共挂时 gate 仍在外层，
 *      注入消息进入 gate 的过滤视图，reject 不被下游吞掉。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { ScopedLayers, NamedEntries, bindScopeParent, createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import { apply as applyContextGate } from '../../engine/context-gate.mjs'
import { applyPromptConfigs, createPromptConfigs } from '../../engine/prompt-config-engine.mjs'

const ENGINE_DIR = new URL('../../engine/', import.meta.url).href

const signalOf = () => new AbortController().signal

/** 最小本地 Agent：session 形状对齐 executor/context-gate 的读取面。 */
const makeAgent = (id, model = 'verify-model') => ({
  session: { id, header: { delegationDepth: 0 }, snapshotEvents: () => [], deriveMessages: () => [] },
  options: { model },
})

const userMessage = (text, id = `u-${text}`) => ({
  id,
  role: 'user',
  content: [{ type: 'text', text }],
  source: { kind: 'user' },
})

/** 真实 scoped dispatch：agentEvents → ctx.waterfall(thisArg=carrier)。 */
const dispatch = (app, agent, next, messages = [userMessage('claimed')]) =>
  agentEvents(app, agent).waterfall('agent/pre-step', { messages, turn: 1, step: 1, signal: signalOf() }, next)

/** 挂 scope 的最小 Agent：agent.ctx 经 createScope 获得真实 scope tag（key=agent）。 */
const scopedAgent = (app, id) => {
  const agent = makeAgent(id)
  const scope = createScope(app, agent)
  agent.ctx = scope.ctx
  return { agent, scope }
}

const createLayers = () =>
  new ScopedLayers(
    () => ({
      entries: new NamedEntries((key) => new Error(`duplicate: ${key}`)),
      isEmpty() {
        return this.entries.isEmpty()
      },
    }),
    () => {},
  )

test('全局监听器收到任一本地 Agent 的 pre-step，scopeOf(agent.ctx) 指向 agent 本身', async () => {
  const app = new Context()
  const a = scopedAgent(app, 'agent-a')
  const b = scopedAgent(app, 'agent-b')
  const seen = []
  app.on('agent/pre-step', async ({ agent }, next) => {
    seen.push([agent.session.id, scopeOf(agent.ctx) === agent])
    return next()
  })
  await dispatch(app, a.agent, async () => ({ kind: 'enter', messages: [userMessage('a')] }))
  await dispatch(app, b.agent, async () => ({ kind: 'enter', messages: [userMessage('b')] }))
  assert.deepEqual(seen, [
    ['agent-a', true],
    ['agent-b', true],
  ])
})

test('父子 scope 事件向上流动、层向下继承并遮蔽；兄弟互不串', async () => {
  const app = new Context()
  const parent = scopedAgent(app, 'parent')
  const child = scopedAgent(app, 'child')
  const sibling = scopedAgent(app, 'sibling')
  bindScopeParent(child.agent, parent.agent)

  const seen = []
  parent.scope.ctx.on('agent/pre-step', async ({ agent }, next) => {
    seen.push(`parent:${agent.session.id}`)
    return next()
  })
  child.scope.ctx.on('agent/pre-step', async ({ agent }, next) => {
    seen.push(`child:${agent.session.id}`)
    return next()
  })
  const reject = async () => ({ kind: 'reject' })
  await dispatch(app, child.agent, reject)
  await dispatch(app, parent.agent, reject)
  await dispatch(app, sibling.agent, reject)
  // 祖先收到后代事件；后代不收到祖先；兄弟事件不进入别的 scope。
  assert.deepEqual(seen, ['parent:child', 'child:child', 'parent:parent'])

  const layers = createLayers()
  layers.effect(app, (layer) => layer.entries.insert('preset-a', 'GLOBAL'), { label: 'verify:global' })
  layers.effect(parent.scope.ctx, (layer) => layer.entries.insert('preset-a', 'PARENT'), { label: 'verify:parent' })
  layers.effect(child.scope.ctx, (layer) => layer.entries.insert('preset-b', 'CHILD'), { label: 'verify:child' })
  assert.deepEqual(
    [...layers.merge(child.agent, (layer) => layer.entries)],
    [
      ['preset-a', 'PARENT'],
      ['preset-b', 'CHILD'],
    ],
  )
  assert.deepEqual([...layers.merge(sibling.agent, (layer) => layer.entries)], [['preset-a', 'GLOBAL']], '兄弟看不到父/子 scope 的层')
  assert.equal(layers.peek(child.agent)?.entries.has('preset-a'), false, 'peek 只读自身贡献（chain-blind）')
})

test('dispose 释放注册并拒绝重注册；旧接线撤销后只剩新路径', async () => {
  const app = new Context()
  const { agent, scope } = scopedAgent(app, 'agent-switch')
  const calls = []
  scope.ctx.on('agent/pre-step', async (payload, next) => {
    calls.push('old')
    return next()
  })
  await dispatch(app, agent, async () => ({ kind: 'reject' }))
  await scope.dispose()
  await dispatch(app, agent, async () => ({ kind: 'reject' }))
  assert.deepEqual(calls, ['old'], 'dispose 后旧监听器不再收到事件')
  assert.throws(() => scope.ctx.on('agent/pre-step', () => {}), /inactive/i, 'dispose 后注册被拒')

  const nextScope = createScope(app, agent)
  agent.ctx = nextScope.ctx
  nextScope.ctx.on('agent/pre-step', async (payload, next) => {
    calls.push('new')
    return next()
  })
  await dispatch(app, agent, async () => ({ kind: 'reject' }))
  assert.deepEqual(calls, ['old', 'new'], '先撤旧再启新：任一时刻只有一条执行路径')
})

test('真实 PreStepDecision：enter/reject 与 startsRequestSeries 透传、监听器可改写 messages', async () => {
  const app = new Context()
  const { agent, scope } = scopedAgent(app, 'agent-decision')
  const extra = userMessage('injected', 'u-injected')
  scope.ctx.on('agent/pre-step', async (_payload, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    return { ...decision, messages: [...decision.messages, extra] }
  })
  const enter = await dispatch(app, agent, async () => ({
    kind: 'enter',
    messages: [userMessage('claimed')],
    startsRequestSeries: true,
  }))
  assert.equal(enter.kind, 'enter')
  assert.equal(enter.startsRequestSeries, true)
  assert.deepEqual(enter.messages.map((message) => message.id), ['u-claimed', 'u-injected'])

  const reject = await dispatch(app, agent, async () => ({ kind: 'reject' }))
  assert.deepEqual(reject, { kind: 'reject' })
})

test('prepend 监听按 LIFO 排在外层（W3 接线顺序约束）', async () => {
  const app = new Context()
  const order = []
  app.on('agent/pre-step', async (payload, next) => {
    order.push('prepend-first')
    return next()
  }, { prepend: true })
  app.on('agent/pre-step', async (payload, next) => {
    order.push('prepend-second')
    return next()
  }, { prepend: true })
  app.on('agent/pre-step', async (payload, next) => {
    order.push('normal')
    return next()
  })
  await app.waterfall(
    'agent/pre-step',
    { agent: makeAgent('agent-order'), messages: [], turn: 1, step: 1, signal: signalOf() },
    async () => ({ kind: 'reject' }),
  )
  assert.deepEqual(order, ['prepend-second', 'prepend-first', 'normal'])
})

test('context-gate 与 executor 真实共挂：gate 在外层过滤注入消息，reject 不被吞掉', async () => {
  const specs = [{ id: 'verify-injected', layer: 'pre-step', strategy: 'static', text: 'INJECTED', position: 'after-all' }]

  const gatedApp = new Context()
  const gated = scopedAgent(gatedApp, 'agent-gated')
  applyContextGate(gatedApp, { allowKinds: ['user'] })
  applyPromptConfigs(gatedApp, createPromptConfigs(specs, { strategyDir: ENGINE_DIR }))
  const gatedClaimed = userMessage('claimed', 'u-gated-claimed')
  const gatedDecision = await dispatch(
    gatedApp,
    gated.agent,
    async () => ({ kind: 'enter', messages: [gatedClaimed] }),
    [gatedClaimed],
  )
  assert.deepEqual(
    gatedDecision.messages.map((message) => message.id),
    ['u-gated-claimed'],
    'gate 在 executor 外层：该步注入的 verify-injected 消息被 allowKinds 过滤',
  )

  // 对照：无 gate 时同一配置确实注入，证明上面的过滤不是"注入压根没发生"。
  const plainApp = new Context()
  const bare = scopedAgent(plainApp, 'agent-bare')
  applyPromptConfigs(plainApp, createPromptConfigs(specs, { strategyDir: ENGINE_DIR }))
  const bareClaimed = userMessage('claimed', 'u-bare-claimed')
  const bareDecision = await dispatch(plainApp, bare.agent, async () => ({ kind: 'enter', messages: [bareClaimed] }), [bareClaimed])
  assert.equal(bareDecision.messages.length, 2)
  assert.equal(bareDecision.messages[1].source.kind, 'verify-injected')

  const reject = await dispatch(gatedApp, gated.agent, async () => ({ kind: 'reject' }), [gatedClaimed])
  assert.deepEqual(reject, { kind: 'reject' }, 'reject 不被门控或执行器吞掉')
})
