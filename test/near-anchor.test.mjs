import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply as applyNearAnchor } from '../preset/near-anchor.mjs'

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
    source: { kind: 'near-anchor', plugin: 'near-anchor' },
  },
}

function makeStep({ events = [], anchorText = '', useCustom = false, model = 'deepseek-v4-pro-8013', delegationDepth = 0 } = {}) {
  const listeners = new Map()
  const ctx = { on(name, handler) { listeners.set(name, handler) } }
  applyNearAnchor(ctx, { anchorText, useCustom })
  const handler = listeners.get('agent/pre-step')
  assert.ok(handler, 'pre-step listener registered')
  const agent = {
    session: { id: 's1', header: { delegationDepth }, events },
    options: { model },
  }
  const step = async (messages, kind = 'ok') => handler({ agent }, async () => ({ kind, messages }))
  return { step }
}

test('开发类任务在首条真实用户消息后追加 we 构建首句', async () => {
  const { step } = makeStep()
  const decision = await step([{ ...userTask, content: [{ type: 'text', text: '写一个工具' }] }, pluginMsg])
  assert.equal(decision.messages.length, 3)
  assert.equal(decision.messages[0].id, 'task-1')
  assert.equal(decision.messages[1].source.plugin, 'near-anchor')
  assert.match(decision.messages[1].content[0].text, /^Start your reasoning with the exact sentence: 'We need to build/)
  assert.equal(decision.messages[2].id, 'plugin-1')
})

test('检查类任务追加 we 检查首句', async () => {
  const { step } = makeStep()
  const decision = await step([{ ...userTask, content: [{ type: 'text', text: '修复报错' }] }])
  assert.equal(decision.messages.length, 2)
  assert.match(decision.messages[1].content[0].text, /We need to inspect the code first/)
})

test('复杂规划任务放行 Let 深度首句', async () => {
  const { step } = makeStep()
  const decision = await step([{ ...userTask, content: [{ type: 'text', text: '重构系统架构' }] }])
  assert.match(decision.messages[1].content[0].text, /Let me think through the design/)
})

test('useCustom=true 时固定使用自定义 anchorText', async () => {
  const { step } = makeStep({ anchorText: 'CUSTOM ANCHOR', useCustom: true })
  const decision = await step([{ ...userTask, content: [{ type: 'text', text: '写一个工具' }] }])
  assert.equal(decision.messages[1].content[0].text, 'CUSTOM ANCHOR')
})

test('useCustom=false 时忽略 anchorText，使用自动文本', async () => {
  const { step } = makeStep({ anchorText: 'CUSTOM ANCHOR', useCustom: false })
  const decision = await step([{ ...userTask, content: [{ type: 'text', text: '写一个工具' }] }])
  assert.match(decision.messages[1].content[0].text, /We need to build/)
})

test('useCustom=true 且 anchorText 为空时不注入锚点', async () => {
  const { step } = makeStep({ anchorText: '', useCustom: true })
  const decision = await step([userTask])
  assert.equal(decision.messages.length, 1)
  assert.equal(decision.messages[0].id, 'task-1')
})

test('Flash 模型不重复追加三锚（persona 已含）', async () => {
  const { step } = makeStep({ model: 'deepseek-v4-flash-7013' })
  const decision = await step([{ ...userTask, content: [{ type: 'text', text: '修复报错' }] }])
  assert.doesNotMatch(decision.messages[1].content[0].text, /Do not run environment checks/)
  assert.match(decision.messages[1].content[0].text, /We need to inspect/)
})

test('同一进程后续 pre-step 不再追加锚点', async () => {
  const { step } = makeStep()
  await step([userTask])
  const second = await step([{ ...userTask, id: 'task-2' }])
  assert.equal(second.messages.length, 1)
  assert.equal(second.messages[0].id, 'task-2')
})

test('进程重启后：事件流已有 near-anchor 消息时跳过', async () => {
  const { step } = makeStep({ events: [anchorEvent] })
  const decision = await step([{ ...userTask, id: 'task-2' }])
  assert.equal(decision.messages.length, 1)
  assert.equal(decision.messages[0].id, 'task-2')
})

test('进程重启后：兼容 data.message 嵌套形状', async () => {
  const nested = { ...anchorEvent, data: { message: anchorEvent.data } }
  const { step } = makeStep({ events: [nested] })
  const decision = await step([{ ...userTask, id: 'task-3' }])
  assert.equal(decision.messages.length, 1)
})

test('decision.kind 为 reject 时原样返回', async () => {
  const { step } = makeStep()
  const decision = await step([userTask], 'reject')
  assert.equal(decision.kind, 'reject')
  assert.equal(decision.messages.length, 1)
})

test('首步没有真实 user 消息时不追加', async () => {
  const { step } = makeStep()
  const decision = await step([pluginMsg])
  assert.equal(decision.messages.length, 1)
  assert.equal(decision.messages[0].id, 'plugin-1')
})

test('子代理首轮不注入锚点', async () => {
  const { step } = makeStep({ delegationDepth: 1 })
  const decision = await step([userTask])
  assert.equal(decision.messages.length, 1)
  assert.equal(decision.messages[0].id, 'task-1')
})

test('anchorText 为空也注册监听器（自动模式）', () => {
  const listeners = new Map()
  applyNearAnchor({ on: (name, handler) => listeners.set(name, handler) }, { anchorText: '' })
  assert.equal(listeners.size, 1)
  assert.ok(listeners.has('agent/pre-step'))
})
