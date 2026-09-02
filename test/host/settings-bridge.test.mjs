import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'
import { BRIDGE_ENDPOINTS, MAX_BRIDGE_BODY_BYTES, MAX_CHARACTER_CARD_STREAM_BYTES, registerSettingsBridge } from '../../lib/index.mjs'

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

test('settings bridge /param-overrides 数值参数保存前校验（temperature/maxTokens 响亮失败）', async () => {
  const { ctx, handlers } = makeHarness()
  const dir = join(tmpdir(), 'pt-overrides-invalid-' + process.pid + '-' + Date.now())
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'preset.yml'), 'id: beta\n', 'utf8')
  try {
    registerSettingsBridge(
      ctx,
      'prompt-tool',
      () => ({ available: true, providers: [] }),
      () => ({ activeSkillsDirs: [], skillCatalog: [] }),
      () => '',
        undefined,
      () => dir,
    )
    const write = handlers.get(PREFIX + BRIDGE_ENDPOINTS.paramOverrides)
    assert.ok(write, '/param-overrides 端点应注册')

    // 非法值：temperature 非数字、maxTokens 非正整数 -> 400 逐字段错误，不落盘。
    const res = fakeRes()
    await write(fakeReq({ [Symbol.asyncIterator]: async function* () {
      yield Buffer.from(JSON.stringify({ overrides: { modelTemperature: 'abc', modelMaxTokens: '-5', subagentTemperature: '   ', subagentMaxTokens: true } }))
    } }), res)
    assert.equal(res.status, 400)
    const payload = JSON.parse(res.body)
    assert.equal(payload.ok, false)
    assert.equal(payload.code, 'overrides-invalid-value')
    assert.match(payload.message, /modelTemperature/)
    assert.match(payload.message, /modelMaxTokens/)
    assert.match(payload.message, /subagentTemperature/)
    assert.match(payload.message, /subagentMaxTokens/)
    assert.equal(readFileSync(join(dir, 'preset.yml'), 'utf8'), 'id: beta\n', '非法值不得写入 preset.yml')

    // 合法值（含空串 = 删键回落、number 直写两通道）照常 200。
    const res2 = fakeRes()
    await write(fakeReq({ [Symbol.asyncIterator]: async function* () {
      yield Buffer.from(JSON.stringify({ overrides: { modelTemperature: '0.7', modelMaxTokens: '8192', subagentTemperature: '', subagentMaxTokens: 4096 } }))
    } }), res2)
    assert.equal(res2.status, 200)
    assert.equal(JSON.parse(res2.body).ok, true)
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

test('settings bridge /param-overrides rebuild=false 只落盘不重建（预设切换免双重建）', async () => {
  const { ctx, handlers } = makeHarness()
  const dir = join(tmpdir(), `pt-overrides-no-rebuild-${process.pid}-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'preset.yml'), 'id: beta\n', 'utf8')
  let rebuildCount = 0
  try {
    registerSettingsBridge(
      ctx,
      'prompt-tool',
      () => ({ available: true, providers: [] }),
      () => ({ activeSkillsDirs: [], skillCatalog: [] }),
      () => '',
        undefined,
      () => dir,
      undefined,
      () => { rebuildCount += 1 },
    )
    const write = handlers.get(`${PREFIX}${BRIDGE_ENDPOINTS.paramOverrides}`)
    assert.ok(write, '/param-overrides 端点应注册')
    const res = fakeRes()
    await write(fakeReq({ [Symbol.asyncIterator]: async function* () {
      yield Buffer.from(JSON.stringify({ promptConfigs: [{ id: 'deferred-card' }], rebuild: false }))
    } }), res)
    assert.equal(res.status, 200)
    assert.equal(JSON.parse(res.body).ok, true)
    assert.equal(rebuildCount, 0, '切换前保存不应立即重建')
    assert.ok(readFileSync(join(dir, 'preset.yml'), 'utf8').includes('deferred-card'), '配置应真实落盘')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

function makePngCharacterCard() {
  const card = JSON.stringify({
    spec: 'chara_card_v3',
    name: '流式测试卡',
    data: { name: '流式测试卡', first_mes: '你好。', character_book: { entries: [] } },
  })
  const makeChunk = (type, data) => {
    const header = Buffer.alloc(4)
    header.writeUInt32BE(data.length, 0)
    return Buffer.concat([header, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)])
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    makeChunk('tEXt', Buffer.from('ccv3\0' + Buffer.from(card, 'utf8').toString('base64'), 'latin1')),
    makeChunk('IEND', Buffer.alloc(0)),
  ])
}

test('settings bridge：所有 JSON 端点统一 32 MiB 上限并返回明确 413', async () => {
  assert.equal(MAX_BRIDGE_BODY_BYTES, 32 * 1024 * 1024)
  assert.equal(MAX_CHARACTER_CARD_STREAM_BYTES, 32 * 1024 * 1024)
  const { ctx, handlers } = makeHarness()
  registerSettingsBridge(
    ctx,
    'prompt-tool',
    () => ({ available: true, providers: [] }),
    () => ({ activeSkillsDirs: [], skillCatalog: [] }),
    () => '',
  )
  const handler = handlers.get(PREFIX + BRIDGE_ENDPOINTS.mutate)
  assert.ok(handler, '/mutate 端点应注册')
  const oneMiB = Buffer.alloc(1024 * 1024, 0x78)
  const res = fakeRes()
  await handler(fakeReq({ [Symbol.asyncIterator]: async function* () {
    for (let index = 0; index < 33; index += 1) yield oneMiB
  } }), res)
  assert.equal(res.status, 413)
  const payload = JSON.parse(res.body)
  assert.equal(payload.ok, false)
  assert.equal(payload.code, 'bridge-body-too-large')
  assert.match(payload.message, /32MB/)
})

test('settings bridge：角色卡原始文件流支持扩展名错误的 PNG 并清理临时文件', async () => {
  const { ctx, handlers } = makeHarness()
  const root = join(tmpdir(), 'pt-character-stream-' + process.pid + '-' + Date.now())
  const activeDir = join(root, 'anchored')
  mkdirSync(activeDir, { recursive: true })
  try {
    registerSettingsBridge(
      ctx,
      'prompt-tool',
      () => ({ available: true, providers: [] }),
      () => ({ activeSkillsDirs: [], skillCatalog: [] }),
      () => '',
      undefined,
      () => activeDir,
    )
    const handler = handlers.get(PREFIX + BRIDGE_ENDPOINTS.charactersImportStream)
    assert.ok(handler, '角色卡流式端点应注册')
    const png = makePngCharacterCard()
    const req = Readable.from([png])
    req.method = 'POST'
    req.socket = { remoteAddress: '127.0.0.1' }
    req.headers = { host: 'localhost', 'x-file-name': encodeURIComponent('card.jpg') }
    const res = fakeRes()
    await handler(req, res)
    assert.equal(res.status, 200)
    const payload = JSON.parse(res.body)
    assert.equal(payload.ok, true)
    assert.equal(payload.value.receivedBytes, png.length)
    const cardDir = join(root, '.characters', payload.value.id)
    assert.equal(statSync(join(cardDir, 'avatar.png')).size, png.length)
    assert.equal(JSON.parse(readFileSync(join(cardDir, 'card.json'), 'utf8')).name, '流式测试卡')
    assert.deepEqual(readdirSync(root).filter((name) => name.startsWith('.characters-upload-')), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
test('settings bridge：角色卡流式导入超过 32 MiB 返回 413 并清理临时文件', async () => {
  const { ctx, handlers } = makeHarness()
  const root = join(tmpdir(), 'pt-character-stream-limit-' + process.pid + '-' + Date.now())
  const activeDir = join(root, 'anchored')
  mkdirSync(activeDir, { recursive: true })
  try {
    registerSettingsBridge(
      ctx,
      'prompt-tool',
      () => ({ available: true, providers: [] }),
      () => ({ activeSkillsDirs: [], skillCatalog: [] }),
      () => '',
      undefined,
      () => activeDir,
    )
    const handler = handlers.get(PREFIX + BRIDGE_ENDPOINTS.charactersImportStream)
    assert.ok(handler, '角色卡流式端点应注册')
    const chunk = Buffer.alloc(1024 * 1024, 0x78)
    const req = Readable.from((async function* () {
      for (let index = 0; index < 33; index += 1) yield chunk
    })())
    req.method = 'POST'
    req.socket = { remoteAddress: '127.0.0.1' }
    req.headers = { host: 'localhost', 'x-file-name': 'too-large.png' }
    const res = fakeRes()
    await handler(req, res)
    assert.equal(res.status, 413)
    const payload = JSON.parse(res.body)
    assert.equal(payload.ok, false)
    assert.equal(payload.code, 'character-stream-too-large')
    assert.match(payload.message, /32MB/)
    assert.deepEqual(readdirSync(root).filter((name) => name.startsWith('.characters-upload-')), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('settings bridge Origin 完整校验 scheme/host/port（端口不匹配拒绝）', async () => {
  const { ctx, handlers } = makeHarness()
  registerSettingsBridge(ctx, () => ({ available: true, providers: [] }), () => ({ activeSkillsDirs: [], skillCatalog: [] }), () => '')
  const handler = handlers.get(`${PREFIX}/meta`)
  // 同源（loopback + 端口一致）放行。
  const okRes = fakeRes()
  await handler(fakeReq({ headers: { host: 'localhost:3080', origin: 'http://localhost:3080' } }), okRes)
  assert.equal(okRes.status, 200)
  // 端口不匹配（本地另一端口服务伪造 loopback hostname）拒绝。
  const badPortRes = fakeRes()
  await handler(fakeReq({ headers: { host: 'localhost:3080', origin: 'http://localhost:9999' } }), badPortRes)
  assert.equal(badPortRes.status, 403)
  // 非法 scheme 拒绝。
  const badSchemeRes = fakeRes()
  await handler(fakeReq({ headers: { host: 'localhost:3080', origin: 'ftp://localhost:3080' } }), badSchemeRes)
  assert.equal(badSchemeRes.status, 403)
  // 非 loopback hostname 拒绝。
  const badHostRes = fakeRes()
  await handler(fakeReq({ headers: { host: 'localhost:3080', origin: 'http://evil.com:3080' } }), badHostRes)
  assert.equal(badHostRes.status, 403)
})

test('settings bridge /custom-tools 保存时自动追加工具模块', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pt-custom-tools-modules-'))
  try {
    writeFileSync(join(dir, 'preset.yml'), ['id: beta', 'modules: []', ''].join(String.fromCharCode(10)), 'utf8')
    const { ctx, handlers } = makeHarness()
    registerSettingsBridge(ctx, 'prompt-tool',
      () => ({ available: true, providers: [] }),
      () => ({ activeSkillsDirs: [], skillCatalog: [] }),
      () => '',
      undefined,
      () => dir,
      undefined,
      undefined,
      () => {},
    )
    const handler = handlers.get(PREFIX + BRIDGE_ENDPOINTS.customTools)
    assert.ok(handler, '/custom-tools 端点应注册')
    const payload = Buffer.from(JSON.stringify({ customTools: [
      { id: 'shell', execute: { kind: 'shell' } },
      { id: 'world', execute: { kind: 'delegate', tool: 'world_book_upsert' } },
    ] }))
    const res = fakeRes()
    await handler(fakeReq({ [Symbol.asyncIterator]: async function* () { yield payload } }), res)
    assert.equal(res.status, 200)
    const parsed = parseYaml(readFileSync(join(dir, 'preset.yml'), 'utf8'))
    assert.ok(parsed.modules.includes('tool-config-engine'), '保存自定义工具时自动装配 tool-config-engine')
    assert.ok(parsed.modules.includes('world-book-tools'), '委托世界书工具时自动装配 world-book-tools')
    assert.equal(new Set(parsed.modules).size, parsed.modules.length, '模块不应重复')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('settings bridge /custom-tools 拒绝缺少 modules 的预设', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pt-custom-tools-no-modules-'))
  try {
    writeFileSync(join(dir, 'preset.yml'), 'id: plain' + String.fromCharCode(10), 'utf8')
    const { ctx, handlers } = makeHarness()
    registerSettingsBridge(ctx, 'prompt-tool',
      () => ({ available: true, providers: [] }),
      () => ({ activeSkillsDirs: [], skillCatalog: [] }),
      () => '',
      undefined,
      () => dir,
      undefined,
      undefined,
      () => {},
    )
    const handler = handlers.get(PREFIX + BRIDGE_ENDPOINTS.customTools)
    const payload = Buffer.from(JSON.stringify({ customTools: [{ id: 'shell', execute: { kind: 'shell' } }] }))
    const res = fakeRes()
    await handler(fakeReq({ [Symbol.asyncIterator]: async function* () { yield payload } }), res)
    assert.equal(res.status, 409)
    assert.doesNotMatch(readFileSync(join(dir, 'preset.yml'), 'utf8'), /customTools|modules:/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
