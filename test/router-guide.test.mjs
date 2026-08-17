import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply as applyRouterGuide } from '../preset/router-guide.mjs'

const userTask = {
  id: 'task-1',
  role: 'user',
  content: [{ type: 'text', text: '修复这个登录错误' }],
  source: { kind: 'user' },
}

const DEFAULT_GUIDE_TEXT = [
  '简单任务自动引导：',
  'Router: classify this task (build or fix) now, then adopt the matching style — build: direct production; fix: inspect-first. Think deeply first, then commit and act.',
  '',
  '复杂任务自动引导：',
  'Router: classify this task (build or fix) now, then adopt the matching style — build: direct production; fix: inspect-first. Think deeply about the architecture, edge cases, and integration points. Do not spend reasoning on the environment or tooling. Produce when your information is complete. End each reasoning block with a decision or an information need.',
].join('\n')

const GUIDE_WEAK = '\nRouter: classify this task (build or fix) now, then adopt the matching style — build: direct production; fix: inspect-first. Think deeply first, then commit and act.'

function makeStep({ model = 'deepseek-v4-pro-8013', events = [], delegationDepth = 0, useCustom = false, text = '', enabled = true } = {}) {
  const listeners = new Map()
  const ctx = { on(name, handler) { listeners.set(name, handler) } }
  applyRouterGuide(ctx, { useCustom, text, enabled })
  const handler = listeners.get('agent/pre-step')
  assert.ok(handler)
  const agent = { session: { id: 's1', header: { delegationDepth }, events }, options: { model } }
  return async (messages, kind = 'ok') => handler({ agent }, async () => ({ kind, messages }))
}

test('Flash 晋升会话在真实用户消息后追加引导', async () => {
  const step = makeStep({ model: 'deepseek-v4-flash-7013', events: [{ type: 'tool/call', seq: 1, time: 1, data: {} }] })
  const decision = await step([userTask])
  assert.equal(decision.messages.length, 2)
  assert.equal(decision.messages[1].source.plugin, 'router-guide')
  assert.match(decision.messages[1].content[0].text, /classify this task/)
})

test('复杂任务使用深度引导', async () => {
  const step = makeStep({ model: 'deepseek-v4-flash-7013', events: [{ type: 'tool/call', seq: 1, time: 1, data: {} }] })
  const decision = await step([{ ...userTask, content: [{ type: 'text', text: '设计系统架构并全面优化' }] }])
  assert.match(decision.messages[1].content[0].text, /architecture, edge cases/)
})

test('Pro 会话默认自动模式不注入', async () => {
  const step = makeStep({ model: 'deepseek-v4-pro-8013', events: [{ type: 'tool/call', seq: 1, time: 1, data: {} }] })
  const decision = await step([userTask])
  assert.equal(decision.messages.length, 1)
})

test('Pro 会话 useCustom=true 时注入自定义 guideText（测试用）', async () => {
  const step = makeStep({ model: 'deepseek-v4-pro-8013', events: [{ type: 'tool/call', seq: 1, time: 1, data: {} }], useCustom: true, text: 'PRO CUSTOM GUIDE' })
  const decision = await step([userTask])
  assert.equal(decision.messages[1].content[0].text, 'PRO CUSTOM GUIDE')
})

test('未晋升的 Flash 会话不注入（首轮交给 near-anchor）', async () => {
  const step = makeStep({ model: 'deepseek-v4-flash-7013', events: [] })
  const decision = await step([userTask])
  assert.equal(decision.messages.length, 1)
})

test('子代理不注入', async () => {
  const step = makeStep({ model: 'deepseek-v4-flash-7013', events: [{ type: 'tool/call', seq: 1, time: 1, data: {} }], delegationDepth: 1 })
  const decision = await step([userTask])
  assert.equal(decision.messages.length, 1)
})

test('useCustom=true 时固定使用自定义 guideText', async () => {
  const step = makeStep({ model: 'deepseek-v4-flash-7013', events: [{ type: 'tool/call', seq: 1, time: 1, data: {} }], useCustom: true, text: 'CUSTOM GUIDE' })
  const decision = await step([userTask])
  assert.equal(decision.messages[1].content[0].text, 'CUSTOM GUIDE')
})

test('useCustom=true 且文本为空时不注入', async () => {
  const step = makeStep({ model: 'deepseek-v4-flash-7013', events: [{ type: 'tool/call', seq: 1, time: 1, data: {} }], useCustom: true, text: '' })
  const decision = await step([userTask])
  assert.equal(decision.messages.length, 1)
})

test('enabled=false 时不注册注入（总开关关闭）', async () => {
  const step = makeStep({ model: 'deepseek-v4-flash-7013', events: [{ type: 'tool/call', seq: 1, time: 1, data: {} }], enabled: false })
  const decision = await step([userTask])
  assert.equal(decision.messages.length, 1)
})

test('useCustom=true 且未改动默认文本时等价自动：简单任务注入自动简单段', async () => {
  const step = makeStep({ model: 'deepseek-v4-flash-7013', events: [{ type: 'tool/call', seq: 1, time: 1, data: {} }], useCustom: true, text: DEFAULT_GUIDE_TEXT })
  const decision = await step([{ ...userTask, content: [{ type: 'text', text: '修复登录错误' }] }])
  assert.equal(decision.messages[1].content[0].text, GUIDE_WEAK)
})

test('useCustom=true 且未改动默认文本时复杂任务注入自动深度段', async () => {
  const step = makeStep({ model: 'deepseek-v4-flash-7013', events: [{ type: 'tool/call', seq: 1, time: 1, data: {} }], useCustom: true, text: DEFAULT_GUIDE_TEXT })
  const decision = await step([{ ...userTask, content: [{ type: 'text', text: '设计系统架构并全面优化' }] }])
  assert.match(decision.messages[1].content[0].text, /architecture, edge cases/)
})

test('useCustom=true 未改动默认文本时 Pro 按自动方式注入简单段', async () => {
  const step = makeStep({ model: 'deepseek-v4-pro-8013', events: [{ type: 'tool/call', seq: 1, time: 1, data: {} }], useCustom: true, text: DEFAULT_GUIDE_TEXT })
  const decision = await step([userTask])
  assert.equal(decision.messages.length, 2)
  assert.equal(decision.messages[1].content[0].text, GUIDE_WEAK)
})

test('本批消息已有 router-guide 时跳过', async () => {
  const step = makeStep({ model: 'deepseek-v4-flash-7013', events: [{ type: 'tool/call', seq: 1, time: 1, data: {} }] })
  const guide = { id: 'g1', role: 'user', content: [{ type: 'text', text: 'GUIDE' }], source: { kind: 'router-guide', plugin: 'router-guide' } }
  const decision = await step([userTask, guide])
  assert.equal(decision.messages.length, 2)
})
