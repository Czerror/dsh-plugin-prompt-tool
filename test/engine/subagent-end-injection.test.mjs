import test from 'node:test'
import assert from 'node:assert/strict'
import { createPromptConfigs } from '../../engine/schema.mjs'
import { wireLayers } from '../../engine/layers.mjs'

function harness(spec = {}) {
  const injected = [], warnings = [], effects = []
  const main = { session: { id: 'main', header: { id: 'main', delegationDepth: 0 } }, inject: (message) => injected.push(message) }
  const parent = { session: { id: 'parent', header: { id: 'parent', parentSession: 'main', delegationDepth: 1 } }, inject: () => assert.fail('不得注入中间子代理') }
  const child = { session: { id: 'child', header: { id: 'child', parentSession: 'parent', delegationDepth: 2 } }, options: { model: 'deepseek-flash' }, inject: () => assert.fail('不得注入结束的子代理') }
  const agents = new Map([['main', main], ['parent', parent], ['child', child]])
  const sessions = new Map([...agents].map(([id, agent]) => [id, agent.session]))
  const listeners = new Map()
  const ctx = {
    get: (name) => name === 'agents' ? agents : name === 'sessions' ? sessions : undefined,
    on: (name, callback) => { const callbacks = listeners.get(name) ?? []; callbacks.push(callback); listeners.set(name, callbacks) },
    effect: (effect) => effects.push(effect()),
  }
  const configs = createPromptConfigs([{ id: 'completion', layer: 'subagent-end', text: '检查子代理结果 {{note}}', variables: { note: '并总结' }, params: { action: 'inject-main' }, ...spec }])
  wireLayers(ctx, configs, (message) => warnings.push(message))
  const emit = (event, info) => { for (const callback of listeners.get(event) ?? []) callback(info) }
  const end = (extra = {}) => emit('subagent/end', { id: 'child', runId: 'run-1', stopReason: 'stop', ...extra })
  return { injected, warnings, agents, sessions, listeners, ctx, configs, end, emit, dispose: () => { for (const effect of effects) effect?.(); listeners.clear() } }
}

test('结束行为只向所属主会话注入，嵌套子代理和重复结束通知不误投递', () => {
  const h = harness()
  h.emit('subagent/start', { id: 'child', runId: 'run-1' })
  h.end()
  h.end()
  assert.equal(h.injected.length, 1)
  assert.equal(h.injected[0].role, 'user')
  assert.equal(h.injected[0].content[0].text, '检查子代理结果 并总结')
  // 重挂同一配置也不能向同一个会话重复投递同一次运行。
  wireLayers(h.ctx, h.configs, () => {})
  h.end()
  assert.equal(h.injected.length, 1)
  h.end({ runId: 'run-2' })
  assert.equal(h.injected.length, 2)
  h.dispose()
  h.end({ runId: 'run-3' })
  assert.equal(h.injected.length, 2)
})

test('启动时记录所属主会话，子代理结束后句柄撤销仍可准确投递', () => {
  const h = harness({ modelScope: 'flash' })
  h.emit('subagent/start', { id: 'child', runId: 'run-1' })
  h.agents.delete('child'); h.sessions.delete('child')
  h.end()
  assert.equal(h.injected.length, 1)
})

test('默认观察、未命中、空文本、缺少主会话、错误血缘与错误运行身份均不投递', () => {
  for (const spec of [{ params: {} }, { match: { keys: ['不会命中'] } }, { text: '' }, { modelScope: 'pro' }]) {
    const h = harness(spec)
    h.end()
    assert.equal(h.injected.length, 0)
  }
  for (const mutate of [
    (h) => h.agents.delete('main'),
    (h) => { h.agents.get('child').session.header.parentSession = 'missing' },
    (h) => { h.agents.get('parent').session.header.parentSession = 'child' },
  ]) {
    const h = harness(); mutate(h)
    h.end()
    assert.equal(h.injected.length, 0)
  }
  const mismatch = harness()
  mismatch.emit('subagent/start', { id: 'child', runId: 'run-1' })
  mismatch.end({ id: 'other' })
  assert.equal(mismatch.injected.length, 0)
})
