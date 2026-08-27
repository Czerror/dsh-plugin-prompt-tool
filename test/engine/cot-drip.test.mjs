import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply as applyDrip, DRIP_TEXT } from '../../engine/cot-drip.mjs'

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

const makeSession = () => ({ id: `s-${Math.random()}`, header: { delegationDepth: 0 } })
const makeExec = (session) => ({ agent: { session } })

test('cot-drip：每 N 次工具结果滴入一条提醒，每轮最多 1 条', async () => {
  const { ctx, listeners } = makeCtx()
  applyDrip(ctx, { every: 2 })
  const session = makeSession()
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
  assert.equal(d2.additionalContexts[0].source.plugin, 'cot-drip')

  const d4 = await run(2)
  assert.equal(d4.additionalContexts, undefined, '每轮最多 1 条（后续结果不带滴入）')

  // 新轮（turn/start）重置计数。
  emit({ type: 'turn/start', data: { turn: 2 } })
  const d5 = await run(2)
  assert.equal(d5.additionalContexts.length, 1, '新轮重置后再次滴入')
})

test('cot-drip：every=0 禁用；子代理默认不滴；失败保留原决策', async () => {
  const { ctx, listeners } = makeCtx()
  applyDrip(ctx, { every: 0 })
  const session = makeSession()
  const post = listeners.get('tools/post-execute')[0]
  const decision = await post(makeExec(session), {}, async () => ({ kind: 'accept' }))
  assert.equal(decision.additionalContexts, undefined, 'every=0 禁用')

  const { ctx: ctx2, listeners: listeners2 } = makeCtx()
  applyDrip(ctx2, { every: 1 })
  const sub = makeSession()
  sub.header.delegationDepth = 1
  const subDecision = await listeners2.get('tools/post-execute')[0](makeExec(sub), {}, async () => ({ kind: 'accept' }))
  assert.equal(subDecision.additionalContexts, undefined, '子代理默认不滴')

  const failed = await listeners2.get('tools/post-execute')[0](makeExec(sub), {}, async () => ({ kind: 'reject', reason: 'x' }))
  assert.equal(failed.kind, 'reject', '非 accept 决策原样透传')

  assert.throws(() => applyDrip(ctx, { bogus: 1 }), /unknown config key/)
})
