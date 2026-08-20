import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createEpochPromotion,
  classifyReasoning,
  hasAnchoredReasoning,
} from '../../engine/compaction-epoch.mjs'
import { apply as applyToolBootstrap } from '../../engine/tool-bootstrap.mjs'
import { apply as applyContextGate } from '../../engine/context-gate.mjs'

/** 收集 ctx.on 注册的监听器（按注册顺序）。 */
function makeCtx() {
  const listeners = new Map()
  const ctx = {
    logger: { warn: () => {} },
    on(type, handler, opts) {
      const list = listeners.get(type) ?? []
      list.push({ handler, opts })
      listeners.set(type, list)
    },
  }
  return { ctx, listeners }
}

function makeSession(events = []) {
  return { id: `s-${Math.random()}`, header: { cwd: '/workspace', delegationDepth: 0 }, events }
}

const makeAgent = (session) => ({ session, ctx: { tools: { presentAs: () => () => {} } } })

const reasoning = (text) => ({ type: 'reasoning', text })
const textBlock = (text) => ({ type: 'text', text })
const assistantMessage = (content, seq = 1) => ({ type: 'assistant/message', seq, data: { message: { content } } })

// ── classifyReasoning / hasAnchoredReasoning ────────────────────────────────

test('classifyReasoning：we 且无 let me = minimal-like', () => {
  assert.equal(classifyReasoning('We should check the workspace first.').label, 'minimal-like')
  assert.equal(classifyReasoning('I will do it. Let me check.').label, 'standard-like')
  assert.equal(classifyReasoning('The task is unclear.').label, 'ambiguous')
})

test('hasAnchoredReasoning：只看首段 reasoning 块', () => {
  assert.equal(hasAnchoredReasoning([reasoning('We proceed.'), reasoning('Let me think.')]), true)
  assert.equal(hasAnchoredReasoning([reasoning('Let me think.'), reasoning('We proceed.')]), false)
  assert.equal(hasAnchoredReasoning([textBlock('no reasoning')]), false)
})

// ── createEpochPromotion 门控 ───────────────────────────────────────────────

test('门控关闭：事件级晋升行为不变（回归）', () => {
  const promo = createEpochPromotion(['tool/call', 'assistant/message'], {})
  const session = makeSession([])
  const agent = makeAgent(session)
  promo.status(agent) // 初始化 state（observe 为热路径，首次 status 冷扫）
  promo.observe(session, { type: 'tool/call', seq: 1 })
  assert.equal(promo.status(agent).promoted, true)
})

test('promoteGate：tool/call + minimal-like reasoning 才晋升', () => {
  const promo = createEpochPromotion([], { promoteGate: true, maxPromoteSteps: 4 })
  const session = makeSession([])
  const agent = makeAgent(session)
  promo.status(agent) // 初始化（state 空时 observe 是热路径，冷启动靠 status 扫 durable log）
  promo.observe(session, { type: 'tool/call', seq: 1 })
  promo.observe(session, assistantMessage([reasoning('Let me inspect.')], 2))
  assert.equal(promo.status(agent).promoted, false, 'standard-like reasoning 不晋升')
  promo.observe(session, assistantMessage([reasoning('We inspect now.')], 3))
  assert.equal(promo.status(agent).promoted, true, 'minimal-like reasoning 晋升')
})

test('promoteGate：maxPromoteSteps 回退晋升', () => {
  const promo = createEpochPromotion([], { promoteGate: true, maxPromoteSteps: 4 })
  const session = makeSession([])
  const agent = makeAgent(session)
  promo.status(agent)
  promo.observe(session, { type: 'tool/call', seq: 1 })
  promo.observe(session, assistantMessage([reasoning('Let me check.')], 2))
  for (let i = 0; i < 4; i += 1) promo.observe(session, { type: 'step/start', seq: 10 + i })
  assert.equal(promo.status(agent).promoted, true, '步数达到上限后回退晋升')
})

test('promoteAfterFirstResponse：无工具首响应也晋升', () => {
  const promo = createEpochPromotion([], { promoteAfterFirstResponse: true })
  const session = makeSession([])
  const agent = makeAgent(session)
  promo.status(agent)
  promo.observe(session, assistantMessage([textBlock('ok')], 1))
  assert.equal(promo.status(agent).promoted, true)
})

test('promoteGate + promoteAfterFirstResponse：turn/end 释放门控会话', () => {
  const promo = createEpochPromotion([], {
    promoteGate: true,
    promoteAfterFirstResponse: true,
    maxPromoteSteps: 4,
  })
  const session = makeSession([])
  const agent = makeAgent(session)
  promo.status(agent)
  promo.observe(session, { type: 'tool/call', seq: 1 })
  promo.observe(session, assistantMessage([reasoning('Let me check.')], 2))
  assert.equal(promo.status(agent).promoted, false)
  promo.observe(session, { type: 'turn/end', seq: 3 })
  assert.equal(promo.status(agent).promoted, true, '首轮结束后释放')
})

test('compaction/end 重置门控状态，边界前事件不重新晋升', () => {
  const promo = createEpochPromotion([], { promoteGate: true, maxPromoteSteps: 4 })
  const session = makeSession([])
  const agent = makeAgent(session)
  promo.status(agent)
  promo.observe(session, { type: 'tool/call', seq: 1 })
  promo.observe(session, assistantMessage([reasoning('We anchor.')], 2))
  assert.equal(promo.status(agent).promoted, true)
  promo.observe(session, { type: 'compaction/end', seq: 5 })
  assert.equal(promo.status(agent).promoted, false, '压缩后回到受控阶段')
  promo.observe(session, { type: 'tool/call', seq: 6 })
  promo.observe(session, assistantMessage([reasoning('Let me check.')], 7))
  assert.equal(promo.status(agent).promoted, false, '边界前样式事件不重新晋升')
  promo.observe(session, assistantMessage([reasoning('We continue.')], 8))
  assert.equal(promo.status(agent).promoted, true)
})

test('门控冷启动：从 durable log 重建同一相位', () => {
  const promo = createEpochPromotion([], { promoteGate: true, maxPromoteSteps: 4 })
  const session = makeSession([
    { type: 'tool/call', seq: 1 },
    assistantMessage([reasoning('Let me check.')], 2),
    { type: 'turn/end', seq: 3 },
  ])
  assert.equal(promo.status(makeAgent(session)).promoted, false, '冷启动按门控判定')
})

// ── tool-bootstrap：personaSectionsOnly / phase1FirstCallInstruction / workspaceLine ──

const assembled = (extraSections = []) => ({
  tools: [{ name: 'bash' }, { name: 'str_replace_editor' }, { name: 'read' }],
  sections: [
    { name: 'deployment:persona', text: 'You are a helpful software engineer assistant.' },
    { name: 'plan-mode', text: 'plan policy' },
    ...extraSections,
  ],
  contexts: [{ label: 'sandbox' }],
})

async function assembleThrough(listeners, agent, input) {
  const handler = listeners.get('system-prompt/assemble')?.[0]?.handler
  assert.ok(handler, '应注册 system-prompt/assemble')
  return handler(null, { agent }, async () => input)
}

test('tool-bootstrap：phase-1 裁剪工具 + personaSectionsOnly 只留 persona + phase1FirstCallInstruction 追加', async () => {
  const { ctx, listeners } = makeCtx()
  applyToolBootstrap(ctx, {
    bootstrapTools: ['bash', 'str_replace_editor'],
    personaSectionsOnly: true,
    phase1FirstCallInstruction: 'After your first reasoning block, before answering, make one tool call.',
  })
  const session = makeSession([])
  const agent = makeAgent(session)
  const out = await assembleThrough(listeners, agent, assembled())
  assert.deepEqual(out.tools.map((t) => t.name), ['bash', 'str_replace_editor'], '工具裁剪到双工具')
  assert.deepEqual(out.sections.map((s) => s.name), ['deployment:persona'], 'sections 只留 persona')
  assert.match(out.sections[0].text, /make one tool call\.$/, '指令追加到 persona 末尾')
  // 幂等：再次组装不重复追加。
  const again = await assembleThrough(listeners, agent, { ...out, sections: [...out.sections] })
  assert.equal((again.sections[0].text.match(/make one tool call\./g) ?? []).length, 1)
})

test('tool-bootstrap：personaSectionsOnly 默认关闭时 sections 不被过滤（回归）', async () => {
  const { ctx, listeners } = makeCtx()
  applyToolBootstrap(ctx, { bootstrapTools: ['bash', 'str_replace_editor'] })
  const out = await assembleThrough(listeners, makeAgent(makeSession([])), assembled())
  assert.equal(out.sections.length, 2, '默认保留全部 sections')
})

test('tool-bootstrap：门控模式与 promoteOn 非 either 互斥 fail loud', () => {
  const { ctx } = makeCtx()
  assert.throws(
    () => applyToolBootstrap(ctx, { bootstrapTools: ['bash'], promoteGate: true, promoteOn: 'tool-call' }),
    /either/,
    'promoteGate 门控模式固定 either 语义，promoteOn 非 either 应报错',
  )
  assert.throws(
    () => applyToolBootstrap(ctx, { bootstrapTools: ['bash'], promoteAfterFirstResponse: true, promoteOn: 'assistant-message' }),
    /either/,
  )
  // 门控 + either 允许（显式 either 与省略等价）。
  applyToolBootstrap(makeCtx().ctx, { bootstrapTools: ['bash'], promoteGate: true, promoteOn: 'either' })
})

test('tool-bootstrap：workspaceLine 晋升后给 persona 附加工作目录', async () => {
  const { ctx, listeners } = makeCtx()
  applyToolBootstrap(ctx, { bootstrapTools: ['bash', 'str_replace_editor'], workspaceLine: true })
  const session = makeSession([{ type: 'tool/call', seq: 1 }])
  const out = await assembleThrough(listeners, makeAgent(session), assembled())
  assert.match(out.sections[0].text, /Your working directory is \/workspace\.$/)
})

test('tool-bootstrap：includeSubagents=false（默认）子代理继承完整目录', async () => {
  const { ctx, listeners } = makeCtx()
  applyToolBootstrap(ctx, { bootstrapTools: ['bash', 'str_replace_editor'] })
  const subagent = {
    session: { id: `s-${Math.random()}`, header: { cwd: '/workspace', delegationDepth: 1 }, events: [] },
    ctx: { tools: { presentAs: () => () => {} } },
  }
  const out = await assembleThrough(listeners, subagent, assembled())
  assert.deepEqual(out.tools.map((t) => t.name), ['bash', 'str_replace_editor', 'read'], '子代理不裁剪')
  assert.equal(out.sections.length, 2, '子代理不过滤 sections')
})

test('tool-bootstrap：includeSubagents=true 子代理与主会话同相位（首轮裁剪）', async () => {
  const { ctx, listeners } = makeCtx()
  applyToolBootstrap(ctx, {
    bootstrapTools: ['bash', 'str_replace_editor'],
    includeSubagents: true,
    personaSectionsOnly: true,
  })
  const subagent = {
    session: { id: `s-${Math.random()}`, header: { cwd: '/workspace', delegationDepth: 1 }, events: [] },
    ctx: { tools: { presentAs: () => () => {} } },
  }
  const out = await assembleThrough(listeners, subagent, assembled())
  assert.deepEqual(out.tools.map((t) => t.name), ['bash', 'str_replace_editor'], '子代理首轮裁剪到 bootstrap 对')
  assert.deepEqual(out.sections.map((s) => s.name), ['deployment:persona'], '子代理 sections 过滤生效')
})

// ── context-gate：messageSources / deferredSources / instructionHint ───────

async function preStepThrough(listeners, agent, messages, claimed = messages) {
  const handlers = (listeners.get('agent/pre-step') ?? []).map((entry) => entry.handler)
  assert.ok(handlers.length > 0, '应注册 agent/pre-step')
  // claimed = inbox 批（真实语义：只有用户消息；注入消息不在 claimed 内）。
  const baseline = claimed === messages
    ? messages.filter((m) => m.source?.kind === 'user')
    : claimed
  // waterfall 串联：先注册者先执行，next() 进入下一监听器。
  const chain = async (index) => {
    if (index >= handlers.length) return { kind: 'enter', messages }
    return handlers[index]({ agent, messages: baseline }, async () => chain(index + 1))
  }
  return chain(0)
}

const msg = (kind, text) => ({ id: `m-${Math.random()}`, role: 'user', content: [{ type: 'text', text }], source: { kind } })

test('context-gate：messageSources 纯白名单（user/goal 放行，其余拦截）', async () => {
  const { ctx, listeners } = makeCtx()
  applyContextGate(ctx, { messageSources: ['user', 'goal'] })
  const session = makeSession([])
  const agent = makeAgent(session)
  const decision = await preStepThrough(listeners, agent, [
    msg('user', 'hello'),
    msg('goal', 'auto round'),
    msg('agent-instructions', 'instructions'),
    msg('skill-invocation', 'skill'),
  ])
  assert.deepEqual(decision.messages.map((m) => m.source.kind), ['user', 'goal'])
})

test('context-gate：deferredSources 晋升后延迟 N 步过滤', async () => {
  const { ctx, listeners } = makeCtx()
  applyContextGate(ctx, { deferredSources: ['agent-instructions'], deferredGraceSteps: 1 })
  const session = makeSession([{ type: 'tool/call', seq: 1 }])
  const agent = makeAgent(session)
  const first = await preStepThrough(listeners, agent, [msg('user', 'hi'), msg('agent-instructions', 'dump')])
  assert.deepEqual(first.messages.map((m) => m.source.kind), ['user'], '第一步延迟过滤 agent-instructions')
  const second = await preStepThrough(listeners, agent, [msg('user', 'hi2'), msg('agent-instructions', 'dump2')])
  assert.deepEqual(second.messages.map((m) => m.source.kind), ['user', 'agent-instructions'], '宽限期后恢复')
})

test('context-gate：instructionHint 晋升后全文 dump 替换为一次性 hint', async () => {
  const { ctx, listeners } = makeCtx()
  applyContextGate(ctx, { instructionHint: true })
  const session = makeSession([{ type: 'tool/call', seq: 1 }])
  const agent = makeAgent(session)
  const first = await preStepThrough(listeners, agent, [
    msg('user', 'hi'),
    { ...msg('agent-instructions', 'dump'), content: [{ type: 'text', text: 'Instructions from: /ref/A.md\nInstructions from: /ref/B.md\nbody' }] },
  ])
  const kinds = first.messages.map((m) => m.source.kind)
  assert.deepEqual(kinds, ['user', 'instruction-hint'], 'dump 替换为 hint')
  const hint = first.messages.find((m) => m.source.kind === 'instruction-hint')
  assert.match(hint.content[0].text, /Reference documents exist: \/ref\/A\.md, \/ref\/B\.md/)
  const second = await preStepThrough(listeners, agent, [msg('user', 'hi2'), msg('agent-instructions', 'dump2')])
  assert.deepEqual(second.messages.map((m) => m.source.kind), ['user'], '后续 dump 静默丢弃')
})

test('context-gate：默认 allowKinds 语义回归（skill-invocation 放行）', async () => {
  const { ctx, listeners } = makeCtx()
  applyContextGate(ctx, {})
  const session = makeSession([])
  const agent = makeAgent(session)
  const decision = await preStepThrough(listeners, agent, [msg('skill-invocation', 'skill'), msg('agent-instructions', 'dump')])
  assert.deepEqual(decision.messages.map((m) => m.source.kind), ['skill-invocation'])
})
