import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { BRIDGE_ENDPOINTS, registerSettingsBridge } from '../../lib/index.mjs'

const PREFIX = '/api/prompt-tool/settings'

function makeHarness() {
  const handlers = new Map()
  const sctx = {
    settings: {
      describe: () => [{ ns: 'prompt-tool', value: { promptText: 'P' }, base: {} }],
      get: (ns) => ns === 'agent-default-model'
        ? { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high' }
        : undefined,
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

test('settings bridge /describe 返回宿主默认模型（agent-default-model 回显）', async () => {
  const { ctx, handlers } = makeHarness()
  registerSettingsBridge(
    ctx,
    'prompt-tool',
    () => ({ available: true, providers: ['deepseek-official'] }),
    () => ({ activeSkillsDirs: [], skillCatalog: [] }),
    () => '',
    () => true,
  )
  const handler = handlers.get(PREFIX + BRIDGE_ENDPOINTS.describe)
  assert.ok(handler, 'describe 端点应注册')
  const res = fakeRes()
  await handler(fakeReq(), res)
  assert.equal(res.status, 200)
  const payload = JSON.parse(res.body)
  assert.deepEqual(payload.hostDefaultModel, {
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    reasoningEffort: 'high',
  })
})

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

test('settings bridge /meta 返回引擎能力矩阵', async () => {
  const { ctx, handlers } = makeHarness()
  registerSettingsBridge(
    ctx,
    () => ({ available: true, providers: [] }),
    () => ({ activeSkillsDirs: [], skillCatalog: [] }),
    () => '',
    () => true,
  )
  const handler = handlers.get(`${PREFIX}/meta`)
  assert.ok(handler)
  const res = fakeRes()
  await handler(fakeReq(), res)
  assert.equal(res.status, 200)
  const payload = JSON.parse(res.body)
  assert.equal(payload.ok, true)
  assert.ok(payload.value.meta.layers.includes('pre-step'))
  assert.ok(payload.value.meta.strategies.includes('custom-fallback'))
})

test('settings bridge 拒绝非 loopback 请求', async () => {
  const { ctx, handlers } = makeHarness()
  registerSettingsBridge(
    ctx,
    () => ({ available: true, providers: [] }),
    () => ({ activeSkillsDirs: [], skillCatalog: [] }),
    () => '',
    () => true,
  )
  const handler = handlers.get(`${PREFIX}/meta`)
  const res = fakeRes()
  await handler(fakeReq({ socket: { remoteAddress: '203.0.113.1' } }), res)
  assert.equal(res.status, 403)
  assert.equal(JSON.parse(res.body).ok, false)
})

test('settings bridge /prompt-configs 返回生成目录实际生效配置', async () => {
  const { ctx, handlers } = makeHarness()
  registerSettingsBridge(
    ctx,
    () => ({ available: true, providers: [] }),
    () => ({ activeSkillsDirs: [], skillCatalog: [] }),
    () => '',
    () => true,
    undefined,
    // 指向真实的生成目录（本仓库构建产物，writePreset 测试已生成）。
    () => join(tmpdir(), 'prompt-tool-preset-not-exist'),
  )
  const handler = handlers.get(`${PREFIX}/prompt-configs`)
  assert.ok(handler, '/prompt-configs 端点应注册')
  const res = fakeRes()
  await handler(fakeReq(), res)
  assert.equal(res.status, 200)
  const payload = JSON.parse(res.body)
  assert.equal(payload.ok, true)
  assert.ok(Array.isArray(payload.value.promptConfigs), '降级为空数组')
  assert.equal(payload.value.promptConfigs.length, 0)
})

test('settings bridge /import-preset 写入生成目录并触发回调；/preset-content 读回', async () => {
  const { ctx, handlers } = makeHarness()
  let importedScopes
  const dir = join(tmpdir(), `prompt-tool-bridge-${process.pid}-${Date.now()}`)
  try {
    registerSettingsBridge(
      ctx,
      'prompt-tool',
      () => ({ available: true, providers: [] }),
      () => ({ activeSkillsDirs: [], skillCatalog: [] }),
      () => '',
      () => true,
      undefined,
      () => dir,
      (scopes) => { importedScopes = scopes },
    )
    const write = handlers.get(`${PREFIX}/import-preset`)
    const read = handlers.get(`${PREFIX}/preset-content`)
    assert.ok(write && read, '/import-preset 与 /preset-content 应注册')
    // 导入 preset
    const wres = fakeRes()
    await write(fakeReq({ body: undefined, [Symbol.asyncIterator]: async function* () {
      yield Buffer.from(JSON.stringify({ scope: 'preset', content: 'HELLO PRESET' }))
    } }), wres)
    assert.equal(wres.status, 200)
    assert.deepEqual(importedScopes, ['preset'])
    // 读回
    const rres = fakeRes()
    await read(fakeReq({ body: undefined, [Symbol.asyncIterator]: async function* () {
      yield Buffer.from(JSON.stringify({ scope: 'preset' }))
    } }), rres)
    assert.equal(rres.status, 200)
    assert.equal(JSON.parse(rres.body).value.content, 'HELLO PRESET')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('settings bridge /param-overrides 接受 >64KB promptConfigs 载荷（不再静默截断为读取）', async () => {
  const { ctx, handlers } = makeHarness()
  // handler 写路径 = dirname(getPresetConfigsDir())/basename(...)/preset.yml：
  // 激活预设目录就是 preset.yml 所在目录，fixture 直接建在 dir 下。
  const dir = join(tmpdir(), `pt-overrides-big-${process.pid}-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'preset.yml'), 'id: beta\n', 'utf8')
  try {
    registerSettingsBridge(
      ctx,
      'prompt-tool',
      () => ({ available: true, providers: [] }),
      () => ({ activeSkillsDirs: [], skillCatalog: [] }),
      () => '',
      () => true,
      undefined,
      () => dir,
    )
    const write = handlers.get(`${PREFIX}${BRIDGE_ENDPOINTS.paramOverrides}`)
    assert.ok(write, '/param-overrides 端点应注册')
    // 129 卡实测 70KB：用 80KB 单卡模拟超旧 64KB 上限的载荷。
    const big = { promptConfigs: [{ id: 'big-card', name: 'big', layer: 'pre-step', text: 'x'.repeat(80 * 1024) }] }
    const wres = fakeRes()
    await write(fakeReq({ [Symbol.asyncIterator]: async function* () {
      yield Buffer.from(JSON.stringify(big))
    } }), wres)
    assert.equal(wres.status, 200)
    const payload = JSON.parse(wres.body)
    assert.equal(payload.ok, true)
    // 写分支成功形状 = 回显 promptConfigs；读取分支形状 = { overrides }。
    assert.ok(payload.value.promptConfigs !== undefined, '应为写分支回显，而非被截断成读取分支')
    assert.ok(readFileSync(join(dir, 'preset.yml'), 'utf8').includes('big-card'), 'promptConfigs 应真实落盘')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('settings bridge /param-overrides 拒绝未知引擎参数键（防死键落盘）', async () => {
  const { ctx, handlers } = makeHarness()
  const dir = join(tmpdir(), `pt-overrides-unknown-${process.pid}-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'preset.yml'), 'id: beta\n', 'utf8')
  try {
    registerSettingsBridge(
      ctx,
      'prompt-tool',
      () => ({ available: true, providers: [] }),
      () => ({ activeSkillsDirs: [], skillCatalog: [] }),
      () => '',
      () => true,
      undefined,
      () => dir,
    )
    const write = handlers.get(`${PREFIX}${BRIDGE_ENDPOINTS.paramOverrides}`)
    assert.ok(write, '/param-overrides 端点应注册')
    const res = fakeRes()
    await write(fakeReq({ [Symbol.asyncIterator]: async function* () {
      yield Buffer.from(JSON.stringify({ overrides: { notAnEngineParam: true } }))
    } }), res)
    assert.equal(res.status, 400)
    const payload = JSON.parse(res.body)
    assert.equal(payload.ok, false)
    assert.equal(payload.code, 'overrides-unknown-key')
    assert.match(payload.message, /notAnEngineParam/)
    assert.equal(readFileSync(join(dir, 'preset.yml'), 'utf8'), 'id: beta\n', '未知键不得写入 preset.yml')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('settings bridge /configs-validate 接受 >64KB promptConfigs 载荷（不再 400 unreadable JSON body）', async () => {
  const { ctx, handlers } = makeHarness()
  registerSettingsBridge(
    ctx,
    'prompt-tool',
    () => ({ available: true, providers: [] }),
    () => ({ activeSkillsDirs: [], skillCatalog: [] }),
    () => '',
    () => true,
  )
  const handler = handlers.get(`${PREFIX}${BRIDGE_ENDPOINTS.configsValidate}`)
  assert.ok(handler, '/configs-validate 端点应注册')
  const big = { promptConfigs: [{ id: 'big-validate', layer: 'pre-step', strategy: 'static', text: 'x'.repeat(80 * 1024) }] }
  const res = fakeRes()
  await handler(fakeReq({ [Symbol.asyncIterator]: async function* () {
    yield Buffer.from(JSON.stringify(big))
  } }), res)
  assert.equal(res.status, 200)
  const payload = JSON.parse(res.body)
  assert.equal(payload.ok, true)
  assert.ok(payload.value !== undefined, '应进入校验分支而非 400 截断')
})
