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

const textRule = (id, text, options = {}) => {
  const { enabled, ...config } = options
  return { id, layer: config.layer ?? 'pre-step', ...(enabled === undefined ? {} : { enabled }), then: [{ id: 'inject', kind: 'inject-text', config: { id, layer: 'pre-step', text, ...config } }] }
}
const requestRule = (id, patch) => ({ id, layer: 'agent-request', then: [{ id: 'request', kind: 'request-params', patch }] })

function makeHarness(services = {}, value = {}) {
  const handlers = new Map()
  const sctx = {
    get: (name) => services[name],
    settings: {
      describe: () => [
        { ns: 'prompt-tool', value, base: {} },
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
  assert.ok(payload.value.meta.strategies.includes('anchor-notice'))
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
  const write = handlers.get(PREFIX + BRIDGE_ENDPOINTS.moduleVariables)
  for (const variables of [{ toolGitBashEnabled: 'text', strReplaceEditorMaxOutputChars: '' }, {}]) {
    const initial = fakeRes()
    await write(fakeReq(), initial)
    const expectedRevisions = JSON.parse(initial.body).value.revisions
    const res = fakeRes()
    await write(fakeReq({ [Symbol.asyncIterator]: async function* () {
      yield Buffer.from(JSON.stringify({ variables, expectedRevisions }))
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
    assert.deepEqual(JSON.parse(read.body).value.variables, variables)
    assert.equal(JSON.parse(read.body).value.enabled, true)
    assert.match(JSON.parse(read.body).value.revisions.variables, /^[a-f0-9]{64}$/)
    const bootstrap = fakeRes()
    await handlers.get(PREFIX + BRIDGE_ENDPOINTS.bootstrap)(fakeReq(), bootstrap)
    assert.equal(bootstrap.status, 200)
    assert.deepEqual(JSON.parse(bootstrap.body).variables.variables, variables)
    assert.equal(JSON.parse(bootstrap.body).variables.enabled, true)
    assert.deepEqual(JSON.parse(bootstrap.body).variablesRevisions, JSON.parse(read.body).value.revisions)
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

test('请求模块身份统一 bootstrap 快照与规则写入；错误身份和途中换目标零写盘', async (t) => {
  const dirA = makeUserPresetDir('target-a-'), dirB = makeUserPresetDir('target-b-')
  const idA = basename(dirA), idB = basename(dirB)
  const fileA = join(dirA, 'module.yml'), fileB = join(dirB, 'module.yml')
  writeFileSync(fileA, JSON.stringify({ id: idA, modules: ['rule-engine'], variables: { owner: 'A' }, rules: [textRule('module-a-card', 'A'), requestRule('model', { temperature: 0.2 })] }))
  writeFileSync(fileB, JSON.stringify({ id: idB, modules: ['rule-engine'], variables: { owner: 'B' }, rules: [requestRule('model', { maxTokens: 888 })] }))
  const descriptorValue = {}
  const { ctx, handlers } = makeHarness({}, descriptorValue)
  let requestedDir = dirA
  const rebuilt = []
  registerSettingsBridge(ctx, 'prompt-tool', () => ({ available: true, providers: [] }),
    () => skillsStateStub(), () => '', undefined,
    (id) => id === idA ? requestedDir : dirB, (id) => { rebuilt.push(id) }, undefined)
  const call = async (endpoint, body = {}, options = {}) => {
    const target = Object.hasOwn(options, 'target') ? options.target : idA
    const res = fakeRes()
    await handlers.get(PREFIX + BRIDGE_ENDPOINTS[endpoint])(fakeReq({
      headers: { host: 'localhost', ...(target === undefined ? {} : { 'x-module-id': target }) },
      async *[Symbol.asyncIterator]() {
        options.onRead?.()
        yield Buffer.from(JSON.stringify({ ...(endpoint === 'rules' ? { expectedModuleId: target } : {}), ...body }))
      },
    }), res)
    return { status: res.status, payload: JSON.parse(res.body) }
  }
  await t.test('显式 A 的 descriptor、规则、变量和能力事实均来自 A', async () => {
    for (const endpoint of ['bootstrap', 'describe']) {
      const { status, payload } = await call(endpoint)
      assert.equal(status, 200)
      assert.equal(payload.value.value.moduleId, idA)
      assert.deepEqual(payload.moduleFacts.declaredModules, ['rule-engine'])
      assert.equal(payload.templatePreStepCount, 1)
      if (endpoint === 'bootstrap') {
        assert.deepEqual(payload.overrides.overrides, {})
        assert.deepEqual(payload.variables.variables, { owner: 'A' })
        assert.equal(payload.variables.enabled, true)
        assert.deepEqual(payload.promptConfigs.promptConfigs, [], '旧配置卡入口只承载独立文件卡')
      }
    }
    const current = await call('rules')
    assert.equal(current.status, 200)
    assert.deepEqual(current.payload.value.rules.map(rule => rule.id), ['module-a-card', 'model'])
    assert.equal(current.payload.value.rules[1].then[0].patch.temperature, 0.2)
    assert.deepEqual(descriptorValue, {}, '响应投影不修改全局设置')
    const noHeader = await call('bootstrap', {}, { target: undefined })
    assert.equal(noHeader.status, 200)
    assert.equal(noHeader.payload.value.value.moduleId, idB, '无目标时描述身份来自实际回退目录')
    const fallback = await call('rules', { expectedModuleId: idB }, { target: undefined })
    assert.equal(fallback.status, 200)
    assert.equal(fallback.payload.value.rules[0].then[0].patch.maxTokens, 888)
  })
  await t.test('A 请求可以保存 A，expected B 被拒且不改任一模块', async () => {
    const beforeB = readFileSync(fileB, 'utf8')
    const revisions = (await call('rules')).payload.value.revisions
    const edits = [{ previousId: 'model', rule: requestRule('model', { temperature: 0.4 }) }]
    const saved = await call('rules', { expectedRevisions: revisions, edits })
    assert.equal(saved.status, 200, JSON.stringify(saved.payload))
    assert.equal(parseYaml(readFileSync(fileA, 'utf8')).rules[1].then[0].patch.temperature, 0.4)
    assert.equal(readFileSync(fileB, 'utf8'), beforeB)
    assert.deepEqual(rebuilt, [idA])
    const beforeA = readFileSync(fileA, 'utf8')
    const deleting = await call('moduleDelete', { id: idA })
    assert.equal(deleting.status, 400)
    assert.equal(deleting.payload.code, 'module-in-use')
    assert.equal(readFileSync(fileA, 'utf8'), beforeA)
    const rejected = await call('rules', { expectedModuleId: idB, expectedRevisions: saved.payload.value.revisions, edits })
    assert.equal(rejected.status, 409)
    assert.equal(rejected.payload.code, 'module-changed')
    assert.equal(readFileSync(fileA, 'utf8'), beforeA)
    assert.equal(readFileSync(fileB, 'utf8'), beforeB)
    assert.deepEqual(rebuilt, [idA])
  })
  await t.test('读取载荷期间同一请求目标变化时拒绝写入', async () => {
    const beforeA = readFileSync(fileA, 'utf8'), beforeB = readFileSync(fileB, 'utf8')
    const beforeRebuilds = rebuilt.length
    const revisions = (await call('rules')).payload.value.revisions
    const rejected = await call('rules', { expectedRevisions: revisions, edits: [{ previousId: 'model', rule: requestRule('model', { temperature: 0.9 }) }] },
      { onRead: () => { requestedDir = dirB } })
    assert.equal(rejected.status, 409)
    assert.equal(rejected.payload.code, 'module-changed')
    assert.equal(readFileSync(fileA, 'utf8'), beforeA)
    assert.equal(readFileSync(fileB, 'utf8'), beforeB)
    assert.equal(rebuilt.length, beforeRebuilds)
  })
})

test('模块配置排序端点：启用尾部追加、跨模块保存、冲突零写入与生效失败反馈', async (t) => {
  const { enabledModuleIds, setModuleEnabled } = await import('../../src/host/config-store.ts')
  const dirs = ['order-a-', 'order-b-', 'order-bad-', 'order-disabled-'].map(makeUserPresetDir)
  const ids = dirs.map((dir) => basename(dir))
  for (const [index, dir] of dirs.entries()) {
    writeFileSync(join(dir, 'module.yml'), JSON.stringify({
      id: ids[index], modules: ['rule-engine'],
      rules: [textRule('card', `BODY ${index}`), ...(index === 3 ? [textRule('second', 'SECOND')] : [])],
      ...(index === 2 ? { configOrder: { card: -1 } } : {}),
    }))
  }
  t.after(() => ids.forEach((id) => setModuleEnabled(userPresetRoot, id, false)))
  const { ctx, handlers } = makeHarness({}, { writePreset: false })
  const rebuilt = []
  let beforeRebuild = async () => {}
  registerSettingsBridge(ctx, 'prompt-tool', () => ({ available: true, providers: [] }),
    () => skillsStateStub(), () => '', undefined, () => dirs[0], undefined,
    async (id) => { await beforeRebuild(id); rebuilt.push(id) })
  const call = async (endpoint, body) => {
    const handler = handlers.get(PREFIX + BRIDGE_ENDPOINTS[endpoint])
    assert.equal(typeof handler, 'function', `${endpoint} 端点已注册`)
    const res = fakeRes()
    await handler(fakeReq({ async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body))
    } }), res)
    return { status: res.status, ...JSON.parse(res.body) }
  }
  const identities = (snapshot) => snapshot.entries.map(({ moduleId, configId }) => ({ moduleId, configId }))
  let snapshot

  await t.test('总闸关闭仍可编辑定义；响应等待全部重建，重复启用不改已存序号', async () => {
    assert.equal((await call('moduleEnable', { id: ids[0], enabled: true })).status, 200)
    assert.equal((await call('moduleEnable', { id: ids[1], enabled: true })).status, 200)
    snapshot = (await call('moduleConfigOrder')).value
    assert.deepEqual(snapshot.entries.map(({ moduleId, sequence }) => [moduleId, sequence]), [[ids[0], 0], [ids[1], 10]])
    const before = readFileSync(join(dirs[0], 'module.yml'), 'utf8')
    const count = rebuilt.filter((id) => id === ids[0]).length
    assert.equal((await call('moduleEnable', { id: ids[0], enabled: true })).status, 200)
    assert.equal(readFileSync(join(dirs[0], 'module.yml'), 'utf8'), before)
    assert.equal(rebuilt.filter((id) => id === ids[0]).length, count)
    let release
    let entered
    const ready = new Promise((resolve) => { entered = resolve })
    const gate = new Promise((resolve) => { release = resolve })
    beforeRebuild = async () => { entered(); await gate }
    let settled = false
    const saving = call('moduleConfigOrder', { expectedRevision: snapshot.revision, entries: identities(snapshot).reverse() })
      .then((result) => { settled = true; return result })
    await ready
    assert.equal(settled, false)
    release()
    const result = await saving
    assert.equal(result.status, 200, result.message)
    snapshot = result.value
    assert.deepEqual(snapshot.entries.map((entry) => entry.moduleId), [ids[1], ids[0]])
    assert.deepEqual(rebuilt.slice(-2).sort(), ids.slice(0, 2).sort())
    for (const [index, dir] of dirs.entries()) {
      assert.equal(parseYaml(readFileSync(join(dir, 'module.yml'), 'utf8')).rules[0].then[0].config.text, `BODY ${index}`)
    }
    beforeRebuild = async () => {}
    const enabledBefore = dirs.slice(0, 2).map((dir) => readFileSync(join(dir, 'module.yml'), 'utf8'))
    const disabled = await call('moduleConfigOrder', { moduleId: ids[3] })
    assert.equal(disabled.status, 200, disabled.message)
    assert.deepEqual(disabled.value.entries.map((entry) => entry.configId), ['card', 'second'])
    const sorted = await call('moduleConfigOrder', { moduleId: ids[3], expectedRevision: disabled.value.revision, entries: identities(disabled.value).reverse() })
    assert.equal(sorted.status, 200, sorted.message)
    assert.deepEqual(sorted.value.entries.map((entry) => entry.configId), ['second', 'card'])
    assert.equal(rebuilt.at(-1), ids[3], '停用模块排序也等待自身重建')
    assert.deepEqual(dirs.slice(0, 2).map((dir) => readFileSync(join(dir, 'module.yml'), 'utf8')), enabledBefore)
    assert.deepEqual((await call('moduleConfigOrder')).value, snapshot, '默认全局列表仍只含启用模块')
  })

  await t.test('真实客户端无参数读取全局排序，不写定义或触发重建', async (t) => {
    const { bridgeCall } = await import('../../src/client/data/bridge-client.ts')
    const before = dirs.map((dir) => readFileSync(join(dir, 'module.yml'), 'utf8'))
    const count = rebuilt.length
    t.mock.method(globalThis, 'fetch', async (url, init) => {
      const handler = handlers.get(url)
      assert.equal(typeof handler, 'function')
      assert.deepEqual(JSON.parse(init.body), {})
      const res = fakeRes()
      await handler(fakeReq({ method: init.method, headers: { host: 'localhost', ...init.headers },
        async *[Symbol.asyncIterator]() { yield Buffer.from(init.body) },
      }), res)
      return new Response(res.body, { status: res.status })
    })
    const result = await bridgeCall('moduleConfigOrder')
    assert.equal(result.ok, true, result.message)
    assert.deepEqual(result.value, snapshot)
    assert.deepEqual(dirs.map((dir) => readFileSync(join(dir, 'module.yml'), 'utf8')), before)
    assert.equal(rebuilt.length, count)
  })

  await t.test('过期版本、重复身份、未知字段和超限载荷拒绝且零写入', async () => {
    const before = dirs.map((dir) => readFileSync(join(dir, 'module.yml'), 'utf8'))
    const count = rebuilt.length
    const entries = identities(snapshot)
    const scoped = (await call('moduleConfigOrder', { moduleId: ids[0] })).value
    for (const [body, status] of [
      [{ expectedRevision: '0'.repeat(64), entries }, 409],
      [{ expectedRevision: snapshot.revision, entries: [entries[0], entries[0]] }, 400],
      [{ expectedRevision: snapshot.revision, entries, text: 'FORBIDDEN' }, 400],
      [{ expectedRevision: snapshot.revision, entries: [{ ...entries[0], text: 'FORBIDDEN' }, entries[1]] }, 400],
      [{ moduleId: '../outside' }, 400],
      [{ moduleId: ids[0], expectedRevision: scoped.revision, entries: [{ moduleId: ids[1], configId: 'card' }] }, 400],
      [{ moduleId: ids[0], expectedRevision: '0'.repeat(64), entries: identities(scoped) }, 409],
      [{ entries }, 400], [{ expectedRevision: snapshot.revision }, 400],
      [{ text: 'FORBIDDEN' }, 400], [null, 400], [[], 400],
    ]) assert.equal((await call('moduleConfigOrder', body)).status, status, JSON.stringify(body))
    assert.deepEqual(dirs.map((dir) => readFileSync(join(dir, 'module.yml'), 'utf8')), before)
    assert.equal(rebuilt.length, count)
  })

  await t.test('追加失败不启用；定义已保存而重建失败返回明确500', async () => {
    assert.equal((await call('moduleEnable', { id: ids[2], enabled: true })).ok, false)
    assert.equal(enabledModuleIds(userPresetRoot).includes(ids[2]), false)
    beforeRebuild = async () => { throw new Error('MATERIALIZE_FAILED') }
    const rebuildCount = rebuilt.filter(id => id === ids[3]).length
    const failedEnable = await call('moduleEnable', { id: ids[3], enabled: true })
    assert.equal(failedEnable.status, 500)
    assert.equal(enabledModuleIds(userPresetRoot).includes(ids[3]), false)
    beforeRebuild = async () => {}
    assert.equal((await call('moduleEnable', { id: ids[3], enabled: true })).status, 200)
    assert.equal(rebuilt.filter(id => id === ids[3]).length, rebuildCount + 1, '上次已分配序号但物化失败，重试仍必须成功物化目标')
    await call('moduleEnable', { id: ids[3], enabled: false })
    beforeRebuild = async () => { throw new Error('MATERIALIZE_FAILED') }
    const result = await call('moduleConfigOrder', { expectedRevision: snapshot.revision, entries: identities(snapshot).reverse() })
    assert.equal(result.status, 500)
    assert.equal(result.code, 'module-activation-failed')
    assert.match(result.message, /已保存/)
    assert.deepEqual((await call('moduleConfigOrder')).value.entries.map((entry) => entry.moduleId), [ids[0], ids[1]])
  })
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
  assert.ok(meta.meta.modules.some(preset => preset.id === id), '预设列表应含官方预设根下的预设')
  const exported = await call('exportModule', { id, mode: 'definition' })
  assert.equal(exported.content, readFileSync(join(activeDir, 'module.yml'), 'utf8'))
  const copied = await call('moduleDuplicate', { id })
  assert.deepEqual(parseYaml(readFileSync(join(userPresetRoot, copied.id, 'module.yml'), 'utf8')), { ...parseYaml(exported.content), id: copied.id })
  await call('moduleDelete', { id: copied.id })
  assert.equal(existsSync(join(userPresetRoot, copied.id)), false)
  const cloned = await call('moduleClone', { id: 'ponytail' })
  assert.ok(existsSync(join(userPresetRoot, cloned.id, 'module.yml')))
  const files = [{ path: 'module.yml', content: 'id: root-import\nname: Root Import\nmodules: []\n' }]
  const preview = await call('importModulePackage', { files, preview: true })
  const imported = await call('importModulePackage', { files, expectedSourceDigest: preview.sourceDigest, expectedPreviewRevision: preview.previewRevision })
  assert.ok(existsSync(join(userPresetRoot, imported.id, 'module.yml')))
  assert.equal(registryRefreshes, 3, '复制、删除、新建分别刷新官方注册')
  assert.deepEqual(importedIds, [imported.id], '完整导入刷新最终 ID，预览不注册')
  assert.equal(readFileSync(join(activeDir, 'module.yml'), 'utf8'), presetContent, '管理操作不得改动源预设')
})

test('settings bridge：system 预设拒绝全部当前预设写入', async () => {
  const container = mkdtempSync(join(tmpdir(), 'pt-system-readonly-'))
  const dir = join(container, 'system')
  mkdirSync(dir)
  const presetFile = join(dir, 'module.yml')
  const original = 'id: system\nmodules: []\nrules: []\n'
  writeFileSync(presetFile, original, 'utf8')
  try {
    const { ctx, handlers } = makeHarness()
    registerSettingsBridge(ctx, 'prompt-tool',
      () => ({ available: true, providers: [] }),
      () => skillsStateStub(),
      () => '', undefined, () => dir)
    const rulesRead = fakeRes()
    await handlers.get(PREFIX + BRIDGE_ENDPOINTS.rules)(fakeReq({ async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ expectedModuleId: basename(dir) })) } }), rulesRead)
    assert.equal(rulesRead.status, 200, rulesRead.body)
    const revisions = JSON.parse(rulesRead.body).value.revisions
    const cases = [
      [BRIDGE_ENDPOINTS.rules, { expectedModuleId: basename(dir), expectedRevisions: revisions, edits: [{ previousId: null, rule: textRule('readonly', 'FORBIDDEN') }] }],
      [BRIDGE_ENDPOINTS.moduleVariables, { variables: { empty: '' }, enabled: true, expectedRevisions: revisions }],
      [BRIDGE_ENDPOINTS.customTools, { customTools: [] }],
      [BRIDGE_ENDPOINTS.charactersImport, { files: [{ path: 'card.json', content: '{}' }] }],
      [BRIDGE_ENDPOINTS.moduleMerge, { id: 'card' }],
      [BRIDGE_ENDPOINTS.moduleUnmerge, { id: 'card' }],
      [BRIDGE_ENDPOINTS.subagentToolPolicy, { policy: null }],
      [BRIDGE_ENDPOINTS.moduleCapability, { action: 'create', capabilityId: 'context-gate' }],
    ]
    for (const [endpoint, body] of cases) {
      const handler = handlers.get(PREFIX + endpoint)
      assert.ok(handler, `${endpoint} 端点应注册`)
      const res = fakeRes()
      await handler(fakeReq({ [Symbol.asyncIterator]: async function* () {
        yield Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
      } }), res)
      assert.equal(res.status, 403, endpoint)
      assert.equal(JSON.parse(res.body).code, 'module-readonly', endpoint)
      assert.equal(readFileSync(presetFile, 'utf8'), original, `${endpoint} 不得修改 system 预设`)
      assert.deepEqual(readdirSync(dir), ['module.yml'], `${endpoint} 不得创建 system 预设文件`)
    }
    for (const [body, status, code] of [[{ promptConfigs: [] }, 410, 'rules-route-retired'], [{ overrides: { modelTemperature: '0.2' } }, 403, 'module-readonly']]) {
      const retired = fakeRes()
      await handlers.get(PREFIX + BRIDGE_ENDPOINTS.paramOverrides)(fakeReq({ async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) } }), retired)
      assert.equal(retired.status, status)
      assert.equal(JSON.parse(retired.body).code, code)
      assert.equal(readFileSync(presetFile, 'utf8'), original)
      assert.deepEqual(readdirSync(dir), ['module.yml'])
    }
  } finally {
    rmSync(container, { recursive: true, force: true })
  }
})

test('settings bridge：请求体与角色卡流的字节上限常量', () => {
  assert.equal(MAX_BRIDGE_BODY_BYTES, 32 * 1024 * 1024)
  assert.equal(MAX_CHARACTER_CARD_STREAM_BYTES, 64 * 1024 * 1024)
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

test('/persona：已有启用独占规则时拒绝顶层人设独占，禁用规则不构成冲突', async () => {
  const { ctx, handlers } = makeHarness()
  const dir = makeUserPresetDir('pt-persona-complete-')
  let rebuilds = 0
  const file = join(dir, 'module.yml')
  const writeModule = enabled => writeFileSync(file, JSON.stringify({ id: basename(dir), modules: ['rule-engine'], rules: [textRule('exclusive-section', '独占段', { enabled, layer: 'system-section', params: { complete: true } })] }))
  try {
    registerSettingsBridge(ctx, 'prompt-tool', () => ({ available: true, providers: [] }), () => skillsStateStub(), () => '', undefined, () => dir, undefined, () => { rebuilds++ })
    const handler = handlers.get(PREFIX + BRIDGE_ENDPOINTS.persona)
    const post = async () => {
      const res = fakeRes()
      await handler(fakeReq({ async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ persona: { prefix: 'PREFIX', complete: true } })) } }), res)
      return res
    }
    writeModule(true)
    const before = readFileSync(file, 'utf8')
    const rejected = await post()
    assert.equal(rejected.status, 400)
    assert.equal(JSON.parse(rejected.body).code, 'module-persona-complete-conflict')
    assert.equal(readFileSync(file, 'utf8'), before)
    assert.equal(rebuilds, 0)
    writeModule(false)
    assert.equal((await post()).status, 200)
    assert.equal(parseYaml(readFileSync(file, 'utf8')).persona.complete, true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('/rules：顶层人设独占时拒绝启用独占规则，保留禁用边界和零写入', async () => {
  const { ctx, handlers } = makeHarness()
  const dir = makeUserPresetDir('pt-rules-complete-'), file = join(dir, 'module.yml')
  const id = basename(dir), rebuilds = []
  const definition = complete => ({ id, modules: ['rule-engine'], persona: { prefix: 'PREFIX', ...(complete ? { complete: true } : {}) }, rules: [] })
  const completeRule = enabled => textRule('exclusive-section', '独占段', { enabled, layer: 'system-section', params: { complete: true } })
  const call = async (body = {}) => {
    const res = fakeRes()
    await handlers.get(PREFIX + BRIDGE_ENDPOINTS.rules)(fakeReq({ async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ expectedModuleId: id, ...body })) } }), res)
    return { status: res.status, ...JSON.parse(res.body) }
  }
  const save = async enabled => call({ expectedRevisions: (await call()).value.revisions, edits: [{ previousId: null, rule: completeRule(enabled) }] })
  try {
    registerSettingsBridge(ctx, 'prompt-tool', () => ({ available: true, providers: [] }), () => skillsStateStub(), () => '', undefined, () => dir, undefined, target => { rebuilds.push(target) })
    writeFileSync(file, JSON.stringify(definition(false)))
    assert.equal((await save(true)).status, 200)
    assert.deepEqual(rebuilds, [id])
    writeFileSync(file, JSON.stringify(definition(true)))
    const before = readFileSync(file, 'utf8')
    const rejected = await save(true)
    assert.equal(rejected.status, 400)
    assert.equal(rejected.code, 'rules-invalid')
    assert.match(rejected.message, /complete|独占/)
    assert.equal(readFileSync(file, 'utf8'), before)
    assert.deepEqual(rebuilds, [id])
    assert.equal((await save(false)).status, 200)
    assert.deepEqual(rebuilds, [id, id])
  } finally { rmSync(dir, { recursive: true, force: true }) }
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
    const beforeWrite = refreshes
    const blocked = await postPolicy({ name: 'demo-skill', path: marker, scope: 'all' })
    assert.equal(blocked.status, 200, blocked.body.message)
    assert.equal(refreshes, beforeWrite + 1, '成功的策略写入触发一次刷新')
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
    const beforeRejected = refreshes
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
    // 被拒的 400/409 请求一次都不触发刷新（成功写入的增量已在上面逐处校验）。
    assert.equal(refreshes, beforeRejected, '被拒请求不触发刷新')

    // 恢复：两端回到可调用。
    const beforeRestore = refreshes
    const restored = await postPolicy({ name: 'demo-skill', path: marker, scope: 'none' })
    assert.equal(restored.status, 200, restored.body.message)
    const restoredEntry = restored.body.value.skills.find((skill) => skill.name === 'demo-skill')
    assert.deepEqual([restoredEntry.modelInvocable, restoredEntry.userInvocable], [true, true])
    assert.deepEqual(policyOf(marker), { modelInvocable: true, userInvocable: true })
    assert.match(readFileSync(marker, 'utf8'), /^disable-model-invocation: false$/m)
    assert.match(readFileSync(marker, 'utf8'), /^user-invocable: true$/m)
    assert.equal(refreshes, beforeRestore + 1, '恢复写入同样触发一次刷新')
    // 整轮写入都不得在技能目录里留下暂存文件。
    assert.deepEqual(readdirSync(join(root, 'demo-skill')), ['SKILL.md'])

    // 回收站删除：整个技能目录移入用户根下的 .system/prompt-tool/.trash。
    const beforeDelete = refreshes
    const removed = await postDelete({ name: 'demo-skill', path: marker })
    assert.equal(removed.status, 200, removed.body.message)
    assert.equal(existsSync(marker), false)
    const trash = readdirSync(join(root, '.system', 'prompt-tool', '.trash'))
    assert.equal(trash.length, 1)
    assert.equal(existsSync(join(root, '.system', 'prompt-tool', '.trash', trash[0], 'demo-skill', 'SKILL.md')), true, '技能目录可人工恢复')
    assert.equal((await postDelete({ folder: '../escape' })).status, 400)
    assert.equal((await postDelete({ folder: 'missing-skill' })).status, 400)
    assert.equal(refreshes, beforeDelete + 1, '回收站删除再触发一次刷新；紧随其后的 400 拒绝请求不触发')
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
