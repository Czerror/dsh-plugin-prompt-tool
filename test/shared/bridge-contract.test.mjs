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
      register: ({ path, handler }) => { handlers.set(path, handler); return () => {} },
    },
    agents: {
      get: (id) => id === 'live-session' ? { id } : undefined,
    },
    tools: {
      schemas: () => [{ name: 'bash', description: '运行命令' }],
    },
    agentPresets: {
      list: async () => [{ id: 'official', trust: 'system' }],
      standingKeyFor: async (id) => ({ id }),
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
    () => ({ available: true, providers: ['deepseek-official'] }),
    () => ({ activeSkillsDirs: [], skillCatalog: [] }),
    () => '',
  )
  return handlers
}

function fakeReq(overrides = {}) {
  const req = {
    method: 'POST',
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: 'localhost' },
    ...overrides,
  }
  req[Symbol.asyncIterator] = function* () {
    const raw = req.body
    if (raw !== undefined && raw !== null && raw !== '') yield Buffer.from(String(raw))
    return { done: true }
  }
  return req
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

test('契约：所有端点路径全部注册且无多余', () => {
  const handlers = register()
  const expected = Object.values(BRIDGE_ENDPOINTS)
  assert.equal(expected.length, 31, 'BRIDGE_ENDPOINTS 应包含当前登记的 31 个端点')
  const registered = [...handlers.keys()].sort()
  const wanted = expected.map((p) => SETTINGS_BRIDGE_PREFIX + p).sort()
  assert.deepEqual(registered, wanted)
})

test('契约：/bootstrap 聚合 meta + overrides + variables + promptConfigs 供客户端单请求消费', async () => {
  const handlers = register()
  const handler = handlers.get(SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.bootstrap)
  assert.ok(handler, '/bootstrap 端点未注册')
  const res = fakeRes()
  await handler(fakeReq(), res)
  assert.equal(res.status, 200)
  const payload = JSON.parse(res.body)
  assert.equal(payload.ok, true)
  // 客户端 load() 消费路径：meta.meta / overrides.overrides / variables.variables /
  // promptConfigs.promptConfigs 全部存在（空值兜底形状，非 undefined）。
  assert.ok(payload.meta !== undefined && payload.meta.meta !== undefined)
  assert.ok(Array.isArray(payload.overrides.overrides) || typeof payload.overrides.overrides === 'object')
  assert.ok(typeof payload.variables.variables === 'object' && typeof payload.variables.enabled === 'boolean')
  assert.ok(Array.isArray(payload.promptConfigs.promptConfigs))
  assert.ok(payload.moduleFacts === undefined || payload.moduleFacts.effectiveConfigs === undefined, 'bootstrap 不应暴露完整行级配置')
})

test('契约：成功载荷统一为 { ok: true, value }', async () => {
  const handlers = register()
  // 抽样无需 settings/descriptor 依赖的端点，断言客户端 typed bridge 消费形状（res.value.*）。
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

test('契约：/tool-surface 返回存活 Agent 的只读工具面摘要，未知 session 稳定错误', async () => {
  const handlers = register()
  const handler = handlers.get(SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.toolSurface)
  assert.ok(handler, '/tool-surface 端点未注册')
  const ok = fakeRes()
  await handler(fakeReq({ body: JSON.stringify({ sessionId: 'live-session' }) }), ok)
  assert.equal(ok.status, 200)
  const payload = JSON.parse(ok.body)
  assert.equal(payload.ok, true)
  assert.deepEqual(payload.value.tools, [{ name: 'bash', description: '运行命令' }], '只返回 name/description')
  assert.equal(payload.value.source, 'session')
  const unknown = fakeRes()
  await handler(fakeReq({ body: JSON.stringify({ sessionId: 'nope' }) }), unknown)
  assert.equal(unknown.status, 404)
  const unknownPayload = JSON.parse(unknown.body)
  assert.equal(unknownPayload.ok, false)
  assert.equal(unknownPayload.code, 'tool-surface-unknown-session')
})

test('契约：/tool-surface 支持官方 preset scope 且只读有效 schema', async () => {
  const handlers = register()
  const handler = handlers.get(SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.toolSurface)
  const ok = fakeRes()
  await handler(fakeReq({ body: JSON.stringify({ presetId: 'official' }) }), ok)
  assert.equal(ok.status, 200)
  const payload = JSON.parse(ok.body)
  assert.equal(payload.value.source, 'preset')
  assert.equal(payload.value.presetId, 'official')
  assert.deepEqual(payload.value.tools, [{ name: 'bash', description: '运行命令' }])

  const invalid = fakeRes()
  await handler(fakeReq({ body: JSON.stringify({ sessionId: 'live-session', presetId: 'official' }) }), invalid)
  assert.equal(invalid.status, 400)
  assert.equal(JSON.parse(invalid.body).code, 'tool-surface-invalid')
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
