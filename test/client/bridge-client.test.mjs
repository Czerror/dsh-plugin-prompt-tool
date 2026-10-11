import test from 'node:test'
import assert from 'node:assert/strict'
import { bridgeCall, bridgeUpload } from '../../src/client/data/bridge-client.ts'
import { BRIDGE_ENDPOINTS, EDIT_TARGET_HEADER, SETTINGS_BRIDGE_PREFIX } from '../../src/shared/bridge-contract.ts'

/** 记录请求并以给定响应应答；finally 恢复 fetch，避免用例间互相污染。 */
async function withFetch(handler, run) {
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    return handler(url, init)
  }
  try { return await run(calls) } finally { globalThis.fetch = originalFetch }
}

const okResponse = () => new Response(JSON.stringify({ ok: true, value: {} }), { status: 200 })
const subjectOf = (call) => call.init.headers[EDIT_TARGET_HEADER]

test('typed bridge client：endpoint key 决定路径并序列化请求体', async () => {
  await withFetch(okResponse, async (calls) => {
    const result = await bridgeCall('toolSurface', { sessionId: 's1' })
    assert.equal(result.ok, true)
    assert.equal(calls[0].url, SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.toolSurface)
    assert.equal(calls[0].init.method, 'POST')
    assert.deepEqual(JSON.parse(calls[0].init.body), { sessionId: 's1' })
  })
})

test('typed bridge client：无请求体 endpoint 发送空对象', async () => {
  await withFetch(okResponse, async (calls) => {
    const result = await bridgeCall('templates')
    assert.equal(result.ok, true)
    assert.deepEqual(JSON.parse(calls[0].init.body), {})
  })
})

test('typed bridge client：主语只来自每次调用的实参，不保留会话级状态', async () => {
  await withFetch(okResponse, async (calls) => {
    const read = bridgeCall('rules', { expectedModuleId: 'module-b' }, 'module-b')
    const write = bridgeCall('rules', { expectedModuleId: 'module-b' }, 'module-b')
    const current = bridgeCall('rules', { expectedModuleId: 'module-a' }, 'module-a')
    assert.ok((await Promise.all([read, write, current])).every(result => result.ok))
    assert.deepEqual(calls.map(subjectOf), ['module-b', 'module-b', 'module-a'])
  })
})

test('typed bridge client：optional／none endpoint 不带主语头', async () => {
  await withFetch(okResponse, async (calls) => {
    await bridgeCall('bootstrap', { sessionId: 's1' })
    await bridgeCall('personaSources')
    await bridgeCall('moduleConfigOrder')
    assert.deepEqual(calls.map(call => EDIT_TARGET_HEADER in call.init.headers), [false, false, false])
  })
})

test('typed bridge client：optional endpoint（bootstrap）传了主语才带头', async () => {
  await withFetch(okResponse, async (calls) => {
    await bridgeCall('bootstrap', { sessionId: 's1' })
    await bridgeCall('bootstrap', { sessionId: 's1' }, 'mod-a')
    await bridgeCall('bootstrap', { sessionId: 's1' }, '')
    assert.deepEqual(calls.map(subjectOf), [undefined, 'mod-a', undefined])
  })
})

test('typed bridge client：moduleDelete 带主语时带头，主语为空串时不带头', async () => {
  await withFetch(okResponse, async (calls) => {
    await bridgeCall('moduleDelete', { id: 'm1' }, 'mod-a')
    await bridgeCall('moduleDelete', { id: 'm1' }, '')
    assert.deepEqual(calls.map(call => call.init.headers[EDIT_TARGET_HEADER]), ['mod-a', undefined])
    assert.deepEqual(calls.map(call => EDIT_TARGET_HEADER in call.init.headers), [true, false])
  })
})

test('typed bridge client：required endpoint 的单实参形状在运行时响亮失败', async () => {
  await withFetch(okResponse, async (calls) => {
    // 类型已不允许这个形状（单实参无法区分 body 与主语）；JS／as any 路径必须停在客户端，不静默当 body。
    const result = await bridgeCall('persona', 'mod-a')
    assert.equal(result.ok, false)
    assert.match(result.message, /主语/)
    assert.equal(calls.length, 0, '单实参不得被当作主语，请求不得发出')
  })
})

test('typed bridge client：required endpoint 缺主语时不发请求并返回失败结果', async () => {
  await withFetch(okResponse, async (calls) => {
    for (const args of [[{ expectedModuleId: 'a' }], [{ expectedModuleId: 'a' }, ''], [{ expectedModuleId: 'a' }, '   ']]) {
      const result = await bridgeCall('rules', ...args)
      assert.equal(result.ok, false)
      assert.match(result.message, /主语/)
    }
    assert.equal(calls.length, 0, '缺主语的请求不得发出')
  })
})

test('typed bridge client：uploadBridge 不带主语头', async () => {
  await withFetch(okResponse, async (calls) => {
    await bridgeUpload(new Blob(['x']), 'a.png')
    assert.equal(calls[0].url, SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.assetUpload)
    assert.equal(EDIT_TARGET_HEADER in calls[0].init.headers, false)
  })
})

test('typed bridge client：空响应体转为可诊断的桥接错误', async () => {
  await withFetch(() => new Response(null, { status: 405 }), async () => {
    const result = await bridgeCall('toolSurface', { sessionId: 's1' })
    assert.equal(result.ok, false)
    assert.match(result.message, /空响应/)
    assert.match(result.message, /405/)
  })
})

test('typed bridge client：非 JSON 响应体保留状态码与内容摘要', async () => {
  await withFetch(() => new Response('unauthorized', { status: 401 }), async () => {
    const result = await bridgeCall('toolSurface', { sessionId: 's1' })
    assert.equal(result.ok, false)
    assert.match(result.message, /401/)
    assert.match(result.message, /unauthorized/)
  })
})
