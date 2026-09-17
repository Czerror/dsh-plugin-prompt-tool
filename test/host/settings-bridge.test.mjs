import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'

const bridgeHome = mkdtempSync(join(tmpdir(), 'pt-settings-bridge-home-'))
process.env.DSH_HOME = bridgeHome
// 技能扫描的其余来源一并隔离：不读到真实用户目录 / 真实内置技能目录。
process.env.DSH_AGENTS_HOME = join(bridgeHome, 'agents')
process.env.DSH_BUNDLED_SKILL_DIR = join(bridgeHome, 'bundled-skills')
const {
  BRIDGE_ENDPOINTS, MAX_BRIDGE_BODY_BYTES, MAX_CHARACTER_CARD_STREAM_BYTES, registerSettingsBridge,
  blockRecordFor, blockScopeOf, catalogFromScan, readSkillsState, scanRoots, skillRoots, writeSkillsState,
} = await import('../../lib/index.mjs')
after(() => {
  rmSync(bridgeHome, { recursive: true, force: true })
  delete process.env.DSH_HOME
  delete process.env.DSH_AGENTS_HOME
  delete process.env.DSH_BUNDLED_SKILL_DIR
})

/** 注册层屏蔽模型的技能状态替身：技能实体留在官方技能根，插件只提供屏蔽表、引用目录与清单。 */
function skillsStateStub(overrides = {}) {
  const state = { version: 3, blocked: [], folders: [] }
  return {
    skillsRoot: join(bridgeHome, 'skills'),
    blocked: [],
    folders: [],
    listSkills: () => [],
    setSkillBlocked: () => ({ ok: true, state, exists: true }),
    patchSkillFolders: () => ({ ok: true, state, exists: true }),
    ...overrides,
  }
}

const PREFIX = '/api/prompt-tool/settings'
const userPresetRoot = join(bridgeHome, '.agent-presets')

function makeUserPresetDir(prefix) {
  mkdirSync(userPresetRoot, { recursive: true })
  return mkdtempSync(join(userPresetRoot, prefix))
}

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
    () => skillsStateStub(),
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
    () => skillsStateStub(),
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
    () => skillsStateStub(),
    () => '',
  )
  const handler = handlers.get(`${PREFIX}/meta`)
  const res = fakeRes()
  await handler(fakeReq({ socket: { remoteAddress: '203.0.113.1' } }), res)
  assert.equal(res.status, 403)
  assert.equal(JSON.parse(res.body).ok, false)
})

test('settings bridge /skills-import 写入技能文件并触发目录刷新回调', async () => {
  const dir = mkdtempSync(join(tmpdir(), `pt-skills-import-${process.pid}-`))
  let refreshes = 0
  try {
    const { ctx, handlers } = makeHarness()
    registerSettingsBridge(
      ctx,
      'prompt-tool',
      () => ({ available: true, providers: [] }),
      () => skillsStateStub({ skillsRoot: dir }),
      () => '',
      () => { refreshes += 1 },
    )
    const handler = handlers.get(PREFIX + BRIDGE_ENDPOINTS.skillsImport)
    assert.ok(handler, '/skills-import 端点应注册')
    const body = JSON.stringify({
      files: [{
        path: 'bundle/demo/SKILL.md',
        content: Buffer.from('---\nname: demo\ndescription: demo\n---\n').toString('base64'),
      }],
    })
    const res = fakeRes()
    await handler(fakeReq({ [Symbol.asyncIterator]: async function* () { yield Buffer.from(body) } }), res)
    assert.equal(res.status, 200)
    const payload = JSON.parse(res.body)
    assert.equal(payload.ok, true)
    assert.equal(payload.value.count, 1)
    assert.equal(readFileSync(join(dir, 'bundle', 'demo', 'SKILL.md'), 'utf8'), '---\nname: demo\ndescription: demo\n---\n')
    assert.equal(existsSync(join(dir, '.system')), false, '导入不落受管实体库')
    assert.equal(refreshes, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('settings bridge /skills-import 拒绝空文件列表且不触发刷新', async () => {
  const dir = mkdtempSync(join(tmpdir(), `pt-skills-import-empty-${process.pid}-`))
  let refreshes = 0
  try {
    const { ctx, handlers } = makeHarness()
    registerSettingsBridge(
      ctx,
      'prompt-tool',
      () => ({ available: true, providers: [] }),
      () => skillsStateStub({ skillsRoot: dir }),
      () => '',
      () => { refreshes += 1 },
    )
    const handler = handlers.get(PREFIX + BRIDGE_ENDPOINTS.skillsImport)
    assert.ok(handler)
    const res = fakeRes()
    await handler(fakeReq({ [Symbol.asyncIterator]: async function* () {
      yield Buffer.from(JSON.stringify({ files: [] }))
    } }), res)
    assert.equal(res.status, 400)
    assert.equal(JSON.parse(res.body).code, 'skills-import-rejected')
    assert.equal(refreshes, 0)
    assert.deepEqual(readdirSync(dir), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('settings bridge /skills-import 拒绝路径穿越且不触发刷新', async () => {
  const dir = mkdtempSync(join(tmpdir(), `pt-skills-import-invalid-${process.pid}-`))
  let refreshes = 0
  try {
    const { ctx, handlers } = makeHarness()
    registerSettingsBridge(
      ctx,
      'prompt-tool',
      () => ({ available: true, providers: [] }),
      () => skillsStateStub({ skillsRoot: dir }),
      () => '',
      () => { refreshes += 1 },
    )
    const handler = handlers.get(PREFIX + BRIDGE_ENDPOINTS.skillsImport)
    assert.ok(handler)
    const res = fakeRes()
    await handler(fakeReq({ [Symbol.asyncIterator]: async function* () {
      yield Buffer.from(JSON.stringify({ files: [{ path: 'bundle/../../escape.txt', content: 'ZXZpbA==' }] }))
    } }), res)
    assert.equal(res.status, 400)
    assert.equal(JSON.parse(res.body).code, 'skills-import-rejected')
    assert.equal(refreshes, 0)
    assert.equal(existsSync(join(dir, 'escape.txt')), false)
    assert.deepEqual(readdirSync(dir), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('settings bridge /prompt-configs 返回生成目录实际生效配置', async () => {
  const { ctx, handlers } = makeHarness()
  registerSettingsBridge(
    ctx,
    () => ({ available: true, providers: [] }),
    () => skillsStateStub(),
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
  const dir = makeUserPresetDir('pt-content-')
  try {
    registerSettingsBridge(
      ctx,
      'prompt-tool',
      () => ({ available: true, providers: [] }),
      () => skillsStateStub(),
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
  const dir = makeUserPresetDir('pt-overrides-big-')
  writeFileSync(join(dir, 'preset.yml'), 'id: beta\n', 'utf8')
  try {
    registerSettingsBridge(
      ctx,
      'prompt-tool',
      () => ({ available: true, providers: [] }),
      () => skillsStateStub(),
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
  const dir = makeUserPresetDir('pt-overrides-unknown-')
  writeFileSync(join(dir, 'preset.yml'), 'id: beta\n', 'utf8')
  try {
    registerSettingsBridge(
      ctx,
      'prompt-tool',
      () => ({ available: true, providers: [] }),
      () => skillsStateStub(),
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
  const dir = makeUserPresetDir('pt-overrides-invalid-')
  writeFileSync(join(dir, 'preset.yml'), 'id: beta\n', 'utf8')
  try {
    registerSettingsBridge(
      ctx,
      'prompt-tool',
      () => ({ available: true, providers: [] }),
      () => skillsStateStub(),
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

test('参数保存拒绝空工具阶段和非法深度，失败不写盘、不重建', async () => {
  const { ctx, handlers } = makeHarness()
  const dir = makeUserPresetDir('pt-param-validation-')
  const file = join(dir, 'preset.yml')
  const original = '# keep comment\nid: validation\nmodules: [tool-bootstrap]\nunknown: keep\n'
  writeFileSync(file, original, 'utf8')
  let rebuilds = 0
  registerSettingsBridge(ctx, 'prompt-tool', () => ({ available: true, providers: [] }),
    () => skillsStateStub(), () => '', undefined, () => dir,
    undefined, () => { rebuilds += 1 })
  const write = handlers.get(PREFIX + BRIDGE_ENDPOINTS.paramOverrides)
  for (const overrides of [
    { stages: [{ name: 'read', tools: [] }] },
    { stages: [{ name: 'read', tools: [''] }] },
    { maxDepth: 'invalid' }, { maxDepth: ' ' }, { maxDepth: '-1' }, { maxDepth: '1.5' },
  ]) {
    const res = fakeRes()
    await write(fakeReq({ [Symbol.asyncIterator]: async function* () {
      yield Buffer.from(JSON.stringify({ overrides }))
    } }), res)
    assert.equal(res.status, 400, JSON.stringify(overrides))
    assert.equal(JSON.parse(res.body).code, 'overrides-invalid-value')
    assert.equal(readFileSync(file, 'utf8'), original)
  }
  assert.equal(rebuilds, 0)
  for (const stages of [[{ name: 'read', tools: ['read'] }], []]) {
    const res = fakeRes()
    await write(fakeReq({ [Symbol.asyncIterator]: async function* () {
      yield Buffer.from(JSON.stringify({ overrides: { stages, maxDepth: '0' } }))
    } }), res)
    assert.equal(res.status, 200)
    const saved = parseYaml(readFileSync(file, 'utf8'))
    assert.deepEqual(saved.params.stages, stages.length > 0 ? stages : undefined)
    assert.equal(saved.params.maxDepth, '0')
    assert.equal(saved.unknown, 'keep')
  }
  assert.equal(rebuilds, 2)
  assert.match(readFileSync(file, 'utf8'), /# keep comment/)
})

test('模板变量与参数独立保存，读取与 bootstrap 不回退旧 params 内容键', async () => {
  const { ctx, handlers } = makeHarness()
  const dir = makeUserPresetDir('pt-variable-isolation-')
  const file = join(dir, 'preset.yml')
  const params = { usePtcMode: false, stagePreUnlock: 0, legacyOnly: '旧值', variables: { nested: '嵌套旧值' } }
  writeFileSync(file, `# keep comment\nid: variable-isolation\nparams: ${JSON.stringify(params)}\n`, 'utf8')
  registerSettingsBridge(ctx, 'prompt-tool', () => ({ available: true, providers: [] }),
    () => skillsStateStub(), () => '', undefined, () => dir)
  const write = handlers.get(PREFIX + BRIDGE_ENDPOINTS.presetVariables)
  for (const variables of [{ usePtcMode: 'text', stagePreUnlock: '' }, {}]) {
    const res = fakeRes()
    await write(fakeReq({ [Symbol.asyncIterator]: async function* () {
      yield Buffer.from(JSON.stringify({ variables }))
    } }), res)
    assert.equal(res.status, 200)
    const saved = parseYaml(readFileSync(file, 'utf8'))
    assert.deepEqual(saved.params, params)
    assert.deepEqual(saved.variables ?? {}, variables)
    assert.match(readFileSync(file, 'utf8'), /# keep comment/)
    const read = fakeRes()
    await write(fakeReq(), read)
    assert.equal(read.status, 200)
    assert.deepEqual(JSON.parse(read.body).value, { variables, enabled: true })
    const bootstrap = fakeRes()
    await handlers.get(PREFIX + BRIDGE_ENDPOINTS.bootstrap)(fakeReq(), bootstrap)
    assert.equal(bootstrap.status, 200)
    assert.deepEqual(JSON.parse(bootstrap.body).variables, { variables, enabled: true })
  }
  const before = readFileSync(file, 'utf8')
  const rejected = fakeRes()
  await handlers.get(PREFIX + BRIDGE_ENDPOINTS.paramOverrides)(fakeReq({ [Symbol.asyncIterator]: async function* () {
    yield Buffer.from(JSON.stringify({ overrides: { variables: { nested: '不支持' } } }))
  } }), rejected)
  assert.equal(rejected.status, 400)
  assert.equal(JSON.parse(rejected.body).code, 'overrides-unknown-key')
  assert.equal(readFileSync(file, 'utf8'), before)
})

test('预设列表、导出、复制、删除、新建与导入都作用于官方预设根', async () => {
  const { ctx, handlers } = makeHarness()
  const id = 'root-management'
  const activeDir = join(userPresetRoot, id)
  const presetContent = `id: ${id}\nname: custom\nmodules: []\n`
  mkdirSync(activeDir, { recursive: true })
  writeFileSync(join(activeDir, 'preset.yml'), presetContent, 'utf8')
  registerSettingsBridge(ctx, 'prompt-tool',
    () => ({ available: true, providers: [] }),
    () => skillsStateStub(),
    () => '', undefined, () => activeDir)
  const call = async (endpoint, payload = {}) => {
    const res = fakeRes()
    await handlers.get(PREFIX + BRIDGE_ENDPOINTS[endpoint])(fakeReq({ [Symbol.asyncIterator]: async function* () {
      yield Buffer.from(JSON.stringify(payload))
    } }), res)
    assert.equal(res.status, 200, res.body)
    return JSON.parse(res.body).value
  }
  const meta = await call('meta')
  assert.ok(meta.meta.presets.some(preset => preset.id === id), '预设列表应含官方预设根下的预设')
  const exported = await call('exportPreset', { id })
  assert.equal(exported.content, readFileSync(join(activeDir, 'preset.yml'), 'utf8'))
  const copied = await call('presetDuplicate', { id })
  assert.equal(readFileSync(join(userPresetRoot, copied.id, 'preset.yml'), 'utf8'), exported.content)
  await call('presetDelete', { id: copied.id })
  assert.equal(existsSync(join(userPresetRoot, copied.id)), false)
  const cloned = await call('presetClone', { id: 'custom' })
  assert.ok(existsSync(join(userPresetRoot, cloned.id, 'preset.yml')))
  const imported = await call('importPresetPackage', {
    files: [{ path: 'preset.yml', content: 'id: root-import\nmodules: []\n' }],
  })
  assert.ok(existsSync(join(userPresetRoot, imported.id, 'preset.yml')))
  assert.equal(readFileSync(join(activeDir, 'preset.yml'), 'utf8'), presetContent, '管理操作不得改动源预设')
})

test('settings bridge /configs-validate 接受 >64KB promptConfigs 载荷（不再 400 unreadable JSON body）', async () => {
  const { ctx, handlers } = makeHarness()
  registerSettingsBridge(
    ctx,
    'prompt-tool',
    () => ({ available: true, providers: [] }),
    () => skillsStateStub(),
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

test('settings bridge：非法 JSON 与错误写入结构返回 400 且不落盘', async () => {
  const dir = makeUserPresetDir('pt-invalid-body-')
  const presetFile = join(dir, 'preset.yml')
  const original = 'id: beta\nparams:\n  firstTurnAnchor: false\n'
  writeFileSync(presetFile, original, 'utf8')
  try {
    const { ctx, handlers } = makeHarness()
    registerSettingsBridge(ctx, 'prompt-tool',
      () => ({ available: true, providers: [] }),
      () => skillsStateStub(),
      () => '', undefined, () => dir)
    const cases = [
      ['畸形 JSON', BRIDGE_ENDPOINTS.paramOverrides, '{"overrides":'],
      ['非对象参数', BRIDGE_ENDPOINTS.paramOverrides, JSON.stringify({ overrides: [] })],
      ['保存端非数组提示词配置', BRIDGE_ENDPOINTS.paramOverrides, JSON.stringify({ promptConfigs: {} })],
      ['非法 rebuild', BRIDGE_ENDPOINTS.paramOverrides, JSON.stringify({ rebuild: 'bad' })],
      ['校验端非数组提示词配置', BRIDGE_ENDPOINTS.configsValidate, JSON.stringify({ promptConfigs: {} })],
      ['非法变量结构', BRIDGE_ENDPOINTS.presetVariables, JSON.stringify({ variables: { bad: 1 } })],
    ]
    for (const [label, endpoint, raw] of cases) {
      const handler = handlers.get(PREFIX + endpoint)
      assert.ok(handler, `${endpoint} 端点应注册`)
      const res = fakeRes()
      await handler(fakeReq({ [Symbol.asyncIterator]: async function* () { yield Buffer.from(raw) } }), res)
      assert.equal(res.status, 400, label)
      assert.equal(JSON.parse(res.body).ok, false, label)
      assert.equal(readFileSync(presetFile, 'utf8'), original, `${label} 不得落盘`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('settings bridge：system 预设拒绝全部当前预设写入', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pt-system-readonly-'))
  const presetFile = join(dir, 'preset.yml')
  const original = 'id: system\nmodules: []\n'
  writeFileSync(presetFile, original, 'utf8')
  try {
    const { ctx, handlers } = makeHarness()
    registerSettingsBridge(ctx, 'prompt-tool',
      () => ({ available: true, providers: [] }),
      () => skillsStateStub(),
      () => '', undefined, () => dir)
    const cases = [
      [BRIDGE_ENDPOINTS.paramOverrides, { overrides: { firstTurnAnchor: true } }],
      [BRIDGE_ENDPOINTS.paramOverrides, { promptConfigs: [] }],
      [BRIDGE_ENDPOINTS.presetVariables, { variables: { empty: '' }, enabled: true }],
      [BRIDGE_ENDPOINTS.importPreset, { contents: [{ scope: 'preset', content: 'changed' }] }],
      [BRIDGE_ENDPOINTS.customTools, { customTools: [] }],
      [BRIDGE_ENDPOINTS.charactersImport, { files: [{ path: 'card.json', content: '{}' }] }],
      [BRIDGE_ENDPOINTS.charactersImportStream, 'raw'],
      [BRIDGE_ENDPOINTS.charactersDelete, { id: 'card' }],
      [BRIDGE_ENDPOINTS.charactersApply, { id: 'card' }],
      [BRIDGE_ENDPOINTS.charactersRemove, { id: 'card' }],
      [BRIDGE_ENDPOINTS.subagentToolPolicy, { policy: null }],
      [BRIDGE_ENDPOINTS.engineCapability, { action: 'create', capabilityId: 'context-gate' }],
    ]
    for (const [endpoint, body] of cases) {
      const handler = handlers.get(PREFIX + endpoint)
      assert.ok(handler, `${endpoint} 端点应注册`)
      const res = fakeRes()
      await handler(fakeReq({ [Symbol.asyncIterator]: async function* () {
        yield Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
      } }), res)
      assert.equal(res.status, 403, endpoint)
      assert.equal(JSON.parse(res.body).code, 'preset-readonly', endpoint)
      assert.equal(readFileSync(presetFile, 'utf8'), original, `${endpoint} 不得修改 system 预设`)
      assert.deepEqual(readdirSync(dir), ['preset.yml'], `${endpoint} 不得创建 system 预设文件`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('settings bridge /param-overrides rebuild=false 只落盘不重建（预设切换免双重建）', async () => {
  const { ctx, handlers } = makeHarness()
  const dir = makeUserPresetDir('pt-overrides-no-rebuild-')
  writeFileSync(join(dir, 'preset.yml'), 'id: beta\n', 'utf8')
  let rebuildCount = 0
  try {
    registerSettingsBridge(
      ctx,
      'prompt-tool',
      () => ({ available: true, providers: [] }),
      () => skillsStateStub(),
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

test('settings bridge：JSON 端点限制 32 MiB，角色卡原始流限制 64 MiB', async () => {
  assert.equal(MAX_BRIDGE_BODY_BYTES, 32 * 1024 * 1024)
  assert.equal(MAX_CHARACTER_CARD_STREAM_BYTES, 64 * 1024 * 1024)
  const { ctx, handlers } = makeHarness()
  registerSettingsBridge(
    ctx,
    'prompt-tool',
    () => ({ available: true, providers: [] }),
    () => skillsStateStub(),
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

test('settings bridge：角色卡原始文件流接受 64 MiB 边界 PNG 并清理临时文件', async () => {
  const { ctx, handlers } = makeHarness()
  const root = makeUserPresetDir('pt-character-stream-')
  const activeDir = join(root, 'anchored')
  mkdirSync(activeDir, { recursive: true })
  try {
    registerSettingsBridge(
      ctx,
      'prompt-tool',
      () => ({ available: true, providers: [] }),
      () => skillsStateStub(),
      () => '',
      undefined,
      () => activeDir,
    )
    const handler = handlers.get(PREFIX + BRIDGE_ENDPOINTS.charactersImportStream)
    assert.ok(handler, '角色卡流式端点应注册')
    const png = makePngCharacterCard()
    const req = Readable.from([png, Buffer.alloc(MAX_CHARACTER_CARD_STREAM_BYTES - png.length)])
    req.method = 'POST'
    req.socket = { remoteAddress: '127.0.0.1' }
    req.headers = { host: 'localhost', 'x-file-name': encodeURIComponent('card.jpg') }
    const res = fakeRes()
    await handler(req, res)
    assert.equal(res.status, 200)
    const payload = JSON.parse(res.body)
    assert.equal(payload.ok, true)
    assert.equal(payload.value.receivedBytes, MAX_CHARACTER_CARD_STREAM_BYTES)
    const cardDir = join(root, '.characters', payload.value.id)
    assert.equal(statSync(join(cardDir, 'avatar.png')).size, MAX_CHARACTER_CARD_STREAM_BYTES)
    assert.equal(JSON.parse(readFileSync(join(cardDir, 'card.json'), 'utf8')).name, '流式测试卡')
    assert.deepEqual(readdirSync(root).filter((name) => name.startsWith('.characters-upload-')), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
test('settings bridge：角色卡流式导入超过 64 MiB 返回 413 并清理临时文件', async () => {
  const { ctx, handlers } = makeHarness()
  const root = makeUserPresetDir('pt-character-stream-limit-')
  const activeDir = join(root, 'anchored')
  mkdirSync(activeDir, { recursive: true })
  try {
    registerSettingsBridge(
      ctx,
      'prompt-tool',
      () => ({ available: true, providers: [] }),
      () => skillsStateStub(),
      () => '',
      undefined,
      () => activeDir,
    )
    const handler = handlers.get(PREFIX + BRIDGE_ENDPOINTS.charactersImportStream)
    assert.ok(handler, '角色卡流式端点应注册')
    const chunk = Buffer.alloc(1024 * 1024, 0x78)
    const req = Readable.from((async function* () {
      for (let index = 0; index < 65; index += 1) yield chunk
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
    assert.match(payload.message, /64MB/)
    assert.deepEqual(readdirSync(root).filter((name) => name.startsWith('.characters-upload-')), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('settings bridge Origin 完整校验 scheme/host/port（端口不匹配拒绝）', async () => {
  const { ctx, handlers } = makeHarness()
  registerSettingsBridge(ctx, () => ({ available: true, providers: [] }), () => skillsStateStub(), () => '')
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
  const dir = makeUserPresetDir('pt-custom-tools-modules-')
  try {
    writeFileSync(join(dir, 'preset.yml'), ['id: beta', 'modules: []', ''].join(String.fromCharCode(10)), 'utf8')
    const { ctx, handlers } = makeHarness()
    registerSettingsBridge(ctx, 'prompt-tool',
      () => ({ available: true, providers: [] }),
      () => skillsStateStub(),
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
      { id: 'shell', description: '运行命令', output: { schema: { type: 'string' } }, execute: { kind: 'shell', command: 'echo' } },
      { id: 'world', description: '写入世界书', output: { schema: { type: 'json' } }, execute: { kind: 'delegate', tool: 'world_book_upsert' } },
    ] }))
    const res = fakeRes()
    await handler(fakeReq({ [Symbol.asyncIterator]: async function* () { yield payload } }), res)
    assert.equal(res.status, 200)
    const parsed = parseYaml(readFileSync(join(dir, 'preset.yml'), 'utf8'))
    assert.deepEqual(parsed.modules, ['tool-config-engine', 'world-book-tools'], '只装配自定义工具实际依赖的模块')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('settings bridge /custom-tools 拒绝缺少 modules 的预设', async () => {
  const dir = makeUserPresetDir('pt-custom-tools-no-modules-')
  try {
    writeFileSync(join(dir, 'preset.yml'), 'id: plain' + String.fromCharCode(10), 'utf8')
    const { ctx, handlers } = makeHarness()
    registerSettingsBridge(ctx, 'prompt-tool',
      () => ({ available: true, providers: [] }),
      () => skillsStateStub(),
      () => '',
      undefined,
      () => dir,
      undefined,
      undefined,
      () => {},
    )
    const handler = handlers.get(PREFIX + BRIDGE_ENDPOINTS.customTools)
    const payload = Buffer.from(JSON.stringify({ customTools: [{ id: 'shell', description: '运行命令', output: { schema: { type: 'string' } }, execute: { kind: 'shell', command: 'echo' } }] }))
    const res = fakeRes()
    await handler(fakeReq({ [Symbol.asyncIterator]: async function* () { yield payload } }), res)
    assert.equal(res.status, 409)
    assert.doesNotMatch(readFileSync(join(dir, 'preset.yml'), 'utf8'), /customTools|modules:/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('settings bridge /engine-capability 删除显式能力并只重建一次', async () => {
  const presetRoot = join(bridgeHome, '.agent-presets')
  mkdirSync(presetRoot, { recursive: true })
  const dir = mkdtempSync(join(presetRoot, 'pt-engine-capability-bridge-'))
  try {
    writeFileSync(join(dir, 'preset.yml'), 'id: beta\nname: beta\nversion: "1"\nengineCompat: ">=0"\nmodules: [context-gate, tool-filter]\n', 'utf8')
    const { ctx, handlers } = makeHarness()
    let rebuilds = 0
    registerSettingsBridge(ctx, 'prompt-tool',
      () => ({ available: true, providers: [] }),
      () => skillsStateStub(),
      () => '',
      undefined,
      () => dir,
      undefined,
      undefined,
      undefined,
      () => { rebuilds += 1 },
    )
    const handler = handlers.get(PREFIX + BRIDGE_ENDPOINTS.engineCapability)
    const request = Buffer.from(JSON.stringify({ action: 'remove', capabilityId: 'tool-filter' }))
    const res = fakeRes()
    await handler(fakeReq({ [Symbol.asyncIterator]: async function* () { yield request } }), res)
    assert.equal(res.status, 200)
    assert.deepEqual(JSON.parse(res.body).value.removedModules, ['tool-filter'])
    assert.deepEqual(parseYaml(readFileSync(join(dir, 'preset.yml'), 'utf8')).modules, ['context-gate'])
    assert.equal(rebuilds, 1)

    const again = fakeRes()
    await handler(fakeReq({ [Symbol.asyncIterator]: async function* () { yield request } }), again)
    assert.equal(JSON.parse(again.body).value.changed, false)
    assert.equal(rebuilds, 1, '幂等删除不重复重建')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('自定义工具完整校验失败不写盘、不重建，合法工具只重建一次', async () => {
  const dir = makeUserPresetDir('pt-custom-tool-validation-')
  const file = join(dir, 'preset.yml')
  const original = '# 用户注释\nid: beta\nmodules: []\nunknown: keep\n'
  writeFileSync(file, original, 'utf8')
  const { ctx, handlers } = makeHarness()
  let rebuilds = 0
  registerSettingsBridge(ctx, 'prompt-tool', () => ({ available: true, providers: [] }),
    () => skillsStateStub(), () => '', undefined, () => dir,
    undefined, () => { rebuilds += 1 })
  const handler = handlers.get(PREFIX + BRIDGE_ENDPOINTS.customTools)
  const valid = { id: 'read_asset', description: '读取工作区文件', parameters: { path: { type: 'string', required: true } },
    output: { schema: { type: 'json' } }, execute: { kind: 'fs', action: 'read', path: '{{args.path}}' } }
  try {
    for (const tool of [
      { ...valid, description: '' }, { ...valid, enabled: 'on' },
      { ...valid, execute: { kind: 'shell' } }, { ...valid, execute: { kind: 'external-plugin' } },
      { ...valid, output: { schema: { type: 'invalid' } } },
    ]) {
      const body = Buffer.from(JSON.stringify({ customTools: [tool] }))
      const res = fakeRes()
      await handler(fakeReq({ [Symbol.asyncIterator]: async function* () { yield body } }), res)
      assert.equal(res.status, 400)
      assert.equal(JSON.parse(res.body).code, 'custom-tools-invalid')
      assert.equal(readFileSync(file, 'utf8'), original)
      assert.equal(rebuilds, 0)
    }
    const body = Buffer.from(JSON.stringify({ customTools: [valid] }))
    const res = fakeRes()
    await handler(fakeReq({ [Symbol.asyncIterator]: async function* () { yield body } }), res)
    assert.equal(res.status, 200)
    assert.equal(rebuilds, 1)
    const spec = parseYaml(readFileSync(file, 'utf8'))
    assert.deepEqual(spec.customTools, [valid], '只保存原始 DSL，不写回编译产物')
    assert.ok(spec.modules.includes('tool-config-engine'))
    assert.equal(spec.unknown, 'keep')
    assert.match(readFileSync(file, 'utf8'), /# 用户注释/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('预设身份拦截跨预设旧请求及请求体读取期间的切换，任何通道都不串写', async () => {
  const a = makeUserPresetDir('pt-identity-a-')
  const b = makeUserPresetDir('pt-identity-b-')
  for (const dir of [a, b]) writeFileSync(join(dir, 'preset.yml'), 'id: test\nmodules: []\n', 'utf8')
  const original = readFileSync(join(b, 'preset.yml'), 'utf8')
  let active = b
  let rebuilds = 0
  const { ctx, handlers } = makeHarness()
  registerSettingsBridge(ctx, 'prompt-tool', () => ({ available: true, providers: [] }),
    () => skillsStateStub(), () => '', undefined, () => active,
    () => { rebuilds += 1 }, () => { rebuilds += 1 }, undefined, () => { rebuilds += 1 })
  const requests = [
    ['paramOverrides', { overrides: { bootstrapSubagents: true } }],
    ['paramOverrides', { promptConfigs: [] }],
    ['customTools', { customTools: [] }],
    ['subagentToolPolicy', { policy: null }],
    ['presetVariables', { variables: {} }],
    ['engineCapability', { action: 'create', capabilityId: 'tool-bootstrap' }],
    ['importPreset', { contents: [{ scope: 'preset', content: '旧文本' }] }],
  ]
  try {
    for (const [endpoint, payload] of requests) {
      const body = Buffer.from(JSON.stringify({ ...payload, expectedPresetId: a.split(/[\\/]/).at(-1) }))
      const res = fakeRes()
      await handlers.get(PREFIX + BRIDGE_ENDPOINTS[endpoint])(fakeReq({ [Symbol.asyncIterator]: async function* () { yield body } }), res)
      assert.equal(res.status, 409, endpoint)
      assert.equal(JSON.parse(res.body).code, 'preset-changed')
    }
    active = a
    const handler = handlers.get(PREFIX + BRIDGE_ENDPOINTS.paramOverrides)
    const res = fakeRes()
    await handler(fakeReq({ [Symbol.asyncIterator]: async function* () {
      active = b
      yield Buffer.from(JSON.stringify({ overrides: { bootstrapSubagents: true } }))
    } }), res)
    assert.equal(res.status, 409, '兼容旧客户端无ID请求也拦截读取期间切换')
    assert.equal(rebuilds, 0)
    assert.equal(readFileSync(join(b, 'preset.yml'), 'utf8'), original)
    assert.equal(existsSync(join(b, 'preset.md')), false)
    const invalid = fakeRes()
    await handler(fakeReq({ [Symbol.asyncIterator]: async function* () {
      yield Buffer.from(JSON.stringify({ overrides: {}, expectedPresetId: 1 }))
    } }), invalid)
    assert.equal(invalid.status, 400)
  } finally { for (const dir of [a, b]) rmSync(dir, { recursive: true, force: true }) }
})

test('公开晋升信号与门控开关冲突在落盘前拒绝，保留旧参数', async () => {
  const dir = makeUserPresetDir('pt-gate-conflict-')
  const file = join(dir, 'preset.yml')
  const original = 'id: test\nmodules: [tool-bootstrap]\nmoduleConfigs:\n  tool-bootstrap:\n    promoteOn: tool-call\n'
  writeFileSync(file, original, 'utf8')
  const { ctx, handlers } = makeHarness()
  registerSettingsBridge(ctx, 'prompt-tool', () => ({ available: true, providers: [] }),
    () => skillsStateStub(), () => '', undefined, () => dir)
  const handler = handlers.get(PREFIX + BRIDGE_ENDPOINTS.paramOverrides)
  try {
    const res = fakeRes()
    await handler(fakeReq({ [Symbol.asyncIterator]: async function* () {
      yield Buffer.from(JSON.stringify({ overrides: { promoteGate: true } }))
    } }), res)
    assert.equal(res.status, 400)
    assert.equal(JSON.parse(res.body).code, 'overrides-invalid-value')
    assert.equal(readFileSync(file, 'utf8'), original)
    const valid = fakeRes()
    await handler(fakeReq({ [Symbol.asyncIterator]: async function* () {
      yield Buffer.from(JSON.stringify({ overrides: { promoteGate: true, bootstrapPromoteOn: 'either' } }))
    } }), valid)
    assert.equal(valid.status, 200)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('settings bridge /subagent-tool-policy 保存、停用与模块装配均为原子操作', async () => {
  const dir = makeUserPresetDir('pt-subagent-policy-')
  try {
    writeFileSync(join(dir, 'preset.yml'), 'id: beta\nmodules: []\nunknown: keep\n', 'utf8')
    const { ctx, handlers } = makeHarness()
    let rebuilds = 0
    registerSettingsBridge(ctx, 'prompt-tool', () => ({ available: true, providers: [] }),
      () => skillsStateStub(), () => '', undefined, () => dir,
      undefined, () => { rebuilds += 1 })
    const handler = handlers.get(PREFIX + BRIDGE_ENDPOINTS.subagentToolPolicy)
    const policy = {
      defaultProfile: 'base', ceiling: { allow: ['read'], deny: [] },
      profiles: [{ id: 'base', name: '基础', allow: ['read'], deny: [], modelSelectable: false }],
      characterBindings: [], taskRules: [],
      modelExpansion: { enabled: false, allow: [], maxAdditionalTools: 0, requireApproval: true },
    }
    const save = fakeRes()
    await handler(fakeReq({ [Symbol.asyncIterator]: async function* () { yield Buffer.from(JSON.stringify({ policy })) } }), save)
    assert.equal(save.status, 200)
    let parsed = parseYaml(readFileSync(join(dir, 'preset.yml'), 'utf8'))
    assert.deepEqual(parsed.subagentToolPolicy, policy)
    assert.deepEqual(parsed.modules, ['subagent-tool-policy'], '空白预设只装配子代理策略模块')
    assert.equal(parsed.unknown, 'keep')
    const disable = fakeRes()
    await handler(fakeReq({ [Symbol.asyncIterator]: async function* () { yield Buffer.from(JSON.stringify({ policy: null })) } }), disable)
    assert.equal(disable.status, 200)
    parsed = parseYaml(readFileSync(join(dir, 'preset.yml'), 'utf8'))
    assert.equal(parsed.subagentToolPolicy, undefined)
    assert.ok(parsed.modules.includes('subagent-tool-policy'), '关闭开关只删策略段，模块声明保留（能力卡可再次打开）')
    assert.equal(parsed.unknown, 'keep')
    assert.equal(rebuilds, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('settings bridge /persona 读写顶层 persona 段（官方 dsh-persona config 同构）并重建', async () => {
  const { ctx, handlers } = makeHarness()
  const dir = makeUserPresetDir('pt-persona-')
  writeFileSync(join(dir, 'preset.yml'), 'id: beta\nname: beta\nunknown: keep\n', 'utf8')
  let rebuilds = 0
  try {
    registerSettingsBridge(ctx, 'prompt-tool',
      () => ({ available: true, providers: [] }),
      () => skillsStateStub(),
      () => '',
      undefined,
      () => dir,
      undefined,
      () => { rebuilds += 1 },
    )
    const handler = handlers.get(PREFIX + BRIDGE_ENDPOINTS.persona)
    assert.ok(handler, '/persona 端点应注册')
    const write = fakeRes()
    await handler(fakeReq({ [Symbol.asyncIterator]: async function* () {
      yield Buffer.from(JSON.stringify({ persona: { prefix: 'PREFIX', suffix: 'SUFFIX', complete: true, includeRuntimeContext: false } }))
    } }), write)
    assert.equal(write.status, 200)
    const written = parseYaml(readFileSync(join(dir, 'preset.yml'), 'utf8'))
    assert.deepEqual(written.persona, { prefix: 'PREFIX', suffix: 'SUFFIX', complete: true, includeRuntimeContext: false })
    assert.equal(written.unknown, 'keep', '未知字段保留')
    assert.equal(rebuilds, 1, '写盘后触发重建')
    // 无 persona 载荷 = 读取。
    const read = fakeRes()
    await handler(fakeReq(), read)
    assert.equal(read.status, 200)
    assert.deepEqual(JSON.parse(read.body).value.persona, { prefix: 'PREFIX', suffix: 'SUFFIX', complete: true, includeRuntimeContext: false })
    // persona: null = 移除顶层段。
    const remove = fakeRes()
    await handler(fakeReq({ [Symbol.asyncIterator]: async function* () {
      yield Buffer.from(JSON.stringify({ persona: null }))
    } }), remove)
    assert.equal(remove.status, 200)
    assert.equal(parseYaml(readFileSync(join(dir, 'preset.yml'), 'utf8')).persona, undefined)
    assert.equal(rebuilds, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('settings bridge /persona 非法载荷 400，complete 与提示词配置「独占」双向互斥', async () => {
  const { ctx, handlers } = makeHarness()
  const dir = makeUserPresetDir('pt-persona-guard-')
  try {
    const register = (root) => registerSettingsBridge(ctx, 'prompt-tool',
      () => ({ available: true, providers: [] }),
      () => skillsStateStub(),
      () => '',
      undefined,
      () => root,
      undefined,
      () => {},
    )
    // 非法载荷：缺 required prefix。
    writeFileSync(join(dir, 'preset.yml'), 'id: beta\n', 'utf8')
    register(dir)
    const handler = handlers.get(PREFIX + BRIDGE_ENDPOINTS.persona)
    const invalid = fakeRes()
    await handler(fakeReq({ [Symbol.asyncIterator]: async function* () {
      yield Buffer.from(JSON.stringify({ persona: { suffix: 'x' } }))
    } }), invalid)
    assert.equal(invalid.status, 400)
    assert.equal(JSON.parse(invalid.body).code, 'preset-persona-invalid')
    assert.equal(parseYaml(readFileSync(join(dir, 'preset.yml'), 'utf8')).persona, undefined, '非法载荷不得写盘')
    // 方向一：顶层 persona 已独占 → 保存带 complete 的提示词配置被拒。
    writeFileSync(join(dir, 'preset.yml'), 'id: beta\npersona:\n  prefix: P\n  complete: true\n', 'utf8')
    const overrides = handlers.get(PREFIX + BRIDGE_ENDPOINTS.paramOverrides)
    const conflict = fakeRes()
    await overrides(fakeReq({ [Symbol.asyncIterator]: async function* () {
      yield Buffer.from(JSON.stringify({ promptConfigs: [{ id: 'exclusive', enabled: true, params: { complete: true } }] }))
    } }), conflict)
    assert.equal(conflict.status, 400)
    assert.equal(JSON.parse(conflict.body).code, 'overrides-invalid-value')
    // 方向二：提示词配置已独占 → 保存 complete 顶层人设被拒。
    writeFileSync(join(dir, 'preset.yml'), [
      'id: beta',
      'promptConfigs:',
      '  - id: exclusive',
      '    layer: system-section',
      '    strategy: static',
      '    params:',
      '      sectionName: deployment:persona-prefix',
      '      complete: true',
      '',
    ].join('\n'), 'utf8')
    const personaConflict = fakeRes()
    await handler(fakeReq({ [Symbol.asyncIterator]: async function* () {
      yield Buffer.from(JSON.stringify({ persona: { prefix: 'P', complete: true } }))
    } }), personaConflict)
    assert.equal(personaConflict.status, 400)
    assert.equal(JSON.parse(personaConflict.body).code, 'preset-persona-complete-conflict')
    assert.equal(parseYaml(readFileSync(join(dir, 'preset.yml'), 'utf8')).persona, undefined, '冲突不得写盘')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** 用户技能根（技能实体的落点）：创建、复制导入与回收站都落在这里。 */
function makeSkillsRoot() {
  return mkdtempSync(join(tmpdir(), `pt-skills-root-${process.pid}-`))
}

function skillsPost(handlers, endpoint) {
  return async (payload) => {
    const res = fakeRes()
    await handlers.get(PREFIX + BRIDGE_ENDPOINTS[endpoint])(fakeReq({
      [Symbol.asyncIterator]: async function* () { yield Buffer.from(JSON.stringify(payload)) },
    }), res)
    return { status: res.status, body: JSON.parse(res.body) }
  }
}

test('settings bridge 技能端点：创建 → 注册层屏蔽 → 恢复 → 回收站删除都落在用户技能根', async () => {
  const root = makeSkillsRoot()
  const stateFile = join(root, '.system', 'prompt-tool', 'skills.yml')
  let refreshes = 0
  try {
    const { ctx, handlers } = makeHarness()
    // 屏蔽开关用真实状态读写（写盘幂等与恢复靠文件事实断言，不用替身假装成功）。
    const setSkillBlocked = (name, scope) => {
      const current = readSkillsState(stateFile).state
      const rest = current.blocked.filter((item) => item.name !== name)
      return writeSkillsState({
        blocked: scope === 'none' ? rest : [...rest, blockRecordFor(name, scope, new Date().toISOString())],
      }, stateFile)
    }
    registerSettingsBridge(ctx, 'prompt-tool', () => ({ available: true, providers: [] }),
      () => skillsStateStub({ skillsRoot: root, setSkillBlocked }), () => '', () => { refreshes += 1 })
    const postCreate = skillsPost(handlers, 'skillCreate')
    const postBlock = skillsPost(handlers, 'skillBlock')
    const postDelete = skillsPost(handlers, 'skillDelete')
    const blockedNames = () => readSkillsState(stateFile).state.blocked.map((item) => item.name)

    const created = await postCreate({ name: 'demo-skill', description: 'Demo', content: '# demo\n' })
    assert.equal(created.status, 200, created.body.message)
    assert.equal(created.body.value.id, 'demo-skill')
    const marker = join(root, 'demo-skill', 'SKILL.md')
    const body = readFileSync(marker, 'utf8')
    assert.match(body, /name: demo-skill/)
    // 技能实体是用户根里的普通目录：不建 .system 实体库、不建链接。
    assert.equal(lstatSync(join(root, 'demo-skill')).isSymbolicLink(), false)
    // 非法创建：名称不是 kebab-case / 超限正文都先于任何写盘拒绝。
    assert.equal((await postCreate({ name: 'Bad Name', description: 'x', content: '' })).status, 400)
    assert.equal((await postCreate({ name: 'other-skill', description: 'x', content: 'y'.repeat(1024 * 1024 + 1) })).status, 400)
    assert.equal(existsSync(join(root, 'other-skill')), false)
    assert.equal(refreshes, 1, '创建触发一次技能刷新')

    // 屏蔽 = 注册层影子候选：只写插件状态，一个字节的技能文件都不改。
    const blocked = await postBlock({ name: 'demo-skill', scope: 'all' })
    assert.equal(blocked.status, 200, blocked.body.message)
    assert.deepEqual(blocked.body.value.blocked, ['demo-skill'])
    assert.equal(readFileSync(marker, 'utf8'), body, '屏蔽不改任何技能文件')
    assert.deepEqual(blockedNames(), ['demo-skill'])
    // 幂等：重复屏蔽同一技能不产生重复记录。
    const again = await postBlock({ name: 'demo-skill', scope: 'all' })
    assert.equal(again.status, 200, again.body.message)
    assert.deepEqual(again.body.value.blocked, ['demo-skill'])
    assert.deepEqual(blockedNames(), ['demo-skill'])
    // 两端独立：只屏蔽模型端时记录显式写 user: false，用户端仍然可调用。
    const modelOnly = await postBlock({ name: 'demo-skill', scope: 'model' })
    assert.equal(modelOnly.status, 200, modelOnly.body.message)
    assert.deepEqual(readSkillsState(stateFile).state.blocked, [{ name: 'demo-skill', at: readSkillsState(stateFile).state.blocked[0].at, user: false }])
    assert.equal(readFileSync(marker, 'utf8'), body)
    // 反向：只屏蔽用户端时写 model: false。
    const userOnly = await postBlock({ name: 'demo-skill', scope: 'user' })
    assert.equal(userOnly.status, 200, userOnly.body.message)
    assert.equal(readSkillsState(stateFile).state.blocked[0].model, false)
    assert.equal(readSkillsState(stateFile).state.blocked[0].user, undefined)
    // 非法载荷先于写盘拒绝：非法技能名、缺失 scope、非法取值。
    assert.equal((await postBlock({ name: 'Bad Name', scope: 'all' })).status, 409)
    assert.equal((await postBlock({ name: 'demo-skill' })).status, 400)
    assert.equal((await postBlock({ name: 'demo-skill', scope: 'yes' })).status, 400)
    assert.equal(readSkillsState(stateFile).state.blocked.length, 1)

    // 恢复：删除屏蔽记录，官方候选立刻回到胜出位置。
    const restored = await postBlock({ name: 'demo-skill', scope: 'none' })
    assert.equal(restored.status, 200, restored.body.message)
    assert.deepEqual(restored.body.value.blocked, [])
    assert.deepEqual(blockedNames(), [])
    assert.equal(readFileSync(marker, 'utf8'), body)
    assert.equal(refreshes, 6, '创建 / 屏蔽 / 重复屏蔽 / 只屏蔽模型 / 只屏蔽用户 / 恢复各触发一次技能刷新')

    // 回收站删除：整个技能目录移入用户根下的 .system/prompt-tool/.trash。
    const removed = await postDelete({ folder: 'demo-skill' })
    assert.equal(removed.status, 200, removed.body.message)
    assert.equal(existsSync(marker), false)
    const trash = readdirSync(join(root, '.system', 'prompt-tool', '.trash'))
    assert.equal(trash.length, 1)
    assert.equal(existsSync(join(root, '.system', 'prompt-tool', '.trash', trash[0], 'demo-skill', 'SKILL.md')), true, '技能目录可人工恢复')
    assert.equal((await postDelete({ folder: '../escape' })).status, 400)
    assert.equal((await postDelete({ folder: 'missing-skill' })).status, 400)
    assert.equal(refreshes, 7, '回收站删除再触发一次刷新')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('settings bridge /skills-import-directory 把宿主机目录复制进用户技能根', async () => {
  const root = makeSkillsRoot()
  const workspace = mkdtempSync(join(tmpdir(), 'pt-skills-source-'))
  // 来源目录名必须是合法技能目录名（kebab-case）：显式取一个稳定名字，不依赖 mkdtemp 的随机后缀。
  const source = join(workspace, 'skill-package')
  mkdirSync(source)
  try {
    writeFileSync(join(source, 'SKILL.md'), '---\nname: imported\ndescription: imported skill\nuser-invocable: false\n---\nbody\n', 'utf8')
    mkdirSync(join(source, 'references'))
    writeFileSync(join(source, 'references', 'doc.md'), 'doc', 'utf8')
    const { ctx, handlers } = makeHarness()
    registerSettingsBridge(ctx, 'prompt-tool', () => ({ available: true, providers: [] }),
      () => skillsStateStub({ skillsRoot: root }), () => '')
    const post = skillsPost(handlers, 'skillsImportDirectory')
    const result = await post({ path: source })
    assert.equal(result.status, 200, result.body.message)
    const name = source.split(/[\\/]/).at(-1)
    assert.equal(result.body.value.count, 2)
    assert.equal(result.body.value.path, root)
    assert.equal(readFileSync(join(root, name, 'references', 'doc.md'), 'utf8'), 'doc', '资源随技能包一起复制')
    assert.equal(existsSync(join(source, 'references', 'doc.md')), true, '复制导入不改动来源目录')
    assert.equal(existsSync(join(root, '.system')), false, '复制导入不落受管实体库')
    assert.equal(lstatSync(join(root, name)).isSymbolicLink(), false, '技能实体是普通目录，不是根链接')
    assert.equal((await post({ path: join(root, 'missing-dir') })).status, 400)
    // 空路径与相对路径必须在入口被拒绝：空串若落到 resolve 会退化成进程工作目录，
    // 把整个 cwd 当成技能导入（曾实测复制成功）。断言不能依赖 cwd 的名字恰好不是 kebab-case。
    for (const [label, payload, reason] of [
      ['空串', '', /路径为空/u],
      ['纯空白', '   ', /路径为空/u],
      ['相对路径', 'relative-skill-dir', /绝对路径/u],
      ['非字符串', 42, /路径为空/u],
    ]) {
      const rejected = await post({ path: payload })
      assert.equal(rejected.status, 400, `${label}必须被拒绝`)
      assert.match(rejected.body.message, reason, `${label}的拒绝理由`)
    }
    assert.deepEqual(readdirSync(root), [name], '被拒绝的导入不向用户技能根写入任何内容')
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('settings bridge /skills-folders 只登记引用路径，不复制也不改动引用目录', async () => {
  const root = makeSkillsRoot()
  const referenced = mkdtempSync(join(tmpdir(), 'pt-skills-referenced-'))
  const stateFile = join(root, '.system', 'prompt-tool', 'skills.yml')
  try {
    mkdirSync(join(referenced, 'ref-skill'), { recursive: true })
    writeFileSync(join(referenced, 'ref-skill', 'SKILL.md'), '---\nname: ref-skill\ndescription: ref\n---\nbody\n', 'utf8')
    const before = readFileSync(join(referenced, 'ref-skill', 'SKILL.md'), 'utf8')
    const { ctx, handlers } = makeHarness()
    // 引用目录进入扫描来源（custom 优先级 300），与状态文件同源。
    const listSkills = (cwd) => catalogFromScan(scanRoots(skillRoots({
      cwd,
      dshHome: root,
      folders: readSkillsState(stateFile).state.folders,
    })), new Map(readSkillsState(stateFile).state.blocked.map((item) => [item.name, blockScopeOf(item)])))
    registerSettingsBridge(ctx, 'prompt-tool', () => ({ available: true, providers: [] }),
      () => skillsStateStub({
        skillsRoot: root,
        listSkills,
        patchSkillFolders: (folders) => writeSkillsState({ folders }, stateFile),
      }), () => '')
    const post = skillsPost(handlers, 'skillsFolders')
    const namesOf = (payload) => payload.value.skills.map((skill) => skill.name).sort()

    const added = await post({ folders: [referenced] })
    assert.equal(added.status, 200, added.body.message)
    assert.deepEqual(added.body.value.folders, [referenced])
    assert.deepEqual(readSkillsState(stateFile).state.folders, [referenced])
    assert.deepEqual(namesOf(added.body), ['ref-skill'], '引用目录里的技能按自定义来源进入清单')
    assert.equal(existsSync(join(root, 'ref-skill')), false, '引用只登记路径，不复制任何文件')
    assert.equal(readFileSync(join(referenced, 'ref-skill', 'SKILL.md'), 'utf8'), before, '引用不改动源目录内容')

    // 非法载荷与重复登记先于任何写盘拒绝，状态文件保持原样。
    assert.equal((await post({ folders: 'D:/elsewhere' })).status, 400)
    assert.equal((await post({ folders: [42] })).status, 400)
    assert.equal((await post({ folders: [referenced, referenced] })).status, 409)
    assert.deepEqual(readSkillsState(stateFile).state.folders, [referenced])

    // 移除引用只删记录，源目录与其中的技能文件不受影响。
    const removed = await post({ folders: [] })
    assert.equal(removed.status, 200, removed.body.message)
    assert.deepEqual(removed.body.value.folders, [])
    assert.deepEqual(namesOf(removed.body), [], '移除引用后不再扫描该目录')
    assert.deepEqual(readSkillsState(stateFile).state.folders, [])
    assert.equal(existsSync(join(referenced, 'ref-skill', 'SKILL.md')), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(referenced, { recursive: true, force: true })
  }
})
