import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply as applyRouterFirstTurn } from '../preset/router-first-turn.mjs'

function makeStep({ events = [], delegationDepth = 0 } = {}) {
  const listeners = new Map()
  const ctx = { on(name, handler) { listeners.set(name, handler) } }
  applyRouterFirstTurn(ctx)
  const handler = listeners.get('system-prompt/assemble')
  assert.ok(handler)
  const agent = { session: { id: 's1', header: { delegationDepth }, events } }
  return async (assembled) => handler(undefined, { agent }, async () => assembled)
}

test('首轮替换 persona，保留 plan 与第三方 section，隐藏 mnemon 段，并清空 contexts', async () => {
  const step = makeStep()
  const out = await step({
    sections: [
      { name: 'persona', text: 'OLD PERSONA', order: 0 },
      { name: 'plan-mode', text: 'PLAN TEXT', order: 10 },
      { name: 'mnemon:runtime-memory', text: 'MEMORY', order: 145 },
    ],
    contexts: [{ name: 'auto', text: 'AUTO' }],
    tools: [{ name: 'bash' }],
  })
  assert.deepEqual(out.sections.map((s) => s.name), ['plan-mode', 'router-persona'])
  assert.equal(out.sections.at(-1).text, 'You are a helpful software engineer assistant.')
  assert.deepEqual(out.contexts, [])
  assert.deepEqual(out.tools, [{ name: 'bash' }])
})

test('晋升后恢复 contexts 与 mnemon 记忆段', async () => {
  const step = makeStep({ events: [{ type: 'tool/call', seq: 1, time: 1, data: {} }] })
  const out = await step({
    sections: [{ name: 'persona', text: 'OLD' }, { name: 'mnemon:runtime-memory', text: 'MEMORY' }],
    contexts: [{ name: 'auto', text: 'AUTO' }],
  })
  assert.deepEqual(out.contexts, [{ name: 'auto', text: 'AUTO' }])
  assert.ok(out.sections.some((s) => s.name === 'mnemon:runtime-memory'))
})

test('子代理原样返回，不裁剪 section/context', async () => {
  const step = makeStep({ delegationDepth: 1 })
  const assembled = {
    sections: [{ name: 'persona', text: 'OLD' }, { name: 'plan-mode', text: 'PLAN' }],
    contexts: [{ name: 'auto', text: 'AUTO' }],
    tools: [{ name: 'mnemon_recall' }],
  }
  const out = await step(assembled)
  assert.deepEqual(out, assembled)
})

test('agent 缺失时原样返回', async () => {
  const listeners = new Map()
  applyRouterFirstTurn({ on: (name, handler) => listeners.set(name, handler) })
  const handler = listeners.get('system-prompt/assemble')
  const out = await handler(undefined, {}, async () => ({ sections: [] }))
  assert.deepEqual(out, { sections: [] })
})
