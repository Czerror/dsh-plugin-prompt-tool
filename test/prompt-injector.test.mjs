import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply as applyInjector } from '../preset/prompt-injector.mjs'

/**
 * 用假 ctx / agent / session 驱动 prompt-injector 的 agent/pre-step 监听器。
 * 关键断言：注入是否发生完全可被持久 session events 判定，
 * 进程内 Set 只是快路径——重启后同一事件流不允许二次注入。
 */

const PROMPT = 'PROMPT_TEXT'

function makeStep(events, next = async () => ({ kind: 'ok', messages: [] })) {
  const listeners = new Map()
  const ctx = {
    on(name, handler) {
      listeners.set(name, handler)
    },
  }
  applyInjector(ctx, { promptText: PROMPT })
  const handler = listeners.get('agent/pre-step')
  assert.ok(handler, 'pre-step listener registered')
  const agent = {
    session: {
      id: 's1',
      header: { delegationDepth: 0 },
      events,
    },
  }
  return async () => handler({ agent }, next)
}

const assistantReasoning = (text) => ({
  type: 'assistant/message',
  data: { message: { content: [{ type: 'reasoning', text }] } },
})

const injectedEvent = (data) => ({
  type: 'user/message',
  data,
})

const injectedMessage = {
  kind: 'user',
  role: 'user',
  source: { kind: 'plugin', plugin: 'prompt-injector' },
  content: [{ type: 'text', text: PROMPT }],
}

test('we 锚定确认后注入一次，同进程再次 pre-step 不重复', async () => {
  const step = makeStep([assistantReasoning('We need to inspect first')])
  const first = await step()
  assert.equal(first.messages.length, 1)
  assert.equal(first.messages[0].content[0].text, PROMPT)

  const second = await step()
  assert.equal(second.messages.length, 0)
})

test('进程重启后：事件流含已注入消息时跳过（持久幂等）', async () => {
  const step = makeStep([
    assistantReasoning('We need to inspect first'),
    injectedEvent(injectedMessage),
  ])
  const decision = await step()
  assert.equal(decision.messages.length, 0)
})

test('兼容 user/message 的 data.message 嵌套形状', async () => {
  const step = makeStep([
    assistantReasoning('We need to inspect first'),
    injectedEvent({ message: injectedMessage }),
  ])
  const decision = await step()
  assert.equal(decision.messages.length, 0)
})

test('we 未确认时等满两轮 assistant 消息后兜底注入', async () => {
  const step = makeStep([
    assistantReasoning('The user asked for a file list'),
    assistantReasoning('Still working'),
  ])
  const decision = await step()
  assert.equal(decision.messages.length, 1)
})

test('we 未确认且 assistant 回合不足两轮时不注入', async () => {
  const step = makeStep([assistantReasoning('The user asked for a file list')])
  const decision = await step()
  assert.equal(decision.messages.length, 0)
})

test('未晋升会话（无 tool/call 或 assistant/message）不注入', async () => {
  const step = makeStep([injectedEvent({ kind: 'user', source: { kind: 'user' }, content: [] })])
  const decision = await step()
  assert.equal(decision.messages.length, 0)
})

test('decision.kind 为 reject 时原样返回且不注入', async () => {
  const reject = async () => ({ kind: 'reject', messages: [] })
  const step = makeStep([assistantReasoning('We need to inspect first')], reject)
  const decision = await step()
  assert.equal(decision.kind, 'reject')
  assert.equal(decision.messages.length, 0)
})

test('promptText 为空时不注入', async () => {
  const listeners = new Map()
  applyInjector({ on: (name, handler) => listeners.set(name, handler) }, { promptText: '' })
  const handler = listeners.get('agent/pre-step')
  const agent = {
    session: {
      id: 's1',
      header: { delegationDepth: 0 },
      events: [assistantReasoning('We need to inspect first')],
    },
  }
  const decision = await handler({ agent }, async () => ({ kind: 'ok', messages: [] }))
  assert.equal(decision.messages.length, 0)
})
