import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPromptConfigs } from '../../engine/schema.mjs'
import { setSessionVar, clearSessionVars } from '../../engine/session-vars.mjs'

const config = (id, text, extra = {}) => ({ id, text, layer: 'system-section', strategy: 'static', params: { stMacros: true }, ...extra })
const agent = () => ({ session: { id: 'st', header: {}, snapshotEvents: () => [] }, options: {} })

test('ST 按声明顺序求值，禁用赋值不执行，纯赋值卡可重新启用', () => {
  const input = [config('set', '{{setvar::x::2}}', { order: 0 }), config('off', '{{addvar::x::3}}', { order: 1, enabled: false }), config('out', '{{getvar::x}}', { order: 2 })]
  const first = createPromptConfigs(input)
  assert.equal(first[2].renderSt(agent()), '2')
  const enabled = createPromptConfigs(input.map(c => ({ ...c, enabled: true })))
  assert.equal(enabled[2].renderSt(agent()), '5')
})

test('同一输入的两层共享一次宏副作用，后续真实输入才推进状态', () => {
  const configs = createPromptConfigs([config('counter', '{{incvar::n}}'), config('out', '{{getvar::n}}', { order: 1 })])
  const a = agent()
  const message = { id: 'user-1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] }
  assert.equal(configs[1].renderSt(a, [message]), '1')
  a.session.snapshotEvents = () => [{ type: 'user/message', data: { message } }]
  assert.equal(configs[0].renderSt(a), '1', '入库不再重复执行')
  assert.equal(configs[1].renderSt(a, [{ ...message, id: 'user-2' }]), '2')
  assert.equal(configs[1].renderSt(agent()), '1', '会话隔离')
})

test('ST 会话变量覆盖默认，未命中世界书不执行赋值', () => {
  const configs = createPromptConfigs([config('out', '{{getvar::x}}', { variables: { x: 'DEFAULT' } }), config('lore', '{{setvar::x::LORE}}', { strategy: 'world-book', layer: 'pre-step', params: { stMacros: true, keys: ['MATCH'] } })])
  const a = agent()
  setSessionVar(a.session, 'x', 'SESSION')
  assert.equal(configs[0].renderSt(a), 'SESSION')
  clearSessionVars(a.session, 'x')
  assert.equal(configs[0].renderSt(a), 'DEFAULT', '清空会话覆盖回退模板默认')
})

test('ST 一张模板失败不污染后续状态，禁用/不同受众模板没有副作用', () => {
  const configs = createPromptConfigs([
    config('bad', '{{setvar::x::BAD}}{{cycle}}', { variables: { cycle: '{{cycle}}' } }),
    config('child-only', '{{setvar::x::CHILD}}', { audience: 'subagent', order: 1 }),
    config('out', '{{getvar::x}}', { order: 2, variables: { x: 'DEFAULT' } }),
  ])
  const warnings = []
  assert.equal(configs[2].renderSt(agent(), [], w => warnings.push(w)), 'DEFAULT')
  assert.equal(warnings.length, 1)
})

test('宿主先assembly再pre-step后step/start的真实顺序不重复自增', () => {
  const configs = createPromptConfigs([config('counter', '{{incvar::n}}'), config('out', '{{getvar::n}}', { order: 1 })])
  const a = agent()
  const events = [{ type: 'turn/start', seq: 1, data: { turn: 1 } }]
  a.session.snapshotEvents = () => events
  assert.equal(configs[0].renderSt(a), '1', 'assembly')
  const message = { id: 'u1', role: 'user', content: [{ type: 'text', text: 'new' }] }
  assert.equal(configs[1].renderSt(a, [message]), '1', 'pre-step')
  events.push({ type: 'step/start', seq: 2, data: { turn: 1, step: 1 } }, { type: 'user/message', data: { message } })
  assert.equal(configs[1].renderSt(a), '1', 'admission后同一步')
  events.push({ type: 'step/end', seq: 4, data: { turn: 1, step: 1 } })
  assert.equal(configs[1].renderSt(a), '2', '下一步')
  events.push({ type: 'compaction/end', seq: 5, data: { error: 'cancelled' } })
  assert.equal(configs[1].renderSt(a), '2', '失败压缩不推进宏帧')
  events.push({ type: 'compaction/end', seq: 5, data: { success: true } })
  assert.equal(configs[1].renderSt(a), '3', '新epoch正常构造新帧')
})

test('互斥组淘汰的 ST 赋值模板不参与变量帧', () => {
  const configs = createPromptConfigs([
    config('selected', '{{setvar::x::A}}', { group: 'g', exclusive: true }),
    config('excluded', '{{setvar::x::B}}', { group: 'g', exclusive: true, order: 1 }),
    config('out', '{{getvar::x}}', { order: 2 }),
  ])
  assert.equal(configs[2].renderSt(agent()), 'A')
})

test('晋升或一次性去重受限的卡片只在执行器确认后执行副作用', () => {
  const configs = createPromptConfigs([
    config('promoted', '{{setvar::x::P}}', { layer: 'pre-step', promotion: 'main' }),
    config('once', '{{setvar::x::O}}', { layer: 'pre-step', dedupe: 'session', order: 1 }),
    config('out', '{{getvar::x}}', { order: 2 }),
  ])
  assert.equal(configs[2].renderSt(agent()), '')
})
