import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BRIDGE_ENDPOINTS, SETTINGS_BRIDGE_PREFIX, registerSettingsBridge } from '../../lib/index.mjs'

// 跨端契约测试：shared 常量（client 消费）必须与 server 注册路由逐点一致。

function makeHarness() {
  const handlers = new Map()
  const agentPresets = {
    list: async () => [{ id: 'official', trust: 'system' }],
    standingKeyFor: async (id) => ({ id }),
  }
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
    get: (name) => name === 'agentPresets' ? agentPresets : undefined,
    effect: (fn) => fn(),
  }
  // Cordis 语义：未 inject 的服务属性访问直接抛错，可选服务只能经 ctx.get 解析。
  Object.defineProperty(sctx, 'agentPresets', {
    get() { throw new Error('cannot get property "agentPresets" without inject') },
  })
  const ctx = { inject: (_deps, cb) => cb(sctx) }
  return { ctx, handlers }
}

/** 注册层屏蔽模型的技能状态替身：技能实体留在官方技能根，插件只提供屏蔽表、引用目录与清单。 */
function makeSkillsState(overrides = {}) {
  const state = { version: 3, blocked: [], folders: [] }
  return {
    skillsRoot: 'D:/isolated/skills',
    blocked: [],
    folders: [],
    listSkills: () => [],
    setSkillBlocked: () => ({ ok: true, state, exists: true }),
    patchSkillFolders: () => ({ ok: true, state, exists: true }),
    ...overrides,
  }
}

function register(skillsState = makeSkillsState()) {
  const { ctx, handlers } = makeHarness()
  registerSettingsBridge(
    ctx,
    'prompt-tool',
    () => ({ available: true, providers: ['deepseek-official'] }),
    () => skillsState,
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
  // 注册层屏蔽模型：skillFix / skillToggle / skillsConfig / skillPolicy 已删除，技能端点收敛为 7 个。
  assert.equal(expected.length, 41, 'BRIDGE_ENDPOINTS 应包含当前登记的 41 个端点')
  for (const removed of ['skillFix', 'skillToggle', 'skillsConfig', 'skillPolicy']) {
    assert.equal(Object.hasOwn(BRIDGE_ENDPOINTS, removed), false, `${removed} 已随注册层屏蔽模型移除`)
  }
  for (const kept of ['skillsList', 'skillBlock', 'skillsFolders', 'skillsImport', 'skillsImportDirectory', 'skillCreate', 'skillDelete']) {
    assert.equal(typeof BRIDGE_ENDPOINTS[kept], 'string', `${kept} 端点必须存在`)
  }
  const registered = [...handlers.keys()].sort()
  const wanted = expected.map((p) => SETTINGS_BRIDGE_PREFIX + p).sort()
  assert.deepEqual(registered, wanted)
})

test('契约：/bootstrap 聚合 meta + overrides + variables + promptConfigs 供客户端单请求消费', async () => {
  // 技能事实用非空数据断言透传：stub 的默认空表无法区分「如实下发」与「兜底成空」。
  const blocked = [{ name: 'demo-skill', at: '2026-09-17T00:00:00.000Z', model: false }]
  const entry = { id: 'user-dsh:D:/isolated/skills:demo-skill', name: 'demo-skill', source: 'user-dsh', rank: 400, valid: true, blocked: true }
  const handlers = register(makeSkillsState({
    blocked,
    folders: ['D:/referenced'],
    listSkills: () => [entry],
  }))
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
  // 技能事实在同一聚合响应里下发：清单 + 引用目录 + 用户技能根。
  // 屏蔽状态不单独下发——它已经逐条表达在 skillCatalog 条目的按端标志里。
  assert.deepEqual(payload.activeSkillsDirs, ['D:/isolated/skills'])
  assert.deepEqual(payload.skillFolders, ['D:/referenced'])
  assert.deepEqual(payload.skillCatalog, [entry])
  assert.equal('skillBlocked' in payload, false, '屏蔽表不再单独下发，避免第二个真相')
  assert.equal('skillsDirExists' in payload, false, '目录存在性字段已删除')
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

test('契约：/persona 未配置 presetDir 时稳定拒绝', async () => {
  const handlers = register()
  const handler = handlers.get(SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.persona)
  assert.ok(handler, '/persona 端点未注册')
  const res = fakeRes()
  await handler(fakeReq({ body: JSON.stringify({}) }), res)
  assert.equal(res.status, 400)
  const payload = JSON.parse(res.body)
  assert.equal(payload.ok, false)
  assert.equal(payload.code, 'preset-dir-unavailable')
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
