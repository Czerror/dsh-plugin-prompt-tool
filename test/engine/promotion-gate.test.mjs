import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createEpochPromotion,
  classifyReasoning,
  hasAnchoredReasoning,
} from '../../engine/compaction-epoch.mjs'
import { apply as applyToolBootstrap } from '../../engine/tool-bootstrap.mjs'
import { apply as applyContextGate } from '../../engine/context-gate.mjs'
import { apply as applyCodePresentation } from '../../engine/code-presentation.mjs'

/** 收集 ctx.on 注册的监听器（按注册顺序）。 */
function makeCtx() {
  const listeners = new Map()
  const ctx = {
    logger: { warn: () => {} },
    tools: { register: () => {} },
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

// ── zero-tool 模式（bootstrapTools: []）────────────────────────────────────

test('tool-bootstrap：bootstrapTools 空数组 = 零工具首轮（上游 zero-tool 等价）', async () => {
  const { ctx, listeners } = makeCtx()
  applyToolBootstrap(ctx, { bootstrapTools: [], promoteOn: 'assistant-message' })
  const assemble = listeners.get('system-prompt/assemble')[0].handler
  const session = makeSession([])
  const agent = makeAgent(session)

  const first = await assemble({ tools: [{ name: 'bash' }, { name: 'str_replace_editor' }, { name: 'read' }] }, { agent }, async () => ({
    tools: [{ name: 'bash' }, { name: 'str_replace_editor' }, { name: 'read' }],
    sections: [],
    contexts: [],
  }))
  assert.deepEqual(first.tools, [], '首请求零工具')

  // assistant/message 晋升后：恢复完整目录（本仓库 POST-PROMOTION 语义）。
  for (const entry of listeners.get('session/event')) {
    entry.handler(session, { type: 'assistant/message', seq: 1, data: { message: { content: [{ type: 'text', text: 'ok' }] } } })
  }
  const promoted = await assemble({ tools: [{ name: 'bash' }, { name: 'read' }] }, { agent }, async () => ({
    tools: [{ name: 'bash' }, { name: 'read' }],
    sections: [],
    contexts: [],
  }))
  assert.deepEqual(promoted.tools.map((t) => t.name).sort(), ['bash', 'read'], '晋升后完整目录')
})

test('tool-bootstrap：零工具模式 compaction 回退补 shell（对齐上游 zero-tool-bootstrap）', async () => {
  const { ctx, listeners } = makeCtx()
  applyToolBootstrap(ctx, { bootstrapTools: [], compactionTools: ['read', 'write'] })
  const assemble = listeners.get('system-prompt/assemble')[0].handler
  const session = makeSession([])
  const agent = makeAgent(session)

  // 首请求零工具。
  const first = await assemble({ tools: [{ name: 'bash' }, { name: 'read' }] }, { agent }, async () => ({
    tools: [{ name: 'bash' }, { name: 'read' }],
    sections: [],
    contexts: [],
  }))
  assert.deepEqual(first.tools, [], '首请求零工具')

  // compaction/end → 受控相位：shell + compactionTools。
  for (const entry of listeners.get('session/event')) {
    entry.handler(session, { type: 'compaction/end', seq: 1 })
  }
  const after = await assemble({ tools: [{ name: 'bash' }, { name: 'read' }, { name: 'write' }] }, { agent }, async () => ({
    tools: [{ name: 'bash' }, { name: 'read' }, { name: 'write' }],
    sections: [],
    contexts: [],
  }))
  assert.deepEqual(after.tools.map((t) => t.name).sort(), ['bash', 'read', 'write'], 'compaction 回退 = shell + 核心工具集')
})

// ── code-presentation：晋升后 Code Mode (PTC) 呈现（从 tool-bootstrap 拆出） ──

test('code-presentation：晋升后应用 presentAs("code")，compaction/end 释放', async () => {
  const { ctx, listeners } = makeCtx()
  const presented = []
  let disposed = 0
  const agentWithTools = (session) => ({
    session,
    ctx: { tools: { presentAs: (mode) => { presented.push(mode); return () => { disposed += 1 } } } },
  })
  applyCodePresentation(ctx, { usePtcMode: true })
  const session = makeSession([{ type: 'tool/call', seq: 1 }])
  const agent = agentWithTools(session)
  const handler = listeners.get('system-prompt/assemble')?.[0]?.handler
  assert.ok(handler, '应注册 system-prompt/assemble')
  await handler(null, { agent }, async () => assembled())
  assert.deepEqual(presented, ['code'], '晋升后应用 Code Mode 呈现')
  // compaction/end 释放（回到受控相位）。
  const eventHandlers = listeners.get('session/event') ?? []
  for (const { handler: h } of eventHandlers) h(session, { type: 'compaction/end', seq: 2 })
  assert.equal(disposed, 1, 'compaction/end 释放呈现')
  // 新晋升信号（压缩边界后的 tool/call）后再次应用。
  for (const { handler: h } of eventHandlers) h(session, { type: 'tool/call', seq: 3 })
  await handler(null, { agent }, async () => assembled())
  assert.equal(presented.length, 2, '重新晋升后再次应用')
})

test('code-presentation：usePtcMode=false 不注册任何监听（只 bootstrap 预设）', () => {
  const { ctx, listeners } = makeCtx()
  applyCodePresentation(ctx, { usePtcMode: false })
  assert.equal(listeners.size, 0, 'usePtcMode=false 时不注册监听')
})

test('code-presentation：默认 usePtcMode=false（opt-in，未声明不注册）', () => {
  const { ctx, listeners } = makeCtx()
  applyCodePresentation(ctx, {})
  assert.equal(listeners.size, 0, '默认不启用 PTC 呈现')
})

test('code-presentation：未晋升不应用，子代理（默认）直接应用', async () => {
  const { ctx, listeners } = makeCtx()
  const presented = []
  const agentWithTools = (session) => ({
    session,
    ctx: { tools: { presentAs: (mode) => { presented.push(mode); return () => {} } } },
  })
  applyCodePresentation(ctx, { usePtcMode: true })
  const handler = listeners.get('system-prompt/assemble')?.[0]?.handler
  assert.ok(handler)
  // 主会话未晋升：不应用。
  await handler(null, { agent: agentWithTools(makeSession([])) }, async () => assembled())
  assert.equal(presented.length, 0, '未晋升不应用')
  // 子代理（delegationDepth=1，默认 includeSubagents=false）：直接应用。
  const subagent = {
    session: { id: `s-${Math.random()}`, header: { cwd: '/workspace', delegationDepth: 1 }, events: [] },
    ctx: { tools: { presentAs: (mode) => { presented.push(mode); return () => {} } } },
  }
  await handler(null, { agent: subagent }, async () => assembled())
  assert.deepEqual(presented, ['code'], '子代理默认直接应用呈现')
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

test('context-gate：allowKinds 未声明时不过滤（对齐官方 pre-step 行为）', async () => {
  const { ctx, listeners } = makeCtx()
  applyContextGate(ctx, {})
  const session = makeSession([])
  const agent = makeAgent(session)
  const decision = await preStepThrough(listeners, agent, [msg('skill-invocation', 'skill'), msg('agent-instructions', 'dump')])
  assert.deepEqual(decision.messages.map((m) => m.source.kind), ['skill-invocation', 'agent-instructions'], '未声明=官方行为：注入全部保留')
})

test('context-gate：显式 allowKinds 白名单门控（只放行声明 kind）', async () => {
  const { ctx, listeners } = makeCtx()
  applyContextGate(ctx, { allowKinds: ['skill-invocation'] })
  const session = makeSession([])
  const agent = makeAgent(session)
  const decision = await preStepThrough(listeners, agent, [msg('skill-invocation', 'skill'), msg('agent-instructions', 'dump')])
  assert.deepEqual(decision.messages.map((m) => m.source.kind), ['skill-invocation'])
})

// ── stages 模式（渐进披露，参考 dsh-router-standard 自写）──────────────────

const STAGES = [
  { name: '了解', tools: ['read', 'glob', 'grep'] },
  { name: '开发', tools: ['write', 'edit'] },
  { name: '验证', tools: ['pwsh', 'bash'] },
]

const toolCall = (tool, seq) => ({ type: 'tool/call', seq, data: { message: { source: { tool } } } })

/** stages 测试专用装配输入：含全部阶段工具 + 干扰工具（窄化过滤可见）。 */
const stageAssembled = () => ({
  tools: [
    { name: 'bash' }, { name: 'str_replace_editor' },
    { name: 'read' }, { name: 'glob' }, { name: 'grep' },
    { name: 'write' }, { name: 'edit' },
    { name: 'pwsh' }, { name: 'web_search' },
  ],
  sections: [],
  contexts: [],
})

test('tool-bootstrap stages：首轮窄化到阶段 0 + 预放档（默认 1）', async () => {
  const { ctx, listeners } = makeCtx()
  applyToolBootstrap(ctx, { bootstrapTools: ['bash'], stages: STAGES })
  const out = await assembleThrough(listeners, makeAgent(makeSession([])), stageAssembled())
  assert.deepEqual(out.tools.map((t) => t.name), ['read', 'glob', 'grep', 'write', 'edit'], '阶段 0 + 预放开发档')
})

test('tool-bootstrap stages：phase_advance 推进 + stage section 注入 + compaction 不重置', async () => {
  const { ctx, listeners } = makeCtx()
  applyToolBootstrap(ctx, { bootstrapTools: ['bash'], stages: STAGES, stageSectionTemplate: 'Stage {{stageName}} ({{stage}}/{{total}}). Unlocked: {{unlocked}}.' })
  const session = makeSession([])
  const agent = makeAgent(session)
  const handlers = listeners.get('session/event') ?? []
  // 推进到阶段 1（开发）。
  for (const { handler: h } of handlers) h(session, toolCall('phase_advance', 1))
  const out = await assembleThrough(listeners, agent, stageAssembled())
  assert.deepEqual(out.tools.map((t) => t.name), ['bash', 'read', 'glob', 'grep', 'write', 'edit', 'pwsh'], '阶段 1 + 预放验证档')
  const stageSection = out.sections.find((s) => s.name === 'stage-status')
  assert.ok(stageSection, '应注入 stage-status section')
  assert.equal(stageSection.text, 'Stage 开发 (2/3). Unlocked: read, glob, grep, write, edit, pwsh, bash.')
  // compaction 不重置阶段（会话级进度）。
  for (const { handler: h } of handlers) h(session, { type: 'compaction/end', seq: 2 })
  const after = await assembleThrough(listeners, agent, stageAssembled())
  assert.deepEqual(after.tools.map((t) => t.name), ['bash', 'read', 'glob', 'grep', 'write', 'edit', 'pwsh'], '压缩后阶段保持')
})

test('tool-bootstrap stages：直达语义（调用更高阶段工具自动跳档）+ 冷启动重建', async () => {
  const { ctx, listeners } = makeCtx()
  applyToolBootstrap(ctx, { bootstrapTools: ['bash'], stages: STAGES })
  const session = makeSession([])
  const agent = makeAgent(session)
  const handlers = listeners.get('session/event') ?? []
  // 直达：直接调用验证档工具 pwsh → 跳到阶段 2。
  for (const { handler: h } of handlers) h(session, toolCall('pwsh', 1))
  const out = await assembleThrough(listeners, agent, stageAssembled())
  assert.deepEqual(out.tools.map((t) => t.name), ['bash', 'read', 'glob', 'grep', 'write', 'edit', 'pwsh'], '直达验证档')
  // 冷启动：同一 durable log 重建同相位（stage 由 tool/call 推导）。
  const cold = makeAgent({ id: session.id, header: { cwd: '/workspace', delegationDepth: 0 }, events: [toolCall('pwsh', 1)] })
  const coldOut = await assembleThrough(listeners, cold, stageAssembled())
  assert.deepEqual(coldOut.tools.map((t) => t.name), ['bash', 'read', 'glob', 'grep', 'write', 'edit', 'pwsh'], '冷启动恢复直达后的阶段')
})

test('tool-bootstrap stages：stagePreUnlock=0 + 自定义推进工具名 + 工具注册', async () => {
  const { ctx, listeners } = makeCtx()
  const registered = []
  const ctxWithTools = {
    logger: { warn: () => {} },
    on: ctx.on,
    tools: { register: (tool) => registered.push(tool) },
  }
  applyToolBootstrap(ctxWithTools, { bootstrapTools: ['bash'], stages: STAGES, stagePreUnlock: 0, stageAdvanceTool: 'level_up' })
  assert.equal(registered.length, 1)
  assert.equal(registered[0].name, 'level_up', '推进工具名参数化')
  const out = await assembleThrough(listeners, makeAgent(makeSession([])), stageAssembled())
  assert.deepEqual(out.tools.map((t) => t.name), ['read', 'glob', 'grep'], 'stagePreUnlock=0 不预放')
  // 自定义推进工具事件同样推进。
  const session = makeSession([])
  const agent = makeAgent(session)
  const handlers = listeners.get('session/event') ?? []
  for (const { handler: h } of handlers) h(session, toolCall('level_up', 1))
  const after = await assembleThrough(listeners, agent, stageAssembled())
  assert.deepEqual(after.tools.map((t) => t.name), ['read', 'glob', 'grep', 'write', 'edit'], 'level_up 推进到阶段 1')
})

test('tool-bootstrap stages：stageSectionTemplate 空 = 不注入 section（文案参数化）', async () => {
  const { ctx, listeners } = makeCtx()
  applyToolBootstrap(ctx, { bootstrapTools: ['bash'], stages: STAGES, stageSectionTemplate: '' })
  const out = await assembleThrough(listeners, makeAgent(makeSession([])), stageAssembled())
  assert.equal(out.sections.some((s) => s.name === 'stage-status'), false, '空模板不注入')
})

test('tool-bootstrap stages：config 校验 fail loud', () => {
  const base = { bootstrapTools: ['bash'] }
  assert.throws(() => applyToolBootstrap(makeCtx().ctx, { ...base, stages: [] }), /stages must be a non-empty array/)
  assert.throws(() => applyToolBootstrap(makeCtx().ctx, { ...base, stages: [{ name: 'x' }] }), /tools must be a non-empty array/)
  assert.throws(() => applyToolBootstrap(makeCtx().ctx, { ...base, stages: STAGES, stagePreUnlock: -1 }), /stagePreUnlock/)
})
