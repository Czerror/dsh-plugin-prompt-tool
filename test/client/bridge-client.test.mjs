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

test('typed bridge client：toolSurface 支持 presetId 联合请求', async () => {
  const originalFetch = globalThis.fetch
  let body
  globalThis.fetch = async (_url, init) => {
    body = init.body
    return new Response(JSON.stringify({ ok: true, value: { source: 'preset', presetId: 'official', tools: [] } }), { status: 200 })
  }
  try {
    const result = await bridgeCall('toolSurface', { presetId: 'official' })
    assert.equal(result.ok, true)
    assert.deepEqual(JSON.parse(body), { presetId: 'official' })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('typed bridge client：空响应体转为可诊断的桥接错误', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(null, { status: 405 })
  try {
    const result = await bridgeCall('toolSurface', { sessionId: 's1' })
    assert.equal(result.ok, false)
    assert.match(result.message, /空响应/)
    assert.match(result.message, /405/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('typed bridge client：非 JSON 响应体保留状态码与内容摘要', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response('unauthorized', { status: 401 })
  try {
    const result = await bridgeCall('toolSurface', { sessionId: 's1' })
    assert.equal(result.ok, false)
    assert.match(result.message, /401/)
    assert.match(result.message, /unauthorized/)
  } finally {
    globalThis.fetch = originalFetch
  }
})
