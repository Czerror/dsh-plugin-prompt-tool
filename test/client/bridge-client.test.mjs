import test from 'node:test'
import assert from 'node:assert/strict'
import { bridgeCall } from '../../src/client/data/bridge-client.ts'
import { BRIDGE_ENDPOINTS, SETTINGS_BRIDGE_PREFIX } from '../../src/shared/bridge-contract.ts'

test('typed bridge client：endpoint key 决定路径并序列化请求体', async () => {
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    return new Response(JSON.stringify({ ok: true, value: { tools: [] } }), { status: 200 })
  }
  try {
    const result = await bridgeCall('toolSurface', { sessionId: 's1' })
    assert.equal(result.ok, true)
    assert.equal(calls[0].url, SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.toolSurface)
    assert.equal(calls[0].init.method, 'POST')
    assert.deepEqual(JSON.parse(calls[0].init.body), { sessionId: 's1' })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('typed bridge client：无请求体 endpoint 发送空对象', async () => {
  const originalFetch = globalThis.fetch
  let body
  globalThis.fetch = async (_url, init) => {
    body = init.body
    return new Response(JSON.stringify({ ok: true, value: { templates: [] } }), { status: 200 })
  }
  try {
    const result = await bridgeCall('templates')
    assert.equal(result.ok, true)
    assert.deepEqual(JSON.parse(body), {})
  } finally {
    globalThis.fetch = originalFetch
  }
})
