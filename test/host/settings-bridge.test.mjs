import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
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
} = await import('../../lib/index.mjs')
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
const userPresetRoot = join(bridgeHome, '.agent-presets')

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

test('bootstrap 与技能清单使用同一会话 cwd 和真实 registry scope 胜出结果', async () => {
  const { Context } = await import('@deepseek-ai/cordis')
  const { SkillRegistry } = await import('@deepseek-ai/dsh-skill')
  const { createScope } = await import('@deepseek-ai/dsh-scope')
  const app = new Context()
  const registry = new SkillRegistry(app)
  const key = {}
  const scope = createScope(app, key)
  const entries = ['custom', 'user-dsh'].map((source, i) => ({
    id: source, source, rank: 300 + i * 100, name: 'demo', folder: 'demo', description: source,
    dir: join(bridgeHome, source), path: join(bridgeHome, source, 'demo', 'SKILL.md'),
    valid: true, modelInvocable: true, userInvocable: true,
  }))
  const provider = (entry) => ({ name: entry.source, list: async () => [{
    name: entry.name, description: entry.description, provider: entry.source, source: entry.source,
    rank: entry.rank, locator: entry.path, path: entry.path,
    invocation: { modelInvocable: true, userInvocable: true },
  }], get: async () => undefined })
  const dispose = registry.registerProvider(() => provider(entries[0]))
  scope.ctx.skills.registerProvider(() => provider(entries[1]))
  const cwd = join(bridgeHome, 'project')
  const { ctx, handlers } = makeHarness({ skills: registry, agents: {
    get: (id) => id === 'current' ? { ctx: scope.ctx, session: { header: { cwd } } } : undefined,
  } })
  const seen = []
  registerSettingsBridge(ctx, 'prompt-tool', () => ({ available: false, providers: [] }),
    () => skillsStateStub({ listSkills: (dir) => { seen.push(dir); return entries } }), () => '')
  try {
    for (const endpoint of ['bootstrap', 'skillsList']) {
      const res = fakeRes()
      await handlers.get(PREFIX + BRIDGE_ENDPOINTS[endpoint])(fakeReq({
        async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ sessionId: 'current' })) },
      }), res)
      assert.equal(res.status, 200, res.body)
      const body = JSON.parse(res.body)
      const skills = endpoint === 'bootstrap' ? body.skillCatalog : body.value.skills
      assert.equal(skills.find((entry) => entry.id === 'custom').winnerId, 'user-dsh')
      assert.equal(skills.find((entry) => entry.id === 'user-dsh').winnerId, undefined)
      assert.equal(seen.at(-1), cwd)
    }
  } finally { await scope.dispose(); dispose() }
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
  writeFileSync(join(dir, 'preset.yml'), `id: ${basename(dir)}\n`, 'utf8')
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
  writeFileSync(join(dir, 'preset.yml'), `id: ${basename(dir)}\n`, 'utf8')
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
    assert.equal(readFileSync(join(dir, 'preset.yml'), 'utf8'), `id: ${basename(dir)}\n`, '未知键不得写入 preset.yml')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('settings bridge /param-overrides 数值参数保存前校验（temperature/maxTokens 响亮失败）', async () => {
  const { ctx, handlers } = makeHarness()
  const dir = makeUserPresetDir('pt-overrides-invalid-')
  writeFileSync(join(dir, 'preset.yml'), `id: ${basename(dir)}\n`, 'utf8')
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
    assert.equal(readFileSync(join(dir, 'preset.yml'), 'utf8'), `id: ${basename(dir)}\n`, '非法值不得写入 preset.yml')

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
  const original = `# keep comment\nid: ${basename(dir)}\nmodules: [tool-bootstrap]\nunknown: keep\n`
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
  writeFileSync(file, `# keep comment\nid: ${basename(dir)}\nparams: ${JSON.stringify(params)}\n`, 'utf8')
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
  const exported = await call('exportPreset', { id, mode: 'definition' })
  assert.equal(exported.content, readFileSync(join(activeDir, 'preset.yml'), 'utf8'))
  const copied = await call('presetDuplicate', { id })
  assert.deepEqual(parseYaml(readFileSync(join(userPresetRoot, copied.id, 'preset.yml'), 'utf8')), { ...parseYaml(exported.content), id: copied.id })
  await call('presetDelete', { id: copied.id })
  assert.equal(existsSync(join(userPresetRoot, copied.id)), false)
  const cloned = await call('presetClone', { id: 'pt-custom' })
  assert.ok(existsSync(join(userPresetRoot, cloned.id, 'preset.yml')))
  const files = [{ path: 'preset.yml', content: 'id: root-import\nname: Root Import\nmodules: []\n' }]
  const preview = await call('importPresetPackage', { files, preview: true })
  const imported = await call('importPresetPackage', { files, expectedSourceDigest: preview.sourceDigest, expectedPreviewRevision: preview.previewRevision })
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
  const original = `id: ${basename(dir)}\nparams:\n  firstTurnAnchor: false\n`
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
  writeFileSync(join(dir, 'preset.yml'), `id: ${basename(dir)}\n`, 'utf8')
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

test('settings bridge：原始来源上传接受 64 MiB 边界，只暂存并可显式释放', async () => {
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
    const handler = handlers.get(PREFIX + BRIDGE_ENDPOINTS.assetUpload)
    assert.ok(handler, '上传暂存端点应注册')
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
    assert.equal(payload.value.bytes, MAX_CHARACTER_CARD_STREAM_BYTES)
    assert.equal(existsSync(join(root, '.characters')), false, '上传不进入角色库')
    const release = fakeRes()
    await handlers.get(PREFIX + BRIDGE_ENDPOINTS.assetRelease)(fakeReq({ [Symbol.asyncIterator]: async function* () { yield Buffer.from(JSON.stringify({ sourceId: payload.value.sourceId })) } }), release)
    assert.equal(release.status, 200)
    assert.equal(JSON.parse(release.body).value.released, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
test('settings bridge：原始来源上传超过 64 MiB 返回 413 并清理临时文件', async () => {
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
    const handler = handlers.get(PREFIX + BRIDGE_ENDPOINTS.assetUpload)
    assert.ok(handler, '上传暂存端点应注册')
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
    assert.equal(payload.code, 'asset-upload-rejected')
    assert.match(payload.message, /64 MiB/)
    assert.deepEqual(readdirSync(join(bridgeHome, '.prompt-tool-uploads')), [])
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
    writeFileSync(join(dir, 'preset.yml'), [`id: ${basename(dir)}`, 'modules: []', ''].join(String.fromCharCode(10)), 'utf8')
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
    writeFileSync(join(dir, 'preset.yml'), `id: ${basename(dir)}\n`, 'utf8')
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
  const dir = makeUserPresetDir('pt-engine-capability-bridge-')
  try {
    writeFileSync(join(dir, 'preset.yml'), `id: ${basename(dir)}\nname: beta\nversion: "1"\nengineCompat: ">=0"\nmodules: [context-gate, tool-filter]\n`, 'utf8')
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
  const original = `# 用户注释\nid: ${basename(dir)}\nmodules: []\nunknown: keep\n`
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
  for (const dir of [a, b]) writeFileSync(join(dir, 'preset.yml'), `id: ${basename(dir)}\nmodules: []\n`, 'utf8')
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
  const original = `id: ${basename(dir)}\nmodules: [tool-bootstrap]\nmoduleConfigs:\n  tool-bootstrap:\n    promoteOn: tool-call\n`
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
    writeFileSync(join(dir, 'preset.yml'), `id: ${basename(dir)}\nmodules: []\nunknown: keep\n`, 'utf8')
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
  writeFileSync(join(dir, 'preset.yml'), `id: ${basename(dir)}\nname: beta\nunknown: keep\n`, 'utf8')
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
    writeFileSync(join(dir, 'preset.yml'), `id: ${basename(dir)}\n`, 'utf8')
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
    writeFileSync(join(dir, 'preset.yml'), `id: ${basename(dir)}\npersona:\n  prefix: P\n  complete: true\n`, 'utf8')
    const overrides = handlers.get(PREFIX + BRIDGE_ENDPOINTS.paramOverrides)
    const conflict = fakeRes()
    await overrides(fakeReq({ [Symbol.asyncIterator]: async function* () {
      yield Buffer.from(JSON.stringify({ promptConfigs: [{ id: 'exclusive', enabled: true, params: { complete: true } }] }))
    } }), conflict)
    assert.equal(conflict.status, 400)
    assert.equal(JSON.parse(conflict.body).code, 'overrides-invalid-value')
    // 方向二：提示词配置已独占 → 保存 complete 顶层人设被拒。
    writeFileSync(join(dir, 'preset.yml'), [
      `id: ${basename(dir)}`,
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
