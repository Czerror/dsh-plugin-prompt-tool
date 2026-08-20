import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BRIDGE_ENDPOINTS, SETTINGS_BRIDGE_PREFIX, registerSettingsBridge } from '../../lib/index.mjs'

// 跨端契约测试：shared 常量（client 消费）必须与 server 注册路由逐点一致。

function makeHarness() {
  const handlers = new Map()
  const sctx = {
    settings: {
      describe: () => [{ ns: 'prompt-tool', value: { promptText: 'P' }, base: {} }],
      mutate: async () => {},
    },
    webServer: {
      register: ({ path, handler }) => { handlers.set(path, handler) },
    },
    effect: (fn) => fn(),
  }
  const ctx = { inject: (_deps, cb) => cb(sctx) }
  return { ctx, handlers }
}

function register() {
  const { ctx, handlers } = makeHarness()
  registerSettingsBridge(
    ctx,
    'prompt-tool',
    () => true,
    () => ({ available: true, providers: ['deepseek-official'] }),
    () => ({ activeSkillsDir: '', skillCatalog: [] }),
    () => ({ presetText: '', agentsText: '' }),
    () => '',
    () => true,
  )
  return handlers
}

function fakeReq(overrides = {}) {
  return {
    method: 'POST',
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: 'localhost' },
    [Symbol.asyncIterator]() {
      return { next: async () => ({ done: true, value: undefined }) }
    },
    ...overrides,
  }
}

function fakeRes() {
  let status = 0
  let body = ''
  return {
    writeHead(code) { status = code },
    end(payload) { body = payload },
    get status() { return status },
    get body() { return body },
  }
}

test('契约：client 前缀与 server 注册前缀同源', () => {
  assert.equal(SETTINGS_BRIDGE_PREFIX, '/api/prompt-tool/settings')
  assert.equal(typeof SETTINGS_BRIDGE_PREFIX, 'string')
  assert.ok(SETTINGS_BRIDGE_PREFIX.startsWith('/api/'))
})

test('契约：8 个端点路径全部注册且无多余', () => {
  const handlers = register()
  const expected = Object.values(BRIDGE_ENDPOINTS)
  assert.equal(expected.length, 9, 'BRIDGE_ENDPOINTS 应恰好 9 个端点')
  const registered = [...handlers.keys()].sort()
  const wanted = expected.map((p) => SETTINGS_BRIDGE_PREFIX + p).sort()
  assert.deepEqual(registered, wanted)
})

test('契约：成功载荷统一为 { ok: true, value }', async () => {
  const handlers = register()
  // 抽样无需 settings/descriptor 依赖的端点，断言客户端 bridgePost 消费形状（res.value.*）。
  for (const path of [SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.meta, SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.templates]) {
    const handler = handlers.get(path)
    assert.ok(handler, `端点未注册: ${path}`)
    const res = fakeRes()
    await handler(fakeReq(), res)
    assert.equal(res.status, 200)
    const payload = JSON.parse(res.body)
    assert.equal(payload.ok, true)
    assert.ok(payload.value !== undefined && payload.value !== null, `${path} 成功载荷必须带 value`)
  }
})

test('契约：失败载荷统一为 { ok: false, code?, message? }', async () => {
  const handlers = register()
  // 非法方法触发 405 失败分支。
  const handler = handlers.get(SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.meta)
  const res = fakeRes()
  await handler(fakeReq({ method: 'GET' }), res)
  assert.equal(res.status, 405)
  const payload = JSON.parse(res.body)
  assert.equal(payload.ok, false)
  assert.equal(typeof payload.code, 'string')
  assert.equal(typeof payload.message, 'string')
})
