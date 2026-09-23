import test from 'node:test'
import assert from 'node:assert/strict'
import { bridgeCall } from '../../src/client/data/bridge-client.ts'
import { BRIDGE_ENDPOINTS, SETTINGS_BRIDGE_PREFIX } from '../../src/shared/bridge-contract.ts'
import { ENGINE_EDITOR_GROUP_MAP } from '../../src/shared/engine-capabilities.ts'
import { getEngineMeta } from '../../engine/schema.mjs'

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

test('typed bridge client：/meta 不补齐旧版本缺失的字段', async () => {
  const originalFetch = globalThis.fetch
  const suppliedMeta = { layers: ['pre-step'] }
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, value: { meta: suppliedMeta } }), { status: 200 })
  try {
    const result = await bridgeCall('meta')
    assert.equal(result.ok, true)
    const meta = result.value.meta
    assert.deepEqual(meta, suppliedMeta)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('typed bridge client：/meta 完整传递当前引擎能力元数据', async () => {
  const originalFetch = globalThis.fetch
  const suppliedMeta = JSON.parse(JSON.stringify({ ...getEngineMeta(), editorGroups: ENGINE_EDITOR_GROUP_MAP }))
  const payload = { ok: true, value: { meta: suppliedMeta } }
  globalThis.fetch = async () => new Response(JSON.stringify(payload), { status: 200 })
  try {
    const result = await bridgeCall('meta')
    assert.equal(result.ok, true)
    const meta = result.value.meta
    assert.deepEqual(meta, suppliedMeta)
    assert.equal(meta.layerOrder.length, 9)
    assert.ok(meta.editorGroups.length > 0)
    assert.ok(meta.layerContracts['pre-step'])
  } finally {
    globalThis.fetch = originalFetch
  }
})
