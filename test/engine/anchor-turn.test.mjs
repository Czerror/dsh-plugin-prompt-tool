import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply as applyAnchorTurn, ANCHOR_TEXT } from '../../engine/anchor-turn.mjs'

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

function makeAgent({ userMessages = 0, delegationDepth = 0 } = {}) {
  const prepended = []
  const events = []
  for (let i = 0; i < userMessages; i += 1) events.push({ type: 'user/message' })
  return {
    session: { header: { delegationDepth }, events },
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
