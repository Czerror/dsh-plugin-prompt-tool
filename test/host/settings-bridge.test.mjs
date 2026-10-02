import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'

const bridgeHome = mkdtempSync(join(tmpdir(), 'pt-settings-bridge-home-'))
process.env.DSH_HOME = bridgeHome
// 技能扫描的其余来源一并隔离：不读到真实用户目录 / 真实内置技能目录。
process.env.DSH_AGENTS_HOME = join(bridgeHome, 'agents')
process.env.DSH_BUNDLED_SKILL_DIR = join(bridgeHome, 'bundled-skills')
const {
  BRIDGE_ENDPOINTS, MAX_BRIDGE_BODY_BYTES, MAX_CHARACTER_CARD_STREAM_BYTES, registerSettingsBridge,
  catalogFromScan, readSkillInvocation, readSkillsState, scanRoots, setSkillInvocation, skillRoots, writeSkillsState,
} = await import('../../src/index.ts')
const { deleteSkillTarget } = await import('../../src/host/skills-actions.ts')
after(() => {
  rmSync(bridgeHome, { recursive: true, force: true })
  delete process.env.DSH_HOME
  delete process.env.DSH_AGENTS_HOME
  delete process.env.DSH_BUNDLED_SKILL_DIR
})

/** 文件层调用策略模型的技能状态替身：技能实体留在官方技能根，插件只提供引用目录与清单。 */
function skillsStateStub(overrides = {}) {
  const state = { version: 4, folders: [] }
  const result = {
    skillsRoot: join(bridgeHome, 'skills'),
    folders: [],
    listSkills: () => [],
    setSkillPolicy: () => ({ ok: true, changed: true, invocation: { modelInvocable: false, userInvocable: false } }),
    patchSkillFolders: () => ({ ok: true, state, exists: true }),
    ...overrides,
  }
  result.deleteSkill ??= (name, path, cwd) => {
    if (!result.listSkills(cwd).some((entry) => entry.name === name && entry.path === path)) return { ok: false, message: '技能已变化' }
    return deleteSkillTarget([result.skillsRoot, ...result.folders], path)
  }
  return result
}

const PREFIX = '/api/prompt-tool/settings'
const userPresetRoot = join(bridgeHome, '.prompt-tool', 'modules')

let presetSequence = 0
function makeUserPresetDir(prefix) {
  mkdirSync(userPresetRoot, { recursive: true })
  const dir = join(userPresetRoot, `${prefix}${++presetSequence}`)
  mkdirSync(dir)
  return dir
}

function makeHarness(services = {}) {
  const handlers = new Map()
  const sctx = {
    get: (name) => services[name],
    settings: {
      describe: () => [
        { ns: 'prompt-tool', value: { promptText: 'P' }, base: {} },
        { ns: 'agent-default-model', value: { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high' } },
      ],
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
    assert.equal(readFileSync(join(dir, 'demo', 'SKILL.md'), 'utf8'), '---\nname: demo\ndescription: demo\n---\n')
    assert.equal(existsSync(join(dir, '.system')), false, '导入不落受管实体库')
    assert.equal(refreshes, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('两个技能导入端点先报告冲突，确认名单才能覆盖，非法确认零写入', async () => {
  const dir = mkdtempSync(join(bridgeHome, 'overwrite-'))
  const source = join(dir, 'drop', 'demo')
  const root = join(dir, 'skills')
  mkdirSync(source, { recursive: true })
  const marker = (body) => `---\nname: demo\ndescription: demo\n---\n${body}\n`
  writeFileSync(join(source, 'SKILL.md'), marker('new'))
  const { ctx, handlers } = makeHarness()
  let refreshes = 0
  registerSettingsBridge(ctx, 'prompt-tool', () => ({ available: false, providers: [] }),
    () => skillsStateStub({ skillsRoot: root }), () => '', () => { refreshes += 1 })
  for (const [endpoint, body] of [
    ['skillsImport', { files: [{ path: 'demo/SKILL.md', content: Buffer.from(marker('new')).toString('base64') }] }],
    ['skillsImportDirectory', { path: source }],
  ]) {
    mkdirSync(join(root, 'demo'), { recursive: true })
    const target = join(root, 'demo', 'SKILL.md')
    writeFileSync(target, marker('old'))
    const call = async (extra = {}) => {
      const res = fakeRes()
      await handlers.get(PREFIX + BRIDGE_ENDPOINTS[endpoint])(fakeReq({
        async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ ...body, ...extra })) },
      }), res)
      return { status: res.status, body: JSON.parse(res.body) }
    }
    const before = refreshes
    const waiting = await call()
    assert.equal(waiting.status, 409)
    assert.equal(waiting.body.code, 'skills-overwrite-required')
    assert.deepEqual(waiting.body.conflicts, ['demo'])
    assert.equal(readFileSync(target, 'utf8'), marker('old'))
    assert.equal(refreshes, before)
    for (const overwrite of [true, null, 'demo', ['../demo'], [42]]) {
      assert.equal((await call({ overwrite })).status, 400)
      assert.equal(readFileSync(target, 'utf8'), marker('old'))
    }
    assert.equal((await call({ overwrite: ['different'] })).status, 409)
    const saved = await call({ overwrite: ['demo'] })
    assert.equal(saved.status, 200, JSON.stringify(saved.body))
    assert.equal(saved.body.value.overwritten, 1)
    assert.equal(readFileSync(target, 'utf8'), marker('new'))
    assert.deepEqual(readdirSync(root), ['demo'], '成功覆盖不保存历史目录')
    assert.equal(refreshes, before + 1)
  }
})

test('settings bridge /import-preset 只接受 contents，批量写入后触发一次回调；/preset-content 读回', async () => {
  const { ctx, handlers } = makeHarness()
  let importedScopes
  let imports = 0
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
      (scopes) => { importedScopes = scopes; imports += 1 },
    )
    const write = handlers.get(`${PREFIX}/import-preset`)
    const read = handlers.get(`${PREFIX}/preset-content`)
    assert.ok(write && read, '/import-preset 与 /preset-content 应注册')
    writeFileSync(join(dir, 'preset.md'), 'ORIGINAL PRESET', 'utf8')
    writeFileSync(join(dir, 'agents.md'), 'ORIGINAL AGENTS', 'utf8')
    for (const body of [
      { scope: 'preset', content: 'OLD SHAPE' },
      { contents: null },
      { contents: [] },
      { contents: [null] },
      { contents: [[]] },
      { contents: [{ scope: 'preset', content: 'PARTIAL WRITE' }, { scope: 'unknown', content: 'INVALID' }] },
      { contents: [{ scope: 'preset', content: 123 }] },
      { contents: [{ scope: 'preset' }] },
    ]) {
      const rejected = fakeRes()
      await write(fakeReq({ [Symbol.asyncIterator]: async function* () {
        yield Buffer.from(JSON.stringify(body))
      } }), rejected)
      assert.equal(rejected.status, 400, JSON.stringify(body))
      assert.equal(JSON.parse(rejected.body).code, 'settings-rejected')
      assert.equal(readFileSync(join(dir, 'preset.md'), 'utf8'), 'ORIGINAL PRESET')
      assert.equal(readFileSync(join(dir, 'agents.md'), 'utf8'), 'ORIGINAL AGENTS')
      assert.equal(imports, 0)
    }
    // 一次请求写入全部内容；空文本仍可显式清空。
    const wres = fakeRes()
    await write(fakeReq({ body: undefined, [Symbol.asyncIterator]: async function* () {
      yield Buffer.from(JSON.stringify({ contents: [
        { scope: 'preset', content: 'HELLO PRESET' },
        { scope: 'agents', content: '' },
      ] }))
    } }), wres)
    assert.equal(wres.status, 200)
    assert.deepEqual(importedScopes, ['preset', 'agents'])
    assert.equal(imports, 1)
    assert.equal(readFileSync(join(dir, 'agents.md'), 'utf8'), '')
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

test('模板变量与参数独立保存，读取与 bootstrap 不回退旧 params 内容键', async () => {
  const { ctx, handlers } = makeHarness()
  const dir = makeUserPresetDir('pt-variable-isolation-')
  const file = join(dir, 'module.yml')
  const params = { legacyOnly: '旧值', variables: { nested: '嵌套旧值' } }
  // B7 T3：变量名故意与**已登记的存活引擎参数**同名（原 usePtcMode / stagePreUnlock 已删除）——
  // 模板变量只写顶层 `variables`，不得污染 `layerSettings` 上的同名引擎参数。
  const layerSettings = { 'tool-pipeline': { toolGitBashEnabled: false, strReplaceEditorMaxOutputChars: 16000 } }
  writeFileSync(file, `# keep comment\nid: ${basename(dir)}\nparams: ${JSON.stringify(params)}\nlayerSettings: ${JSON.stringify(layerSettings)}\n`, 'utf8')
  registerSettingsBridge(ctx, 'prompt-tool', () => ({ available: true, providers: [] }),
    () => skillsStateStub(), () => '', undefined, () => dir)
  const write = handlers.get(PREFIX + BRIDGE_ENDPOINTS.presetVariables)
  for (const variables of [{ toolGitBashEnabled: 'text', strReplaceEditorMaxOutputChars: '' }, {}]) {
    const res = fakeRes()
    await write(fakeReq({ [Symbol.asyncIterator]: async function* () {
      yield Buffer.from(JSON.stringify({ variables }))
    } }), res)
    assert.equal(res.status, 200)
    const saved = parseYaml(readFileSync(file, 'utf8'))
    assert.deepEqual(saved.params, params)
    assert.deepEqual(saved.layerSettings, layerSettings)
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
  let registryRefreshes = 0
  const importedIds = []
  const id = 'root-management'
  const activeDir = join(userPresetRoot, id)
  const presetContent = `id: ${id}\nname: custom\nmodules: []\n`
  mkdirSync(activeDir, { recursive: true })
  writeFileSync(join(activeDir, 'module.yml'), presetContent, 'utf8')
  registerSettingsBridge(ctx, 'prompt-tool',
    () => ({ available: true, providers: [] }),
    () => skillsStateStub(),
    () => '', undefined, () => activeDir, undefined, undefined,
    (id) => { importedIds.push(id) }, undefined,
    () => { registryRefreshes++ })
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
  const exported = await call('exportPreset', { id, mode: 'definition' })
  assert.equal(exported.content, readFileSync(join(activeDir, 'module.yml'), 'utf8'))
  const copied = await call('moduleDuplicate', { id })
  assert.deepEqual(parseYaml(readFileSync(join(userPresetRoot, copied.id, 'module.yml'), 'utf8')), { ...parseYaml(exported.content), id: copied.id })
  await call('moduleDelete', { id: copied.id })
  assert.equal(existsSync(join(userPresetRoot, copied.id)), false)
  const cloned = await call('moduleClone', { id: 'ponytail' })
  assert.ok(existsSync(join(userPresetRoot, cloned.id, 'module.yml')))
  const files = [{ path: 'module.yml', content: 'id: root-import\nname: Root Import\nmodules: []\n' }]
  const preview = await call('importPresetPackage', { files, preview: true })
  const imported = await call('importPresetPackage', { files, expectedSourceDigest: preview.sourceDigest, expectedPreviewRevision: preview.previewRevision })
  assert.ok(existsSync(join(userPresetRoot, imported.id, 'module.yml')))
  assert.equal(registryRefreshes, 3, '复制、删除、新建分别刷新官方注册')
  assert.deepEqual(importedIds, [imported.id], '完整导入刷新最终 ID，预览不注册')
  assert.equal(readFileSync(join(activeDir, 'module.yml'), 'utf8'), presetContent, '管理操作不得改动源预设')
})

test('settings bridge：system 预设拒绝全部当前预设写入', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pt-system-readonly-'))
  const presetFile = join(dir, 'module.yml')
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
      assert.deepEqual(readdirSync(dir), ['module.yml'], `${endpoint} 不得创建 system 预设文件`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

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

test('settings bridge /custom-tools 保存时自动追加工具模块', async () => {
  const dir = makeUserPresetDir('pt-custom-tools-modules-')
  try {
    writeFileSync(join(dir, 'module.yml'), [`id: ${basename(dir)}`, 'modules: []', ''].join(String.fromCharCode(10)), 'utf8')
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
    const parsed = parseYaml(readFileSync(join(dir, 'module.yml'), 'utf8'))
    assert.deepEqual(parsed.modules, ['tool-config-engine', 'world-book-tools'], '只装配自定义工具实际依赖的模块')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('settings bridge /subagent-tool-policy 保存、停用与模块装配均为原子操作', async () => {
  const dir = makeUserPresetDir('pt-subagent-policy-')
  try {
    writeFileSync(join(dir, 'module.yml'), `id: ${basename(dir)}\nmodules: []\nunknown: keep\n`, 'utf8')
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
    let parsed = parseYaml(readFileSync(join(dir, 'module.yml'), 'utf8'))
    assert.deepEqual(parsed.subagentToolPolicy, policy)
    assert.deepEqual(parsed.modules, ['subagent-tool-policy'], '空白预设只装配子代理策略模块')
    assert.equal(parsed.unknown, 'keep')
    const disable = fakeRes()
    await handler(fakeReq({ [Symbol.asyncIterator]: async function* () { yield Buffer.from(JSON.stringify({ policy: null })) } }), disable)
    assert.equal(disable.status, 200)
    parsed = parseYaml(readFileSync(join(dir, 'module.yml'), 'utf8'))
    assert.equal(parsed.subagentToolPolicy, undefined)
    assert.ok(parsed.modules.includes('subagent-tool-policy'), '关闭开关只删策略段，模块声明保留（能力卡可再次打开）')
    assert.equal(parsed.unknown, 'keep')
    assert.equal(rebuilds, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('settings bridge /persona 读写顶层 persona 段并按实际模块身份重建', async () => {
  const { ctx, handlers } = makeHarness()
  const dir = makeUserPresetDir('pt-persona-')
  writeFileSync(join(dir, 'module.yml'), `id: ${basename(dir)}\nname: beta\nunknown: keep\n`, 'utf8')
  const rebuilds = []
  try {
    registerSettingsBridge(ctx, 'prompt-tool',
      () => ({ available: true, providers: [] }),
      () => skillsStateStub(),
      () => '',
      undefined,
      () => dir,
      undefined,
      (id) => { rebuilds.push(id) },
    )
    const handler = handlers.get(PREFIX + BRIDGE_ENDPOINTS.persona)
    assert.ok(handler, '/persona 端点应注册')
    const write = fakeRes()
    await handler(fakeReq({ [Symbol.asyncIterator]: async function* () {
      yield Buffer.from(JSON.stringify({ persona: { prefix: 'PREFIX', suffix: 'SUFFIX', complete: true, includeRuntimeContext: false } }))
    } }), write)
    assert.equal(write.status, 200)
    const written = parseYaml(readFileSync(join(dir, 'module.yml'), 'utf8'))
    assert.deepEqual(written.persona, { prefix: 'PREFIX', suffix: 'SUFFIX', complete: true, includeRuntimeContext: false })
    assert.equal(written.unknown, 'keep', '未知字段保留')
    assert.deepEqual(rebuilds, [basename(dir)], '写盘后把实际模块身份交给运行时')
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
    assert.equal(parseYaml(readFileSync(join(dir, 'module.yml'), 'utf8')).persona, undefined)
    assert.deepEqual(rebuilds, [basename(dir), basename(dir)])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('/persona：已有启用「独占」的提示词配置时拒绝顶层人设独占（禁用/无配置不算冲突）', async () => {
  const { ctx, handlers } = makeHarness()
  const dir = makeUserPresetDir('pt-persona-complete-')
  let rebuilds = 0
  const writeModule = (configs) => writeFileSync(
    join(dir, 'module.yml'),
    `id: ${basename(dir)}\nname: complete\npromptConfigs: ${JSON.stringify(configs)}\n`,
    'utf8',
  )
  const exclusive = (enabled) => [{
    id: 'exclusive-section',
    enabled,
    layer: 'system-section',
    strategy: 'static',
    text: '独占段',
    params: { complete: true },
  }]
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

    // 关键拒绝：磁盘上已有启用的「独占」段 → 顶层人设不得再开独占（否则宿主装配抛错）。
    writeModule(exclusive(true))
    const before = readFileSync(join(dir, 'module.yml'), 'utf8')
    const rejected = fakeRes()
    await handler(fakeReq({ [Symbol.asyncIterator]: async function* () {
      yield Buffer.from(JSON.stringify({ persona: { prefix: 'PREFIX', complete: true } }))
    } }), rejected)
    assert.equal(rejected.status, 400)
    assert.equal(JSON.parse(rejected.body).code, 'preset-persona-complete-conflict')
    assert.equal(readFileSync(join(dir, 'module.yml'), 'utf8'), before, '被拒时不落盘')
    assert.equal(rebuilds, 0, '被拒时不重建')

    // 边界：同一条配置被禁用 → 不构成冲突，写入成功。
    writeModule(exclusive(false))
    const allowed = fakeRes()
    await handler(fakeReq({ [Symbol.asyncIterator]: async function* () {
      yield Buffer.from(JSON.stringify({ persona: { prefix: 'PREFIX', complete: true } }))
    } }), allowed)
    assert.equal(allowed.status, 200, '禁用的「独占」段不算冲突')
    assert.equal(parseYaml(readFileSync(join(dir, 'module.yml'), 'utf8')).persona.complete, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('/param-overrides：顶层人设已开「独占」时拒绝启用提示词配置独占（未声明/禁用不算冲突）', async () => {
  const { ctx, handlers } = makeHarness()
  const dir = makeUserPresetDir('pt-overrides-complete-')
  const rebuilds = []
  const base = `id: ${basename(dir)}\nname: complete\npersona:\n  prefix: PREFIX\n`
  const exclusiveConfig = (enabled) => [{
    id: 'exclusive-section',
    enabled,
    layer: 'system-section',
    strategy: 'static',
    text: '独占段',
    params: { complete: true },
  }]
  const post = async (payload) => {
    const res = fakeRes()
    await handlers.get(PREFIX + BRIDGE_ENDPOINTS.paramOverrides)(fakeReq({
      [Symbol.asyncIterator]: async function* () { yield Buffer.from(JSON.stringify(payload)) },
    }), res)
    return res
  }
  try {
    registerSettingsBridge(ctx, 'prompt-tool',
      () => ({ available: true, providers: [] }),
      () => skillsStateStub(),
      () => '',
      undefined,
      () => dir,
      undefined,
      (id) => { rebuilds.push(id) },
    )
    // 前置：人设未开独占 → 启用提示词配置独占允许。
    writeFileSync(join(dir, 'module.yml'), base, 'utf8')
    assert.equal((await post({ promptConfigs: exclusiveConfig(true) })).status, 200)
    assert.deepEqual(rebuilds, [basename(dir)], '提示词配置保存后按实际模块身份装配')

    // 磁盘人设开独占 → 再启用提示词配置独占必须被拒。
    writeFileSync(join(dir, 'module.yml'), `${base}  complete: true\n`, 'utf8')
    const before = readFileSync(join(dir, 'module.yml'), 'utf8')
    const rejected = await post({ promptConfigs: exclusiveConfig(true) })
    assert.equal(rejected.status, 400)
    assert.equal(JSON.parse(rejected.body).code, 'overrides-invalid-value')
    assert.equal(readFileSync(join(dir, 'module.yml'), 'utf8'), before, '被拒时不落盘')
    assert.deepEqual(rebuilds, [basename(dir)], '被拒时不触发运行时装配')

    // 边界：同步提交的配置是禁用的 → 不算冲突。
    assert.equal((await post({ promptConfigs: exclusiveConfig(false) })).status, 200, '禁用的「独占」段不算冲突')
    assert.deepEqual(rebuilds, [basename(dir), basename(dir)])
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

test('settings bridge 技能端点：创建 → 调用策略写入 → 恢复 → 回收站删除都落在用户技能根', async () => {
  const root = makeSkillsRoot()
  let refreshes = 0
  try {
    const { ctx, handlers } = makeHarness()
    // 调用策略用真实文件读写（写盘幂等与恢复靠文件字节断言，不用替身假装成功）。
    // 身份校验与生产一致：path 必须命中当次扫描的同名有效条目，否则按陈旧界面拒绝。
    // 用户技能根在下文用 temp 目录直接给出：dshHome 不含它，所以显式列入引用目录参与扫描
    // （.system 是点目录，一层发现天然跳过，不会被当成技能）。
    //
    // 清单缓存也照生产抄（index.ts：按 cwd 缓存 + 写盘后失效）：少了失效这一步，
    // 端点返回的「新清单」就是写盘前的旧值——这正是被测用例要抓住的行为。
    const stateFile = join(root, '.system', 'prompt-tool', 'skills.yml')
    let catalogCache = new Map()
    const listSkills = (cwd) => {
      const key = String(cwd)
      const cached = catalogCache.get(key)
      if (cached !== undefined) return cached
      const entries = catalogFromScan(scanRoots(skillRoots({
        ...(cwd === undefined ? {} : { cwd }),
        dshHome: root,
        folders: [root, ...readSkillsState(stateFile).state.folders],
      })))
      catalogCache.set(key, entries)
      return entries
    }
    const setSkillPolicy = (name, path, scope, cwd) => {
      const fresh = listSkills(cwd).find((entry) => entry.name === name && entry.path === path)
      if (fresh === undefined) return { ok: false, message: `技能已变化，请刷新后重试：${name}` }
      if (!fresh.valid) return { ok: false, message: `技能无效，无法写入调用策略：${fresh.issue ?? name}` }
      const written = setSkillInvocation(path, scope)
      if (written.ok === false) return written
      catalogCache = new Map()
      return written
    }
    registerSettingsBridge(ctx, 'prompt-tool', () => ({ available: true, providers: [] }),
      () => skillsStateStub({ skillsRoot: root, listSkills, setSkillPolicy }), () => '', () => { refreshes += 1 })
    const postCreate = skillsPost(handlers, 'skillCreate')
    const postPolicy = skillsPost(handlers, 'skillPolicy')
    const postDelete = skillsPost(handlers, 'skillDelete')
    const policyOf = (marker) => {
      const read = readSkillInvocation(marker)
      assert.equal(read.ok, true, read.message)
      return read.invocation
    }

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

    // 正常写入：200 并返回**新清单**，清单里的按端事实与文件字节一致。
    const blocked = await postPolicy({ name: 'demo-skill', path: marker, scope: 'all' })
    assert.equal(blocked.status, 200, blocked.body.message)
    const blockedEntry = blocked.body.value.skills.find((skill) => skill.name === 'demo-skill')
    assert.ok(blockedEntry, '响应必须带回新清单')
    assert.deepEqual([blockedEntry.modelInvocable, blockedEntry.userInvocable], [false, false], '两端都停用')
    assert.deepEqual(policyOf(marker), { modelInvocable: false, userInvocable: false })
    assert.match(readFileSync(marker, 'utf8'), /^disable-model-invocation: true$/m)
    assert.match(readFileSync(marker, 'utf8'), /^user-invocable: false$/m)
    assert.equal(readFileSync(marker, 'utf8').includes('# demo'), true, '正文不得被改写')

    // 幂等：同一 scope 重复写入不产生额外变化（第二次是零写入）。
    const again = await postPolicy({ name: 'demo-skill', path: marker, scope: 'all' })
    assert.equal(again.status, 200, again.body.message)
    assert.equal(again.body.value.skills.find((skill) => skill.name === 'demo-skill').modelInvocable, false)
    assert.deepEqual(policyOf(marker), { modelInvocable: false, userInvocable: false })

    // 两端独立：只关模型端时用户端仍可调用。
    const modelOnly = await postPolicy({ name: 'demo-skill', path: marker, scope: 'model' })
    assert.equal(modelOnly.status, 200, modelOnly.body.message)
    assert.deepEqual(policyOf(marker), { modelInvocable: false, userInvocable: true })
    assert.match(readFileSync(marker, 'utf8'), /^user-invocable: true$/m)
    // 反向：只关用户端时模型端仍可调用。
    const userOnly = await postPolicy({ name: 'demo-skill', path: marker, scope: 'user' })
    assert.equal(userOnly.status, 200, userOnly.body.message)
    assert.deepEqual(policyOf(marker), { modelInvocable: true, userInvocable: false })

    // 参数缺失或非法：400，先于任何写盘。
    const beforeInvalid = readFileSync(marker, 'utf8')
    assert.equal((await postPolicy({ name: 'demo-skill', scope: 'all' })).status, 400, '缺 path')
    assert.equal((await postPolicy({ path: marker, scope: 'all' })).status, 400, '缺 name')
    assert.equal((await postPolicy({ name: 'demo-skill', path: marker })).status, 400, '缺 scope')
    assert.equal((await postPolicy({ name: 'demo-skill', path: marker, scope: 'yes' })).status, 400, '非法 scope')
    assert.equal((await postPolicy({ name: '', path: marker, scope: 'all' })).status, 400, '空 name')
    assert.equal((await postPolicy({ name: 'demo-skill', path: '', scope: 'all' })).status, 400, '空 path')
    assert.equal(readFileSync(marker, 'utf8'), beforeInvalid, '非法参数不得写盘')

    // path 与最新扫描不一致（陈旧界面 / 伪造路径）：409，且磁盘文件逐字节不变。
    const stale = await postPolicy({ name: 'demo-skill', path: join(root, 'demo-skill', 'OTHER.md'), scope: 'all' })
    assert.equal(stale.status, 409, stale.body.message)
    assert.equal(stale.body.code, 'skill-policy-rejected')
    assert.equal(readFileSync(marker, 'utf8'), beforeInvalid, '身份校验失败不得写盘')
    // 同名的另一个真实文件与不存在的技能名同样 409。
    assert.equal((await postPolicy({ name: 'missing-skill', path: marker, scope: 'all' })).status, 409)
    assert.equal((await postPolicy({ name: 'demo-skill', path: join(root, 'not-there', 'SKILL.md'), scope: 'all' })).status, 409)
    assert.equal(readFileSync(marker, 'utf8'), beforeInvalid)
    // 刷新次数（此处）：创建 1 次 + 4 次成功的策略写入（含内容无变化的幂等重写：
    // 端点按「写入成功」回调，不区分是否真的改了字节）= 5；被拒的 400/409 请求一次都不触发。
    assert.equal(refreshes, 5,
      `创建与每次成功策略写入各触发一次刷新（当前 ${refreshes}）；被拒请求不触发`)

    // 恢复：两端回到可调用。
    const restored = await postPolicy({ name: 'demo-skill', path: marker, scope: 'none' })
    assert.equal(restored.status, 200, restored.body.message)
    const restoredEntry = restored.body.value.skills.find((skill) => skill.name === 'demo-skill')
    assert.deepEqual([restoredEntry.modelInvocable, restoredEntry.userInvocable], [true, true])
    assert.deepEqual(policyOf(marker), { modelInvocable: true, userInvocable: true })
    assert.match(readFileSync(marker, 'utf8'), /^disable-model-invocation: false$/m)
    assert.match(readFileSync(marker, 'utf8'), /^user-invocable: true$/m)
    // 恢复本身也是一次成功写入：5（创建 + 4 次策略写入）+ 1 = 6。
    assert.equal(refreshes, 6)
    // 整轮写入都不得在技能目录里留下暂存文件。
    assert.deepEqual(readdirSync(join(root, 'demo-skill')), ['SKILL.md'])

    // 回收站删除：整个技能目录移入用户根下的 .system/prompt-tool/.trash。
    const removed = await postDelete({ name: 'demo-skill', path: marker })
    assert.equal(removed.status, 200, removed.body.message)
    assert.equal(existsSync(marker), false)
    const trash = readdirSync(join(root, '.system', 'prompt-tool', '.trash'))
    assert.equal(trash.length, 1)
    assert.equal(existsSync(join(root, '.system', 'prompt-tool', '.trash', trash[0], 'demo-skill', 'SKILL.md')), true, '技能目录可人工恢复')
    assert.equal((await postDelete({ folder: '../escape' })).status, 400)
    assert.equal((await postDelete({ folder: 'missing-skill' })).status, 400)
    // 删除成功 = 6 + 1 = 7（紧随其后的 400 拒绝请求不触发刷新）。
    assert.equal(refreshes, 7, '回收站删除再触发一次刷新')
  } finally { rmSync(root, { recursive: true, force: true }) }
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
    // 用户技能根是 dshHome 下的 skills/：这里显式给根目录，让用户根与会话无关地可扫描。
    const listSkills = (cwd) => catalogFromScan(scanRoots(skillRoots({
      cwd,
      dshHome: root,
      folders: readSkillsState(stateFile).state.folders,
    })))
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
