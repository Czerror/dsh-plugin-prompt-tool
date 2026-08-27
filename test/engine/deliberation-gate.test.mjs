import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply as applyGate, GATE_TEXT, DEFAULT_MIN_CHARS } from '../../engine/deliberation-gate.mjs'

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

const makeSession = (events = []) => ({ id: `s-${Math.random()}`, header: { delegationDepth: 0 }, events })
const makeExec = (session) => ({ agent: { session } })
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
