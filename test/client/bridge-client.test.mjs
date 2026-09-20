import test from 'node:test'
import assert from 'node:assert/strict'
import { bridgeCall, normalizeEngineMeta } from '../../src/client/data/bridge-client.ts'
import { BRIDGE_ENDPOINTS, SETTINGS_BRIDGE_PREFIX } from '../../src/shared/bridge-contract.ts'
import { ENGINE_LAYER_ORDER } from '../../src/shared/engine-capabilities.ts'
import { displayLayers } from '../../src/client/features/prompts/prompt-config-policy.ts'

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

test('typed bridge client：旧宿主 /meta 缺 layerOrder 与 editorGroups 时退化读取不崩', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, value: { meta: { layers: ['pre-step'] } } }), { status: 200 })
  try {
    const result = await bridgeCall('meta')
    assert.equal(result.ok, true)
    const meta = normalizeEngineMeta(result.value.meta)
    assert.deepEqual(meta.layerOrder, [...ENGINE_LAYER_ORDER], '缺 layerOrder 时退化为共享九层')
    assert.deepEqual(meta.editorGroups, [], '缺 editorGroups 时退化为空表，不让调用方判 null')
    // 旧数据可读：未登记的层仍追加在九层之后，不丢未知配置。
    assert.deepEqual(displayLayers(meta.layerOrder, ['pre-step', 'future-layer']), [...ENGINE_LAYER_ORDER, 'future-layer'])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('typed bridge client：宿主下发 layerOrder 时按宿主顺序消费，非数组同样退化', async () => {
  const originalFetch = globalThis.fetch
  let payload = { ok: true, value: { meta: { layerOrder: ['tool-pipeline', 'pre-step'], editorGroups: [{ id: 'custom-tools', displayLayer: 'tool-pipeline', hook: 'tool-pipeline' }], layers: [] } } }
  globalThis.fetch = async () => new Response(JSON.stringify(payload), { status: 200 })
  try {
    const result = await bridgeCall('meta')
    assert.equal(result.ok, true)
    const meta = normalizeEngineMeta(result.value.meta)
    assert.deepEqual(meta.layerOrder, ['tool-pipeline', 'pre-step'], '宿主下发的层序优先于本地退化默认')
    assert.deepEqual(displayLayers(meta.layerOrder, []), ['tool-pipeline', 'pre-step'])
    assert.equal(meta.editorGroups.length, 1)
    // 坏数据（非数组）不穿透到 UI：同样退化为共享九层。
    payload = { ok: true, value: { meta: { layerOrder: 'pre-step' } } }
    const broken = normalizeEngineMeta((await bridgeCall('meta')).value.meta)
    assert.deepEqual(broken.layerOrder, [...ENGINE_LAYER_ORDER])
    assert.deepEqual(broken.editorGroups, [])
  } finally {
    globalThis.fetch = originalFetch
  }
})
