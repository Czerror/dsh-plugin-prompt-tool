// 由 anchor-turn.test.mjs、deliberation-gate.test.mjs、progress-reminder.test.mjs 并入
//（2026-09-17 测试归一精简）。三个模块共用同一个桩 ctx 与 makeExec，故合并为一份顶层样板。
// 深思门控段使用已安装宿主 `@deepseek-ai/dsh-session` 的真实持久事件夹具。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Session, snapshotSessionEvent } from '@deepseek-ai/dsh-session'
import { apply as applyAnchorTurn, ANCHOR_TEXT } from '../../engine/anchor-turn.mjs'
import { apply as applyGate, GATE_TEXT, DEFAULT_MIN_CHARS } from '../../engine/deliberation-gate.mjs'
import { apply as applyProgressReminder, DRIP_TEXT } from '../../engine/progress-reminder.mjs'

/** 三个注入门控模块共用的桩 ctx：按事件类型收集监听器，logger.warn 丢弃。 */
function makeCtx() {
  const listeners = new Map()
  return {
    ctx: {
      logger: { warn: () => {} },
      on(type, handler) {
        const list = listeners.get(type) ?? []
        list.push(handler)
        listeners.set(type, list)
      },
    },
    listeners,
  }
}

const makeExec = (session) => ({ agent: { session } })

// —— 首轮锚定（原 anchor-turn.test.mjs） ——

function makeAgent({ userMessages = 0, delegationDepth = 0 } = {}) {
  const prepended = []
  const events = []
  for (let i = 0; i < userMessages; i += 1) events.push({ type: 'user/message' })
  return {
    session: { header: { delegationDepth }, snapshotEvents: () => events },
    inbox: { prepend: (queue, message) => prepended.push({ queue, message }) },
    prepended,
  }
}

test('anchor-turn：全新会话首条用户消息前 prepend 锚定轮', () => {
  const { ctx, listeners } = makeCtx()
  applyAnchorTurn(ctx, {})
  const agent = makeAgent({})
  listeners.get('agent/inbox/inserted')[0]({ agent, message: { source: { kind: 'user' } } })
  assert.equal(agent.prepended.length, 1)
  assert.equal(agent.prepended[0].queue, 'next-turn')
  assert.equal(agent.prepended[0].message.content[0].text, ANCHOR_TEXT)
  assert.equal(agent.prepended[0].message.source.kind, 'plugin')
})

test('anchor-turn：已有用户消息的会话不锚定；插件来源消息不锚定', () => {
  const { ctx, listeners } = makeCtx()
  applyAnchorTurn(ctx, {})
  const used = makeAgent({ userMessages: 1 })
  listeners.get('agent/inbox/inserted')[0]({ agent: used, message: { source: { kind: 'user' } } })
  assert.equal(used.prepended.length, 0, '已有用户消息不锚定')

  const fresh = makeAgent({})
  listeners.get('agent/inbox/inserted')[0]({ agent: fresh, message: { source: { kind: 'plugin' } } })
  assert.equal(fresh.prepended.length, 0, '插件来源消息不锚定')
})

test('anchor-turn：子代理默认跳过；includeSubagents=true 时锚定', () => {
  const { ctx, listeners } = makeCtx()
  applyAnchorTurn(ctx, {})
  const sub = makeAgent({ delegationDepth: 1 })
  listeners.get('agent/inbox/inserted')[0]({ agent: sub, message: { source: { kind: 'user' } } })
  assert.equal(sub.prepended.length, 0, '子代理默认跳过')

  const { ctx: ctx2, listeners: listeners2 } = makeCtx()
  applyAnchorTurn(ctx2, { includeSubagents: true })
  const sub2 = makeAgent({ delegationDepth: 1 })
  listeners2.get('agent/inbox/inserted')[0]({ agent: sub2, message: { source: { kind: 'user' } } })
  assert.equal(sub2.prepended.length, 1, 'includeSubagents=true 子代理也锚定')
})

test('anchor-turn：自定义锚定文本 + 未知配置键 fail loud', () => {
  const { ctx, listeners } = makeCtx()
  applyAnchorTurn(ctx, { text: '你是谁' })
  const agent = makeAgent({})
  listeners.get('agent/inbox/inserted')[0]({ agent, message: { source: { kind: 'user' } } })
  assert.equal(agent.prepended[0].message.content[0].text, '你是谁')

  assert.throws(() => applyAnchorTurn(ctx, { bogus: 1 }), /unknown config key/)
})

// —— 深思门控（原 deliberation-gate.test.mjs） ——
//
// 深度探针走已安装宿主的真实持久事件：当前宿主不再发 `assistant/chunk`，
// 深思深度来自落盘的 `assistant/message` 内容块（reasoning / text），轮预算来自
// `turn/start`；surface 事件必须带 `surfaceOp` 标记，所以夹具一律用真实
// `Session.append` 写入并逐条投递，不手写想象的事件字段。

let messageSeq = 0

const assistantMessage = (content) => ({
  id: `a-${++messageSeq}`,
  role: 'assistant',
  content,
  source: { kind: 'model', provider: 'test', model: 'test-model' },
})

/** durable log → JSON 快照 → 重新加载：冷恢复与宿主重载同一条路径。 */
const seedOf = (session) => JSON.parse(JSON.stringify(session.snapshotEvents().map((event) => snapshotSessionEvent(event))))

/** 一个深思门实例可服务多个会话：实时路径 append 即投递，冷路径重载同一份 durable log。 */
function withGate(config = {}) {
  const { ctx, listeners } = makeCtx()
  applyGate(ctx, config)
  const pre = listeners.get('tools/pre-execute')[0]
  const handlers = listeners.get('session/event') ?? []
  const bind = (session) => ({
    session,
    /** 宿主写入路径：append 返回的真实事件立即发给 session/event 监听器。 */
    append(type, data, opts) {
      const event = session.append(type, data, opts)
      for (const handler of handlers) handler(session, event)
      return event
    },
    decide: () => pre(makeExec(session), () => ({ kind: 'accept' })),
  })
  return {
    bind,
    live: (id) => bind(Session.create(id)),
    cold: (session, id) => bind(Session.create(id, seedOf(session))),
  }
}

/** 一轮真实持久事件：turn/start 建立预算，assistant/message 计入可获得文本。 */
const writeTurn = (harness, turn, { reasoning = '', text = '', stream = [] } = {}) => {
  harness.append('turn/start', { turn })
  harness.append('step/start', { turn, step: 1 })
  const content = []
  if (reasoning.length > 0) content.push({ type: 'reasoning', text: reasoning })
  if (text.length > 0) content.push({ type: 'text', text })
  if (content.length > 0) {
    harness.append('assistant/message', { turn, step: 1, message: assistantMessage(content), stream }, { surfaceOp: 'append' })
  }
}

test('deliberation-gate：真实宿主持久事件——首轮 reasoning 达标放行，无文本次轮受门', () => {
  const gate = withGate({ minChars: 10 })
  const live = gate.live('gate-live')
  writeTurn(live, 1, { reasoning: 'w'.repeat(300) })
  assert.equal(live.decide().kind, 'accept', '首轮 300 字 reasoning >= 10 放行（R7 反例）')

  // 次轮只有轮边界、没有任何可获得文本：深度 0 受门，本轮上限用尽后放行。
  writeTurn(live, 2)
  assert.equal(live.decide().kind, 'deny', '无文本次轮受门')
  assert.equal(live.decide().kind, 'accept', 'maxGatesPerTurn=1 后本轮放行')

  // 会话隔离：同一门实例里的另一个会话不共享已达标深度。
  assert.equal(gate.live('gate-isolated').decide().kind, 'deny', '会话隔离：新会话深度仍为 0')
})

test('deliberation-gate：maxGatesPerTurn=2 逐轮计数，turn/start 重置', () => {
  const live = withGate({ minChars: 10, maxGatesPerTurn: 2 }).live('gate-cap')
  writeTurn(live, 1)
  assert.deepEqual([live.decide().kind, live.decide().kind, live.decide().kind], ['deny', 'deny', 'accept'], '本轮上限 2')
  writeTurn(live, 2)
  assert.equal(live.decide().kind, 'deny', 'turn/start 重置本轮门计数')
})

test('deliberation-gate：message 与 stream 不双计；reasoning/text 都计入深度', () => {
  const live = withGate({ minChars: 10 }).live('gate-count')
  // 同一段文本既在 message.content 又在 compact stream 里：只计一次（8 < 10）。
  writeTurn(live, 1, {
    reasoning: 'w'.repeat(8),
    stream: [{ type: 'reasoning-chunks', time0: 1, index: 0, dt: [0], texts: ['w'.repeat(8)] }],
  })
  assert.equal(live.decide().kind, 'deny', '只按 message.content 计一次，双计会误放行')

  // reasoning + text 都算可获得文本：合计 >= 10 → 放行。
  writeTurn(live, 2, { reasoning: 'w'.repeat(8), text: 'y'.repeat(20) })
  assert.equal(live.decide().kind, 'accept', 'reasoning 与 text 块都计入深度')
})

test('deliberation-gate：minChars=0 不设门（阈值 0 对照）', () => {
  const gate = withGate({ minChars: 0 })
  const live = gate.live('gate-zero')
  writeTurn(live, 1)
  assert.equal(live.decide().kind, 'accept', '阈值 0：深度 0 也放行')
  assert.equal(gate.live('gate-zero-bare').decide().kind, 'accept', '阈值 0：连轮事件都没有也放行')
})

test('deliberation-gate：冷恢复（durable 重载）与实时判定一致', () => {
  // 实时：首轮 300 字达标放行，次轮无文本受门、上限用尽后放行。
  const live = withGate({ minChars: 10 }).live('gate-cold-live')
  writeTurn(live, 1, { reasoning: 'w'.repeat(300) })
  writeTurn(live, 2)
  assert.equal(live.decide().kind, 'deny')
  assert.equal(live.decide().kind, 'accept')
  // 真实 log 形状：本轮的模型调用确实发出了工具调用（门已在上一步生效）。
  live.append('tool/call', { turn: 2, step: 1, callId: 'c-1', name: 'read', arguments: '{}' })

  // 冷恢复：同一 durable log 重载 → 同一判定序列。
  const restored = withGate({ minChars: 10 }).cold(live.session, 'gate-cold-restored')
  assert.equal(restored.decide().kind, 'deny', '冷扫重建当前轮（turn 2 无文本）→ 同样受门')
  assert.equal(restored.decide().kind, 'accept', '冷扫的每轮上限与实时一致')

  // 停在首轮的 durable log：冷扫保留该轮已计深度。
  const deep = withGate({ minChars: 10 }).live('gate-cold-deep')
  writeTurn(deep, 1, { reasoning: 'w'.repeat(300) })
  const restoredDeep = withGate({ minChars: 10 }).cold(deep.session, 'gate-cold-deep-restored')
  assert.equal(restoredDeep.decide().kind, 'accept', '冷扫首轮 300 字 reasoning 放行')
})

test('deliberation-gate：deny reason 是规划提示而非工具失败', () => {
  const decision = withGate({}).live('gate-reason').decide()
  assert.equal(decision.kind, 'deny')
  assert.ok(decision.reason.includes('planning prompt'), '措辞明示非工具失败')
  assert.ok(decision.reason.startsWith('Deliberation gate'))
})

test('deliberation-gate：子代理默认不门控；includeSubagents=true 同门控', () => {
  const subagent = (id) => ({ id, header: { delegationDepth: 1 }, snapshotEvents: () => [] })
  assert.equal(withGate({ minChars: 10 }).bind(subagent('sub-off')).decide().kind, 'accept', '子代理不门控')
  assert.equal(
    withGate({ minChars: 10, includeSubagents: true }).bind(subagent('sub-on')).decide().kind,
    'deny',
    'includeSubagents=true → 子代理同门控',
  )
})

test('deliberation-gate：默认值 + 非法配置 fail loud', () => {
  assert.equal(DEFAULT_MIN_CHARS, 400)
  assert.ok(GATE_TEXT.length > 0)
  const { ctx } = makeCtx()
  assert.throws(() => applyGate(ctx, { minChars: -1 }), /integer >= 0/)
  assert.throws(() => applyGate(ctx, { maxGatesPerTurn: 0 }), /integer >= 1/)
  assert.throws(() => applyGate(ctx, { bogus: 1 }), /unknown config key/)
})

// —— 进度提醒（原 progress-reminder.test.mjs） ——

/** 进度提醒的会话只需 id 与 delegationDepth（与深思门控的 makeSession 分开命名）。 */
const makeReminderSession = () => ({ id: `s-${Math.random()}`, header: { delegationDepth: 0 } })

test('progress-reminder：每 N 次工具结果滴入一条提醒，每轮最多 1 条', async () => {
  const { ctx, listeners } = makeCtx()
  applyProgressReminder(ctx, { every: 2 })
  const session = makeReminderSession()
  const exec = makeExec(session)
  const post = listeners.get('tools/post-execute')[0]
  const emit = (event) => { for (const h of listeners.get('session/event')) h(session, event) }

  const run = async (n) => {
    let decision
    for (let i = 0; i < n; i += 1) {
      decision = await post(exec, { ok: true }, async () => ({ kind: 'accept' }))
    }
    return decision
  }

  // 第 2 次结果 → 滴入；第 4 次 → 本轮到 maxPerTurn 不再滴。
  const d2 = await run(2)
  assert.equal(d2.additionalContexts.length, 1)
  assert.equal(d2.additionalContexts[0].content[0].text, DRIP_TEXT)
  assert.equal(d2.additionalContexts[0].source.plugin, 'progress-reminder')

  const d4 = await run(2)
  assert.equal(d4.additionalContexts, undefined, '每轮最多 1 条（后续结果不带滴入）')

  // 新轮（turn/start）重置计数。
  emit({ type: 'turn/start', data: { turn: 2 } })
  const d5 = await run(2)
  assert.equal(d5.additionalContexts.length, 1, '新轮重置后再次滴入')
})

test('progress-reminder：every=0 禁用；子代理默认不滴；失败保留原决策', async () => {
  const { ctx, listeners } = makeCtx()
  applyProgressReminder(ctx, { every: 0 })
  const session = makeReminderSession()
  const post = listeners.get('tools/post-execute')[0]
  const decision = await post(makeExec(session), {}, async () => ({ kind: 'accept' }))
  assert.equal(decision.additionalContexts, undefined, 'every=0 禁用')

  const { ctx: ctx2, listeners: listeners2 } = makeCtx()
  applyProgressReminder(ctx2, { every: 1 })
  const sub = makeReminderSession()
  sub.header.delegationDepth = 1
  const subDecision = await listeners2.get('tools/post-execute')[0](makeExec(sub), {}, async () => ({ kind: 'accept' }))
  assert.equal(subDecision.additionalContexts, undefined, '子代理默认不滴')

  const failed = await listeners2.get('tools/post-execute')[0](makeExec(sub), {}, async () => ({ kind: 'reject', reason: 'x' }))
  assert.equal(failed.kind, 'reject', '非 accept 决策原样透传')

  assert.throws(() => applyProgressReminder(ctx, { bogus: 1 }), /unknown config key/)
})
