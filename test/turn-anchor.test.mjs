import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply as applyTurnAnchor } from '../preset/turn-anchor.mjs'

const userTask = {
  id: 'task-1',
  role: 'user',
  content: [{ type: 'text', text: 'TASK' }],
  source: { kind: 'user' },
}

const pluginMsg = {
  id: 'plugin-1',
  role: 'user',
  content: [{ type: 'text', text: 'PLUGIN' }],
  source: { kind: 'plugin', plugin: 'other' },
}

const anchorEvent = {
  type: 'user/message',
  seq: 1,
  time: 1,
  data: {
    id: 'anchor-1',
    role: 'user',
    content: [{ type: 'text', text: 'ANCHOR' }],
    source: { kind: 'plugin', plugin: 'turn-anchor' },
  },
}

function makeStep({ events = [], appendError = false } = {}) {
  const listeners = new Map()
  const queued = []
  const inbox = {
    append(target, message) {
      if (appendError) throw new Error('append failed')
      assert.equal(target, 'next-step')
      queued.push(message)
    },
  }
  const ctx = {
    on(name, handler) { listeners.set(name, handler) },
  }
  applyTurnAnchor(ctx, { anchorText: 'You are a helpful software assistant.' })
  const handler = listeners.get('agent/pre-step')
  assert.ok(handler, 'pre-step listener registered')
  const agent = {
    session: { id: 's1', header: { delegationDepth: 0 }, events },
    inbox,
  }
  const step = async (messages, kind = 'ok') => handler({ agent }, async () => ({ kind, messages }))
  return { step, queued }
}

test('首步把真实用户任务挪进 next-step，只发锚定句', async () => {
  const { step, queued } = makeStep()
  const decision = await step([userTask, pluginMsg])
  assert.equal(queued.length, 1)
  assert.equal(queued[0].id, 'task-1')
  assert.equal(decision.messages.length, 2)
  assert.equal(decision.messages[0].source.plugin, 'turn-anchor')
  assert.equal(decision.messages[0].content[0].text, 'You are a helpful software assistant.')
  assert.equal(decision.messages[1].id, 'plugin-1')
})

test('同一进程后续 pre-step 不再拆轮', async () => {
  const { step, queued } = makeStep()
  await step([userTask])
  const second = await step([{ ...userTask, id: 'task-2' }])
  assert.equal(queued.length, 1)
  assert.equal(second.messages[0].id, 'task-2')
})

test('会话已晋升（有 assistant/message）时不拆轮', async () => {
  const { step, queued } = makeStep({ events: [{ type: 'assistant/message', seq: 1, time: 1, data: {} }] })
  const decision = await step([userTask])
  assert.equal(queued.length, 0)
  assert.equal(decision.messages[0].id, 'task-1')
})

test('进程重启后：事件流已有 turn-anchor 消息时不拆轮（data 本体形状）', async () => {
  const { step, queued } = makeStep({ events: [anchorEvent] })
  const decision = await step([{ ...userTask, id: 'task-2' }])
  assert.equal(queued.length, 0)
  assert.equal(decision.messages[0].id, 'task-2')
})

test('进程重启后：兼容 data.message 嵌套形状', async () => {
  const nested = { ...anchorEvent, data: { message: anchorEvent.data } }
  const { step, queued } = makeStep({ events: [nested] })
  const decision = await step([{ ...userTask, id: 'task-3' }])
  assert.equal(queued.length, 0)
  assert.equal(decision.messages[0].id, 'task-3')
})

test('decision.kind 为 reject 时原样返回', async () => {
  const { step, queued } = makeStep()
  const decision = await step([userTask], 'reject')
  assert.equal(queued.length, 0)
  assert.equal(decision.kind, 'reject')
  assert.equal(decision.messages[0].id, 'task-1')
})

test('首步没有真实 user 消息时不拆轮', async () => {
  const { step, queued } = makeStep()
  const decision = await step([pluginMsg])
  assert.equal(queued.length, 0)
  assert.equal(decision.messages[0].id, 'plugin-1')
})

test('inbox.append 失败时原样返回，不吞任务', async () => {
  const { step, queued } = makeStep({ appendError: true })
  const decision = await step([userTask])
  assert.equal(queued.length, 0)
  assert.equal(decision.messages[0].id, 'task-1')
})

test('anchorText 为空时不注册监听器', () => {
  const listeners = new Map()
  applyTurnAnchor({ on: (name, handler) => listeners.set(name, handler) }, { anchorText: '' })
  assert.equal(listeners.size, 0)
})
