// 由 anchor-turn.test.mjs、deliberation-gate.test.mjs、progress-reminder.test.mjs 并入
//（2026-09-17 测试归一精简）。三个模块共用同一个桩 ctx 与 makeExec，故合并为一份顶层样板。
import { test } from 'node:test'
import assert from 'node:assert/strict'
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

const makeSession = (events = []) => ({ id: `s-${Math.random()}`, header: { delegationDepth: 0 }, snapshotEvents: () => events })
const chunk = (turn, text) => ({ type: 'assistant/chunk', data: { turn, chunk: { text } } })

test('deliberation-gate：深思不足 deny 一次，深度达标放行', () => {
  const { ctx, listeners } = makeCtx()
  applyGate(ctx, { minChars: 10 })
  const session = makeSession([])
  const exec = makeExec(session)
  const pre = listeners.get('tools/pre-execute')[0]
  const emit = (event) => { for (const h of listeners.get('session/event')) h(session, event) }

  // 无流式文本：深度 0 → deny（gateText），且只 deny 一次。
  assert.equal(pre(exec, () => ({ kind: 'accept' })).kind, 'deny')
  assert.equal(pre(exec, () => ({ kind: 'accept' })).kind, 'accept', 'maxGatesPerTurn=1 后放行')

  // 新轮（turn 2）流式深思 >= minChars → 直接放行。
  emit(chunk(2, 'x'.repeat(10)))
  assert.equal(pre(exec, () => ({ kind: 'accept' })).kind, 'accept', '深度达标放行')
})

test('deliberation-gate：deny reason 是规划提示而非工具失败', () => {
  const { ctx, listeners } = makeCtx()
  applyGate(ctx, {})
  const session = makeSession([])
  const decision = listeners.get('tools/pre-execute')[0](makeExec(session), () => ({ kind: 'accept' }))
  assert.equal(decision.kind, 'deny')
  assert.ok(decision.reason.includes('planning prompt'), '措辞明示非工具失败')
  assert.ok(decision.reason.startsWith('Deliberation gate'))
})

test('deliberation-gate：子代理默认不门控；冷扫描 durable log 保持深度', () => {
  const { ctx, listeners } = makeCtx()
  applyGate(ctx, { minChars: 10 })
  const sub = makeSession([])
  sub.header.delegationDepth = 1
  const decision = listeners.get('tools/pre-execute')[0](makeExec(sub), () => ({ kind: 'accept' }))
  assert.equal(decision.kind, 'accept', '子代理不门控')

  // 冷启动：durable log 已含足够深思 → 不 deny。
  const resumed = makeSession([chunk(1, 'y'.repeat(10))])
  const decision2 = listeners.get('tools/pre-execute')[0](makeExec(resumed), () => ({ kind: 'accept' }))
  assert.equal(decision2.kind, 'accept', '冷扫描深度达标放行')
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
