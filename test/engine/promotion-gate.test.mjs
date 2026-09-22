import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createEpochPromotion,
  classifyReasoning,
  hasAnchoredReasoning,
} from '../../engine/compaction-epoch.mjs'

function makeSession(events = [], visibleMessages) {
  return {
    id: `s-${Math.random()}`,
    header: { cwd: '/workspace', delegationDepth: 0 },
    snapshotEvents: () => events,
    ...(visibleMessages === undefined ? {} : { deriveMessages: () => visibleMessages }),
  }
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

test('成功 compaction/end 重置门控状态，边界前事件不重新晋升', () => {
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

test('失败的 compaction/end 不开启新 epoch', () => {
  const promo = createEpochPromotion(['tool/call', 'assistant/message'], {})
  const session = makeSession([{ type: 'tool/call', seq: 1 }])
  const agent = makeAgent(session)
  assert.equal(promo.status(agent).promoted, true)
  promo.observe(session, { type: 'compaction/end', seq: 2, data: { error: 'provider failed' } })
  assert.equal(promo.status(agent).boundary, -1)
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

test('门控冷启动：DSH 0.1.2-alpha.4 snapshotEvents API 重建相位', () => {
  const promo = createEpochPromotion(['tool/call', 'assistant/message'], {})
  const session = { id: 'snapshot-session', header: { cwd: '/workspace', delegationDepth: 0 }, snapshotEvents: () => [{ type: 'tool/call', seq: 1 }] }
  assert.equal(promo.status(makeAgent(session)).promoted, true)
})
