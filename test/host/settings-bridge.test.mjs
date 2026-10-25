import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'
import { makeHostContext } from '../fixtures/host-harness.mjs'

const bridgeHome = mkdtempSync(join(tmpdir(), 'pt-settings-bridge-home-'))
process.env.DSH_HOME = bridgeHome
// 技能扫描的其余来源一并隔离：不读到真实用户目录 / 真实内置技能目录。
process.env.DSH_AGENTS_HOME = join(bridgeHome, 'agents')
process.env.DSH_BUNDLED_SKILL_DIR = join(bridgeHome, 'bundled-skills')
const { BRIDGE_ENDPOINTS, MAX_BRIDGE_BODY_BYTES, MAX_CHARACTER_CARD_STREAM_BYTES } = await import('../../src/shared/bridge-contract.ts')
const { registerSettingsBridge } = await import('../../src/runtime/settings-bridge.ts')
const { catalogFromScan, scanRoots, skillRoots } = await import('../../src/host/skills-scan.ts')
const { readSkillInvocation, setSkillInvocation } = await import('../../src/host/skills-policy.ts')
const { readSkillsState, writeSkillsState } = await import('../../src/host/skills-config.ts')
const { deleteSkillTarget } = await import('../../src/host/skills-actions.ts')
const { storageRootOf } = await import('../../src/host/paths.ts')
const { moduleDeclarations } = await import('../../src/host/module-declarations.ts')
const declares = (dir, section) => moduleDeclarations(dir).has(section)
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
const userPresetRoot = join(storageRootOf(bridgeHome), 'modules')

let presetSequence = 0
function makeUserPresetDir(prefix) {
  mkdirSync(userPresetRoot, { recursive: true })
  const dir = join(userPresetRoot, `${prefix}${++presetSequence}`)
  mkdirSync(dir)
  return dir
}

/** 合并后的共享桩：端点表 + 请求体 → 状态与统一载荷；声明面两条用例共用（此前各抄一份）。 */
async function call(handlers, endpoint, body = {}) {
  const handler = handlers.get(PREFIX + BRIDGE_ENDPOINTS[endpoint])
  assert.ok(handler, `${endpoint} 端点应注册`)
  const res = fakeRes()
  await handler(fakeReq({ [Symbol.asyncIterator]: async function* () { yield Buffer.from(JSON.stringify(body)) } }), res)
  return { status: res.status, payload: JSON.parse(res.body) }
}

const textRule = (id, text, options = {}) => {
  const { enabled, ...config } = options
  return { id, layer: config.layer ?? 'pre-step', ...(enabled === undefined ? {} : { enabled }), then: [{ id: 'inject', kind: 'inject-text', config: { id, layer: 'pre-step', text, ...config } }] }
}
const requestRule = (id, patch) => ({ id, layer: 'agent-request', then: [{ id: 'request', kind: 'request-params', patch }] })

function makeHarness(services = {}, value = {}) {
  // 差异项：本文件要两个 namespace 的 describe（含宿主默认模型）与按名取服务；其余走 harness 默认值。
  return makeHostContext({
    value,
    describe: () => [
      { ns: 'prompt-tool', value, base: {} },
      { ns: 'agent-default-model', value: { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high' } },
    ],
    get: (name) => services[name],
  })
}

test('settings bridge /describe 无主语 400，有主语才返回宿主默认模型（agent-default-model 回显）', async () => {
  const dir = makeUserPresetDir('pt-describe-subject-')
  writeFileSync(join(dir, 'module.yml'), `id: ${basename(dir)}\nmodules: []\n`, 'utf8')
  const { ctx, handlers } = makeHarness()
  registerSettingsBridge(ctx, {
    ns: 'prompt-tool',
    models: () => ({ available: true, providers: ['deepseek-official'] }),
    skills: () => skillsStateStub(),
    moduleDirectory: (id) => id === undefined ? '' : dir,
  })
  const handler = handlers.get(PREFIX + BRIDGE_ENDPOINTS.describe)
  assert.ok(handler, 'describe 端点应注册')
  // describe 的主语就是模块段：无目标必须拒绝（策略表 required）。
  const noSubject = fakeRes()
  await handler(fakeReq(), noSubject)
  assert.equal(noSubject.status, 400)
  assert.equal(JSON.parse(noSubject.body).code, 'module-dir-unavailable')
  const res = fakeRes()
  await handler(fakeReq({ headers: { host: 'localhost', 'x-module-id': basename(dir) } }), res)
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
  registerSettingsBridge(ctx, {
    ns: 'prompt-tool',
    models: () => ({ available: true, providers: [] }),
    skills: () => skillsStateStub(),
  })
  const handler = handlers.get(`${PREFIX}/meta`)
  assert.ok(handler)
  const res = fakeRes()
  await handler(fakeReq(), res)
  assert.equal(res.status, 200)
  const payload = JSON.parse(res.body)
  assert.equal(payload.ok, true)
  assert.ok(payload.value.meta.layers.includes('pre-step'))
  assert.ok(payload.value.meta.strategies.includes('static'))
})

test('settings bridge /meta 逐模块下发同源事实：可编辑、算不出缺席、正文不外泄', async () => {
  const { ctx, handlers } = makeHarness()
  registerSettingsBridge(ctx, {
    ns: 'prompt-tool',
    models: () => ({ available: true, providers: [] }),
    skills: () => skillsStateStub(),
  })
  // 场景一：用户副本模块（显式 modules 清单）⇒ editable 真。
  const editableDir = makeUserPresetDir('facts-user-')
  const editableId = basename(editableDir)
  writeFileSync(join(editableDir, 'module.yml'), JSON.stringify({
    id: editableId,
    name: '可编辑副本',
    modules: ['rule-engine', 'tool-search'],
    rules: [textRule('body-row', 'TOP-SECRET-BODY')],
    persona: { main: { prefix: 'TOP-SECRET-PERSONA' } },
  }), 'utf8')
  // 场景二：组合源解析不到 ⇒ facts 在、editable 假（/meta 只列存储根，包内回退模块不在此列）。
  const unresolvedDir = makeUserPresetDir('facts-unresolved-')
  const unresolvedId = basename(unresolvedDir)
  writeFileSync(join(unresolvedDir, 'module.yml'), JSON.stringify({
    id: unresolvedId, name: '组合缺失', composition: 'no-such-composition',
  }), 'utf8')
  // 场景三：module.yml 不可解析 ⇒ broken 且 facts 缺席，且不让整个 /meta 失败。
  const brokenDir = makeUserPresetDir('facts-broken-')
  const brokenId = basename(brokenDir)
  writeFileSync(join(brokenDir, 'module.yml'), 'id: [unclosed\n', 'utf8')

  const res = fakeRes()
  await handlers.get(`${PREFIX}/meta`)(fakeReq(), res)
  assert.equal(res.status, 200)
  const byId = new Map(JSON.parse(res.body).value.meta.modules.map((entry) => [entry.id, entry]))

  const facts = byId.get(editableId).facts
  assert.equal(facts.editable, true)
  assert.equal(facts.sourceMode, 'explicit')
  assert.deepEqual(facts.declaredModules, ['rule-engine', 'tool-search'])
  assert.deepEqual(Object.keys(facts).sort(),
    ['declaredModules', 'editable', 'effectiveModules', 'rowIds', 'sourceMode'])
  assert.doesNotMatch(JSON.stringify(facts), /TOP-SECRET/)

  assert.equal(byId.get(unresolvedId).facts.editable, false)
  assert.equal(byId.get(unresolvedId).facts.sourceMode, 'unknown')

  assert.equal(typeof byId.get(brokenId).broken, 'string')
  assert.equal('facts' in byId.get(brokenId), false)
})

test('settings bridge /meta 下发声明面（顶层键名）：只声明 rules 的模块不含未声明节，损坏模块缺席', async () => {
  const rulesOnlyDir = makeUserPresetDir('declares-rules-')
  const rulesOnlyId = basename(rulesOnlyDir)
  writeFileSync(join(rulesOnlyDir, 'module.yml'),
    `id: ${rulesOnlyId}\nname: 规则模块\nmodules: []\nrules: []\n`, 'utf8')
  const brokenDir = makeUserPresetDir('declares-broken-')
  const brokenId = basename(brokenDir)
  writeFileSync(join(brokenDir, 'module.yml'), 'id: [unclosed\n', 'utf8')

  const { ctx, handlers } = makeHarness()
  registerSettingsBridge(ctx, {
    ns: 'prompt-tool',
    models: () => ({ available: true, providers: [] }),
    skills: () => skillsStateStub(),
  })
  const res = fakeRes()
  await handlers.get(`${PREFIX}/meta`)(fakeReq(), res)
  assert.equal(res.status, 200)
  const byId = new Map(JSON.parse(res.body).value.meta.modules.map((entry) => [entry.id, entry]))

  const declares = byId.get(rulesOnlyId).declares
  assert.ok(Array.isArray(declares), '/meta 必须逐模块下发 declares 键名数组')
  assert.equal(declares.includes('rules'), true)
  for (const section of ['customTools', 'persona', 'params', 'variables']) {
    assert.equal(declares.includes(section), false, `只声明 rules 的模块不含 ${section}`)
  }
  assert.doesNotMatch(JSON.stringify(declares), /TOP-SECRET/, '只下发键名，不下发内容')

  assert.equal('declares' in byId.get(brokenId), false, '损坏模块的声明面与 facts 同口径缺席')

  // 契约：包内五个真实模块的声明面（顶层键名）与设计文档 §7.4 实测一致。
  for (const id of ['ponytail', 'tool-surface', 'skill-surface', 'superpowers', 'ptc-mode']) {
    const real = moduleDeclarations(fileURLToPath(new URL(`../../modules/${id}`, import.meta.url)))
    for (const section of ['rules', 'modules']) assert.equal(real.has(section), true, `${id} 声明 ${section}`)
    for (const section of ['customTools', 'persona', 'variables', 'variablesEnabled', 'params', 'layerSettings']) {
      assert.equal(real.has(section), false, `${id} 未声明 ${section}（对应端点会 400 module-not-declared）`)
    }
  }
})

test('声明面：五个节的首次写入＝创建（无版本期望也 200），写后声明成立、读合法；已声明则仍要版本', async () => {
  const dir = makeUserPresetDir('create-first-')
  const id = basename(dir)
  const file = join(dir, 'module.yml')
  writeFileSync(file, `id: ${id}\nname: 创建测试\nmodules: []\nrules: []\n`, 'utf8')
  const { ctx, handlers } = makeHarness()
  registerSettingsBridge(ctx, {
    ns: 'prompt-tool',
    models: () => ({ available: true, providers: [] }),
    skills: () => skillsStateStub(),
    moduleDirectory: () => dir,
  })
  /** 判据与门的登记表同口径：该端点读写哪些节，任一「写前没有、写后存在」即算建立声明。 */
  const created = async (endpoint, sections, body) => {
    const before = readFileSync(file, 'utf8')
    assert.equal(sections.some((section) => declares(dir, section)), false, `${endpoint} 前置：未声明 ${sections.join('/')}`)
    const write = await call(handlers, endpoint, body)
    assert.equal(write.status, 200, `${endpoint} 创建写应 200：${JSON.stringify(write.payload)}`)
    assert.notEqual(readFileSync(file, 'utf8'), before, `${endpoint} 创建写必须落盘`)
    assert.equal(sections.some((section) => declares(dir, section)), true, `${endpoint} 写后声明成立（${sections.join('/')}）`)
    const read = await call(handlers, endpoint, endpoint === 'moduleVariables' ? { scope: 'module' } : {})
    assert.equal(read.status, 200, `${endpoint} 写后读应合法：${JSON.stringify(read.payload)}`)
  }

  const tool = { id: 'shell', description: '运行命令', output: { schema: { type: 'string' } }, execute: { kind: 'shell', command: 'echo' } }
  await created('customTools', ['customTools'], { customTools: [tool] })
  // 人设与变量：创建语义＝**不传版本期望**（客户端创建模式就该这么发；传空串会被当非法版本拒绝）。
  await created('persona', ['persona'], { persona: { main: { prefix: 'CREATED' } }, expectedModuleId: id })
  await created('moduleVariables', ['variables'], { scope: 'module', variables: { owner: 'created' }, expectedModuleId: id })
  // 引擎参数写的是 `layerSettings`（`engineParamPath`），登记表里 `params` 与 `layerSettings` 任一存在即算已声明。
  await created('paramOverrides', ['params', 'layerSettings'], { overrides: { modelTemperature: 0.3 } })

  // 有前状态就仍要版本期望：声明之后再省略版本必须被拒（创建语义不放宽并发校验）。
  // 拒法与写区外的校验同源，所以这里连状态码与 code 一起锁住——只断「不是 200」会漏掉状态码分类退化。
  const personaNoRevision = await call(handlers, 'persona', { persona: { main: { prefix: 'AGAIN' } }, expectedModuleId: id })
  assert.equal(personaNoRevision.status, 400, `已声明 persona 的写必须带读取版本：${JSON.stringify(personaNoRevision.payload)}`)
  assert.equal(personaNoRevision.payload.code, 'module-persona-rejected')
  const variablesNoRevisions = await call(handlers, 'moduleVariables', { scope: 'module', variables: { owner: 'again' }, expectedModuleId: id })
  assert.equal(variablesNoRevisions.status, 400, `已声明 variables 的写必须带读取版本：${JSON.stringify(variablesNoRevisions.payload)}`)
  assert.equal(variablesNoRevisions.payload.code, 'rules-invalid')
})

test('声明面：创建语义只认「版本期望整键缺席」——空串版本与空对象照旧拒绝（旧客户端载荷的 RED）', async () => {
  const dir = makeUserPresetDir('create-strict-')
  const id = basename(dir)
  writeFileSync(join(dir, 'module.yml'), `id: ${id}\nname: 严格创建\nmodules: []\nrules: []\n`, 'utf8')
  const { ctx, handlers } = makeHarness()
  registerSettingsBridge(ctx, { ns: 'prompt-tool', models: () => ({ available: true, providers: [] }),
    skills: () => skillsStateStub(), moduleDirectory: () => dir })
  const call = async (endpoint, body = {}) => {
    const res = fakeRes()
    await handlers.get(PREFIX + BRIDGE_ENDPOINTS[endpoint])(fakeReq({ [Symbol.asyncIterator]: async function* () {
      yield Buffer.from(JSON.stringify(body))
    } }), res)
    return { status: res.status, payload: JSON.parse(res.body) }
  }

  // 客户端创建模式曾经发出的两种形状都必须被拒：空串版本、空的 expectedRevisions 对象。
  const personaEmpty = await call('persona', { persona: { main: { prefix: 'X' } }, expectedModuleId: id, expectedRevision: '' })
  assert.equal(personaEmpty.status, 400, `空串版本必须拒绝：${JSON.stringify(personaEmpty.payload)}`)
  const variablesEmpty = await call('moduleVariables', { scope: 'module', variables: { k: 'v' }, expectedModuleId: id, expectedRevisions: {} })
  assert.equal(variablesEmpty.status, 400, `空 expectedRevisions 必须拒绝：${JSON.stringify(variablesEmpty.payload)}`)
  assert.equal(declares(dir, 'persona'), false, '被拒的写不建立声明')
  assert.equal(declares(dir, 'variables'), false, '被拒的写不建立声明')

  // 对照（同一未声明模块）：整键缺席＝创建，照旧 200 并建立声明。
  const personaCreated = await call('persona', { persona: { main: { prefix: 'X' } }, expectedModuleId: id })
  assert.equal(personaCreated.status, 200, JSON.stringify(personaCreated.payload))
  const variablesCreated = await call('moduleVariables', { scope: 'module', variables: { k: 'v' }, expectedModuleId: id })
  assert.equal(variablesCreated.status, 200, JSON.stringify(variablesCreated.payload))
  assert.equal(declares(dir, 'variables'), true)
})

test('settings bridge /bootstrap 的模块段按声明出现：未声明的节整键缺席，声明的节照旧下发', async () => {
  const rulesOnly = makeUserPresetDir('boot-declares-rules-')
  const declared = makeUserPresetDir('boot-declares-all-')
  writeFileSync(join(rulesOnly, 'module.yml'),
    `id: ${basename(rulesOnly)}\nname: 只声明规则\nmodules: []\nrules: []\n`, 'utf8')
  writeFileSync(join(declared, 'module.yml'),
    `id: ${basename(declared)}\nname: 全声明\nmodules: []\nrules: []\nparams: {}\nvariables: { k: v }\n`, 'utf8')
  let dir = rulesOnly
  const { ctx, handlers } = makeHarness()
  registerSettingsBridge(ctx, {
    ns: 'prompt-tool',
    models: () => ({ available: true, providers: [] }),
    skills: () => skillsStateStub(),
    moduleDirectory: () => dir,
  })
  const boot = async () => {
    const res = fakeRes()
    await handlers.get(PREFIX + BRIDGE_ENDPOINTS.bootstrap)(fakeReq({
      headers: { host: 'localhost', 'x-module-id': basename(dir) },
      [Symbol.asyncIterator]: async function* () { yield Buffer.from(JSON.stringify({})) },
    }), res)
    assert.equal(res.status, 200, res.body)
    return JSON.parse(res.body)
  }

  const undeclared = await boot()
  assert.equal('moduleParams' in undeclared, false, '未声明 params → moduleParams 整键缺席（不是空对象）')
  assert.equal('variables' in undeclared, false, '未声明 variables → 变量段缺席')
  assert.ok(undeclared.moduleFacts !== undefined, 'moduleFacts 不受声明面影响（身份与引擎事实照旧）')

  dir = declared
  const withSections = await boot()
  assert.ok('moduleParams' in withSections, '声明了 params → 参数段在场')
  assert.ok('variables' in withSections, '声明了 variables → 变量段在场')
  assert.deepEqual(withSections.variables.module, { k: 'v' })
})

test('settings bridge /skills-import 写入技能文件并触发目录刷新回调', async () => {
  const dir = mkdtempSync(join(tmpdir(), `pt-skills-import-${process.pid}-`))
  let refreshes = 0
  try {
    const { ctx, handlers } = makeHarness()
    registerSettingsBridge(ctx, {
      ns: 'prompt-tool',
      models: () => ({ available: true, providers: [] }),
      skills: () => skillsStateStub({ skillsRoot: dir }),
        afterSkillsChange: () => { refreshes += 1 },
    })
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
  registerSettingsBridge(ctx, { ns: 'prompt-tool', models: () => ({ available: false, providers: [] }),
    skills: () => skillsStateStub({ skillsRoot: root }), afterSkillsChange: () => { refreshes += 1 } })
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
  // 声明面：顶层 `variables` 键必须存在，模块变量端点才可用（键整个不存在＝没声明）。
  writeFileSync(file, `# keep comment\nid: ${basename(dir)}\nparams: ${JSON.stringify(params)}\nlayerSettings: ${JSON.stringify(layerSettings)}\nvariables: {}\n`, 'utf8')
  registerSettingsBridge(ctx, { ns: 'prompt-tool', models: () => ({ available: true, providers: [] }),
    skills: () => skillsStateStub(), moduleDirectory: () => dir })
  const write = handlers.get(PREFIX + BRIDGE_ENDPOINTS.moduleVariables)
  const variableRequest = (body = {}) => fakeReq({ async *[Symbol.asyncIterator]() {
    yield Buffer.from(JSON.stringify({ scope: 'module', expectedModuleId: basename(dir), ...body }))
  } })
  for (const variables of [{ toolGitBashEnabled: 'text', strReplaceEditorMaxOutputChars: '' }, {}]) {
    const initial = fakeRes()
    await write(variableRequest(), initial)
    const expectedRevisions = JSON.parse(initial.body).value.revisions
    const res = fakeRes()
    await write(variableRequest({ variables, expectedRevisions }), res)
    assert.equal(res.status, 200)
    const saved = parseYaml(readFileSync(file, 'utf8'))
    assert.deepEqual(saved.params, params)
    assert.deepEqual(saved.layerSettings, layerSettings)
    assert.deepEqual(saved.variables ?? {}, variables)
    assert.match(readFileSync(file, 'utf8'), /# keep comment/)
    const read = fakeRes()
    await write(variableRequest(), read)
    assert.equal(read.status, 200)
    assert.deepEqual(JSON.parse(read.body).value.module, variables)
    assert.equal(JSON.parse(read.body).value.enabled, true)
    assert.match(JSON.parse(read.body).value.revisions.module, /^[a-f0-9]{64}$/)
    const bootstrap = fakeRes()
    await handlers.get(PREFIX + BRIDGE_ENDPOINTS.bootstrap)(fakeReq(), bootstrap)
    assert.equal(bootstrap.status, 200)
    assert.deepEqual(JSON.parse(bootstrap.body).variables.module, variables)
    assert.equal(JSON.parse(bootstrap.body).variables.enabled, true)
    assert.deepEqual(JSON.parse(bootstrap.body).variables.revisions, JSON.parse(read.body).value.revisions)
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
  registerSettingsBridge(ctx, { ns: 'prompt-tool', models: () => ({ available: true, providers: [] }),
    skills: () => skillsStateStub(),
    moduleDirectory: (id) => id === undefined ? '' : (id === idA ? requestedDir : dirB), overridesChanged: (id) => { rebuilt.push(id) } })
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
      assert.deepEqual(Object.keys(payload.moduleFacts).sort(),
        ['declaredModules', 'editable', 'effectiveModules', 'rowIds', 'sourceMode'],
        '模块事实只含白名单字段，不夹带行级配置')
      assert.equal(payload.templatePreStepCount, 1)
      if (endpoint === 'bootstrap') {
        assert.deepEqual(payload.overrides.overrides, {})
        assert.deepEqual(payload.variables.module, { owner: 'A' })
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
    assert.equal(noHeader.payload.value.value.moduleId, undefined, '无目标时不再回退到别的模块目录')
    const noTarget = await call('rules', { expectedModuleId: idB }, { target: undefined })
    assert.equal(noTarget.payload.code, 'module-dir-unavailable', '无声明即无目标，不回退启用表首项')
    assert.equal(noTarget.status, 400)
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
    assert.equal(rejected.status, 400)
    assert.equal(rejected.payload.code, 'module-subject-conflict', '头声明 A 而载荷声明 B = 两个主语，不是目标被换')
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
  await t.test('请求中途目标目录消失：按当次解析拒绝为无目标', async () => {
    requestedDir = dirA
    const beforeA = readFileSync(fileA, 'utf8'), beforeB = readFileSync(fileB, 'utf8')
    const revisions = (await call('rules')).payload.value.revisions
    // 声明过 A、请求处理期间 A 的目录不再可解析（被删/改名）：按当次解析拒绝，不写另一个模块。
    const vanished = await call('rules', { expectedRevisions: revisions, edits: [{ previousId: 'model', rule: requestRule('model', { temperature: 0.7 }) }] },
      { onRead: () => { requestedDir = '' } })
    assert.equal(vanished.status, 400)
    assert.equal(vanished.payload.code, 'module-dir-unavailable')
    assert.equal(readFileSync(fileA, 'utf8'), beforeA)
    assert.equal(readFileSync(fileB, 'utf8'), beforeB)
    requestedDir = dirA
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
  const { ctx, handlers } = makeHarness({}, { modulesEnabled: false })
  const rebuilt = []
  let beforeRebuild = async () => {}
  registerSettingsBridge(ctx, { ns: 'prompt-tool', models: () => ({ available: true, providers: [] }),
    skills: () => skillsStateStub(), moduleDirectory: () => dirs[0],
    overridesChanged: async (id) => { await beforeRebuild(id); rebuilt.push(id) } })
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
    assert.deepEqual((await call('moduleConfigOrder')).value.entries, snapshot.entries, '默认全局列表仍只含启用模块')
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
    assert.deepEqual(result.value.entries, snapshot.entries)
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
    const unknownField = await call('moduleConfigOrder', { expectedRevision: snapshot.revision, entries, text: 'FORBIDDEN' })
    assert.equal(unknownField.status, 400)
    assert.equal(unknownField.code, 'bridge-request-invalid', '顶层未知字段统一由字段表拒绝')
    assert.deepEqual(dirs.map((dir) => readFileSync(join(dir, 'module.yml'), 'utf8')), before)
    assert.equal(rebuilt.length, count)
  })

  await t.test('追加失败不启用；定义已保存而重建失败回 200 + 待发布', async () => {
    assert.equal((await call('moduleEnable', { id: ids[2], enabled: true })).ok, false)
    assert.equal(enabledModuleIds(userPresetRoot).includes(ids[2]), false)
    beforeRebuild = async () => { throw new Error('MATERIALIZE_FAILED') }
    const rebuildCount = rebuilt.filter(id => id === ids[3]).length
    const failedEnable = await call('moduleEnable', { id: ids[3], enabled: true })
    assert.equal(failedEnable.status, 200)
    assert.equal(failedEnable.value.publicationPending, true)
    assert.equal(enabledModuleIds(userPresetRoot).includes(ids[3]), false)
    beforeRebuild = async () => {}
    assert.equal((await call('moduleEnable', { id: ids[3], enabled: true })).status, 200)
    assert.equal(rebuilt.filter(id => id === ids[3]).length, rebuildCount + 1, '上次已分配序号但物化失败，重试仍必须成功物化目标')
    await call('moduleEnable', { id: ids[3], enabled: false })
    beforeRebuild = async () => { throw new Error('MATERIALIZE_FAILED') }
    const result = await call('moduleConfigOrder', { expectedRevision: snapshot.revision, entries: identities(snapshot).reverse() })
    assert.equal(result.status, 200)
    assert.equal(result.value.publicationPending, true)
    assert.match(result.value.publicationError, /已保存/)
    assert.deepEqual(result.value.entries.map((entry) => entry.moduleId), [ids[0], ids[1]])
  })
})

test('契约：9 个曾由 handler 拒绝的端点统一拒绝未知顶层字段', async () => {
  const dir = makeUserPresetDir('pt-unknown-fields-')
  writeFileSync(join(dir, 'module.yml'), `id: ${basename(dir)}\nmodules: []\n`, 'utf8')
  const { ctx, handlers } = makeHarness()
  registerSettingsBridge(ctx, { ns: 'prompt-tool', models: () => ({ available: true, providers: [] }), skills: () => skillsStateStub(), moduleDirectory: () => dir })
  for (const endpoint of ['assetRelease', 'exportModule', 'importModulePackage', 'moduleConfigOrder', 'moduleName', 'moduleVariables', 'persona', 'personaSources', 'rules']) {
    const result = await call(handlers, endpoint, { extra: 1 })
    assert.equal(result.status, 400, endpoint)
    assert.equal(result.payload.code, 'bridge-request-invalid', endpoint)
    assert.match(result.payload.message, /未知请求字段：extra/, endpoint)
  }
})

test('模块写队列：两个并发写不交错——后入队的写按先入队者已落盘的结果继续', async (t) => {
  const { setModuleEnabled } = await import('../../src/host/config-store.ts')
  const dirs = ['queue-first-', 'queue-second-'].map(makeUserPresetDir)
  const ids = dirs.map((dir) => basename(dir))
  for (const [index, dir] of dirs.entries()) {
    writeFileSync(join(dir, 'module.yml'), JSON.stringify({ id: ids[index], modules: ['rule-engine'], rules: [textRule('card', `BODY ${index}`)] }))
  }
  t.after(() => ids.forEach((id) => setModuleEnabled(userPresetRoot, id, false)))
  const { ctx, handlers } = makeHarness({}, { modulesEnabled: false })
  let beforeRebuild = async () => {}
  registerSettingsBridge(ctx, { ns: 'prompt-tool', models: () => ({ available: true, providers: [] }),
    skills: () => skillsStateStub(), moduleDirectory: () => dirs[0],
    overridesChanged: async (id) => { await beforeRebuild(id) } })
  const call = async (endpoint, body) => {
    const handler = handlers.get(PREFIX + BRIDGE_ENDPOINTS[endpoint])
    assert.equal(typeof handler, 'function', `${endpoint} 端点已注册`)
    const res = fakeRes()
    await handler(fakeReq({ async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) } }), res)
    return { status: res.status, ...JSON.parse(res.body) }
  }

  // 闸门只卡第一个写：串行队列下第二个写根本进不到重建回调，也就绕不过这个闸门。
  let entered, openGate
  const parked = new Promise((resolve) => { entered = resolve })
  const gate = new Promise((resolve) => { openGate = resolve })
  let blocked = false
  beforeRebuild = async () => { if (blocked) return; blocked = true; entered(); await gate }

  const first = call('moduleEnable', { id: ids[0], enabled: true })
  await parked
  // 不 await 第一个就发第二个：同一队列上的两个并发写。
  const second = call('moduleEnable', { id: ids[1], enabled: true })
  // 不串行时第二个写会趁第一个卡在闸门里自己跑完（此刻它的效果只可能基于「第一个还没落地」的状态）。
  // shortcut: 200ms 只是串行实现下放行闸门的兜底；两种实现下断言都不依赖这个时长。
  await Promise.race([second.catch(() => {}), new Promise((resolve) => setTimeout(resolve, 200))])
  openGate()
  const [firstSaved, secondSaved] = await Promise.all([first, second])
  assert.equal(firstSaved.status, 200, firstSaved.message)
  assert.equal(secondSaved.status, 200, secondSaved.message)
  // 规格「先入队的写先落地」：第二个写的响应里必须已经有第一个写的效果。
  assert.deepEqual(secondSaved.value.enabled, ids, '第二个写必须看到第一个写已启用')
  // 落盘产物同源：后入队的配置卡让开先入队者占用的槽位（同一读改写里没被交错覆盖）。
  assert.deepEqual(dirs.map((dir) => parseYaml(readFileSync(join(dir, 'module.yml'), 'utf8')).configOrder),
    [{ card: 0 }, { card: 10 }], '先入队者拿 0，后入队者接在尾部')
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
    registerSettingsBridge(ctx, {
      ns: 'prompt-tool',
      models: () => ({ available: true, providers: [] }),
      skills: () => skillsStateStub(),
        moduleDirectory: () => activeDir,
      moduleInstalled: (id) => { importedIds.push(id) },
      moduleListChanged: () => { registryRefreshes++ },
    })
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
  // 声明面：`params` 是「写路径不查、读路径要查」的那一侧——这个用例的 `{promptConfigs: []}` 是读模式请求，
  // 要先过声明面才会走到 410；其余写请求在新语义下由写路径直达 403，不需要预先声明。
  const original = 'id: system\nmodules: []\nrules: []\nparams: {}\n'
  writeFileSync(presetFile, original, 'utf8')
  try {
    const { ctx, handlers } = makeHarness()
    registerSettingsBridge(ctx, {
      ns: 'prompt-tool',
      models: () => ({ available: true, providers: [] }),
      skills: () => skillsStateStub(),
        moduleDirectory: () => dir,
    })
    const rulesRead = fakeRes()
    await handlers.get(PREFIX + BRIDGE_ENDPOINTS.rules)(fakeReq({ async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ expectedModuleId: basename(dir) })) } }), rulesRead)
    assert.equal(rulesRead.status, 200, rulesRead.body)
    const revisions = JSON.parse(rulesRead.body).value.revisions
    const cases = [
      [BRIDGE_ENDPOINTS.rules, { expectedModuleId: basename(dir), expectedRevisions: revisions, edits: [{ previousId: null, rule: textRule('readonly', 'FORBIDDEN') }] }],
      [BRIDGE_ENDPOINTS.moduleVariables, { scope: 'module', expectedModuleId: basename(dir), variables: { empty: '' }, enabled: true, expectedRevisions: { module: revisions.variables, settings: revisions.settings } }],
      [BRIDGE_ENDPOINTS.customTools, { customTools: [] }],
      [BRIDGE_ENDPOINTS.moduleCapability, { action: 'create', capabilityId: 'module-variable-tools' }],
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
    // 声明面：写路径不查声明面，所以这里刻意不预先声明 `customTools`——写会建立该节。
    writeFileSync(join(dir, 'module.yml'), [`id: ${basename(dir)}`, 'modules: []', ''].join(String.fromCharCode(10)), 'utf8')
    const { ctx, handlers } = makeHarness()
    registerSettingsBridge(ctx, {
      ns: 'prompt-tool',
      models: () => ({ available: true, providers: [] }),
      skills: () => skillsStateStub(),
        moduleDirectory: () => dir,
      overridesChanged: () => {},
    })
    const handler = handlers.get(PREFIX + BRIDGE_ENDPOINTS.customTools)
    assert.ok(handler, '/custom-tools 端点应注册')
    const payload = Buffer.from(JSON.stringify({ customTools: [
      { id: 'shell', description: '运行命令', output: { schema: { type: 'string' } }, execute: { kind: 'shell', command: 'echo' } },
      { id: 'rules', description: '写入模块规则', output: { schema: { type: 'json' } }, execute: { kind: 'delegate', tool: 'module_rules_edit' } },
    ] }))
    const res = fakeRes()
    await handler(fakeReq({ [Symbol.asyncIterator]: async function* () { yield payload } }), res)
    assert.equal(res.status, 200)
    const parsed = parseYaml(readFileSync(join(dir, 'module.yml'), 'utf8'))
    assert.deepEqual(parsed.modules, ['tool-config-engine', 'module-rule-tools'], '只装配自定义工具实际依赖的模块')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('settings bridge /persona 读写顶层 persona 段并按实际模块身份重建', async () => {
  const { ctx, handlers } = makeHarness()
  const dir = makeUserPresetDir('pt-persona-')
  // 声明面：顶层 `persona` 键存在，读通道才可用（键整个不存在＝没声明）。
  writeFileSync(join(dir, 'module.yml'), `id: ${basename(dir)}\nname: beta\nunknown: keep\npersona: ${JSON.stringify({ main: { prefix: 'INITIAL' } })}\n`, 'utf8')
  const rebuilds = []
  try {
    registerSettingsBridge(ctx, {
      ns: 'prompt-tool',
      models: () => ({ available: true, providers: [] }),
      skills: () => skillsStateStub(),
        moduleDirectory: () => dir,
      overridesChanged: (id) => { rebuilds.push(id) },
    })
    const handler = handlers.get(PREFIX + BRIDGE_ENDPOINTS.persona)
    assert.ok(handler, '/persona 端点应注册')
    const initial = fakeRes()
    await handler(fakeReq(), initial)
    const expectedRevision = JSON.parse(initial.body).value.revision
    const write = fakeRes()
    await handler(fakeReq({ [Symbol.asyncIterator]: async function* () {
      yield Buffer.from(JSON.stringify({ expectedModuleId: basename(dir), expectedRevision, persona: { main: { prefix: '', suffix: 'SUFFIX', complete: false }, subagent: { complete: true, includeRuntimeContext: false } } }))
    } }), write)
    assert.equal(write.status, 200)
    const written = parseYaml(readFileSync(join(dir, 'module.yml'), 'utf8'))
    assert.deepEqual(written.persona, { main: { prefix: '', suffix: 'SUFFIX', complete: false }, subagent: { complete: true, includeRuntimeContext: false } })
    assert.equal(written.unknown, 'keep', '未知字段保留')
    assert.deepEqual(rebuilds, [basename(dir)], '写盘后把实际模块身份交给运行时')
    const stale = fakeRes()
    const savedBytes = readFileSync(join(dir, 'module.yml'))
    await handler(fakeReq({ [Symbol.asyncIterator]: async function* () {
      yield Buffer.from(JSON.stringify({ expectedModuleId: basename(dir), persona: null, expectedRevision }))
    } }), stale)
    assert.equal(stale.status, 409)
    assert.deepEqual(readFileSync(join(dir, 'module.yml')), savedBytes)
    // 无 persona 载荷 = 读取。
    const read = fakeRes()
    await handler(fakeReq(), read)
    assert.equal(read.status, 200)
    assert.deepEqual(JSON.parse(read.body).value.persona, written.persona)
    // persona: null = 移除顶层段。
    const remove = fakeRes()
    await handler(fakeReq({ [Symbol.asyncIterator]: async function* () {
      yield Buffer.from(JSON.stringify({ expectedModuleId: basename(dir), persona: null, expectedRevision: JSON.parse(read.body).value.revision }))
    } }), remove)
    assert.equal(remove.status, 200)
    assert.equal(parseYaml(readFileSync(join(dir, 'module.yml'), 'utf8')).persona, undefined)
    assert.deepEqual(rebuilds, [basename(dir), basename(dir)])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('/persona：未选人设可以保存独占字段，发布失败保留定义且只重试刷新', async () => {
  const { ctx, handlers } = makeHarness()
  const dir = makeUserPresetDir('pt-persona-complete-')
  let rebuilds = 0, failPublication = false
  const file = join(dir, 'module.yml')
  const writeModule = enabled => writeFileSync(file, JSON.stringify({ id: basename(dir), modules: ['rule-engine'], persona: { main: { prefix: 'INITIAL' } }, rules: [textRule('exclusive-section', '独占段', { enabled, layer: 'system-section', params: { complete: true } })] }))
  try {
    registerSettingsBridge(ctx, { ns: 'prompt-tool', models: () => ({ available: true, providers: [] }), skills: () => skillsStateStub(), moduleDirectory: () => dir, overridesChanged: () => { rebuilds++; if (failPublication) throw new Error('publication unavailable') } })
    const handler = handlers.get(PREFIX + BRIDGE_ENDPOINTS.persona)
    const post = async () => {
      const read = fakeRes()
      await handler(fakeReq(), read)
      const res = fakeRes()
      await handler(fakeReq({ async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ expectedModuleId: basename(dir), expectedRevision: JSON.parse(read.body).value.revision, persona: { main: { prefix: 'PREFIX', complete: true } } })) } }), res)
      return res
    }
    writeModule(true)
    assert.equal((await post()).status, 200)
    assert.equal(rebuilds, 1, '写盘成功后按实际模块身份重建')
    assert.equal(parseYaml(readFileSync(file, 'utf8')).persona.main.complete, true)
    failPublication = true
    const pending = JSON.parse((await post()).body).value
    assert.equal(pending.persisted, true)
    assert.equal(pending.publicationPending, true)
    assert.match(pending.publicationError, /publication unavailable/)
    const saved = readFileSync(file)
    failPublication = false
    const refreshed = fakeRes()
    await handler(fakeReq({ async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ expectedModuleId: basename(dir), refreshOnly: true })) } }), refreshed)
    assert.equal(JSON.parse(refreshed.body).value.publicationPending, false)
    assert.deepEqual(readFileSync(file), saved, '刷新不重写已提交正文')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('/persona-sources：主子来源独立于编辑模块，保存不启用规则，发布失败可只重试', async () => {
  const { ctx, handlers } = makeHarness()
  const alpha = makeUserPresetDir('pt-source-main-'), beta = makeUserPresetDir('pt-source-child-')
  const { readPersonaSources, writePersonaSources, selectedPersonaModules } = await import('../../src/host/persona-selection.ts')
  const { enabledModuleIds, enableTablePath } = await import('../../src/host/config-store.ts')
  const original = readPersonaSources(userPresetRoot).sources, enabled = enabledModuleIds(userPresetRoot)
  const rebuilds = []
  let failPublication = false
  for (const [dir, prefix] of [[alpha, 'ALPHA'], [beta, 'BETA']]) writeFileSync(join(dir, 'module.yml'), JSON.stringify({ id: basename(dir), modules: [], rules: [], persona: { main: { prefix: prefix + '-MAIN' }, subagent: { prefix: prefix + '-CHILD' } } }))
  try {
    registerSettingsBridge(ctx, { ns: 'prompt-tool', models: () => ({ available: true, providers: [] }), skills: () => skillsStateStub(), moduleDirectory: () => '', overridesChanged: target => { rebuilds.push(target); if (failPublication) throw new Error('runtime unavailable') } })
    const post = skillsPost(handlers, 'personaSources')
    const initial = await post({})
    assert.equal(initial.status, 200)
    const sources = { main: basename(alpha), subagent: basename(beta) }
    failPublication = true
    const saved = await post({ sources, expectedRevision: initial.body.value.revision })
    assert.equal(saved.status, 200)
    assert.deepEqual(saved.body.value.sources, sources)
    assert.equal(saved.body.value.persisted, true)
    assert.equal(saved.body.value.publicationPending, true)
    assert.deepEqual(enabledModuleIds(userPresetRoot), enabled)
    assert.deepEqual(selectedPersonaModules(userPresetRoot).map(item => item.persona), [{ main: { prefix: 'ALPHA-MAIN' } }, { subagent: { prefix: 'BETA-CHILD' } }])
    const file = enableTablePath(userPresetRoot), bytes = readFileSync(file)
    assert.equal((await post({ sources, expectedRevision: initial.body.value.revision })).status, 409)
    assert.deepEqual(readFileSync(file), bytes)
    failPublication = false
    const refreshed = await post({ refreshOnly: true })
    assert.equal(refreshed.body.value.publicationPending, false)
    assert.equal(refreshed.body.value.revision, saved.body.value.revision)
    assert.deepEqual(rebuilds, [undefined, undefined], '来源变化刷新全部 Agent')
    assert.deepEqual(readFileSync(file), bytes, '发布重试不重写来源配置')
    const cleared = await post({ sources: { main: null, subagent: null }, expectedRevision: saved.body.value.revision })
    assert.equal(cleared.status, 200)
    assert.deepEqual(cleared.body.value.sources, { main: null, subagent: null })
    assert.deepEqual(enabledModuleIds(userPresetRoot), enabled)
  } finally {
    writePersonaSources(userPresetRoot, original, readPersonaSources(userPresetRoot).revision)
    for (const dir of [alpha, beta]) rmSync(dir, { recursive: true, force: true })
  }
})

test('/persona-sources：非法载荷和远端请求零写入，在用人设模块不能删除', async () => {
  const { ctx, handlers } = makeHarness()
  const dir = makeUserPresetDir('pt-source-protected-'), id = basename(dir)
  const { readPersonaSources, writePersonaSources } = await import('../../src/host/persona-selection.ts')
  const { enableTablePath } = await import('../../src/host/config-store.ts')
  const original = readPersonaSources(userPresetRoot).sources
  writeFileSync(join(dir, 'module.yml'), JSON.stringify({ id, modules: [], rules: [], persona: { main: { prefix: 'PRESERVE' } } }))
  try {
    registerSettingsBridge(ctx, { ns: 'prompt-tool', models: () => ({ available: true, providers: [] }), skills: () => skillsStateStub(), moduleDirectory: () => '' })
    const post = skillsPost(handlers, 'personaSources')
    const selection = writePersonaSources(userPresetRoot, { main: id, subagent: null }, readPersonaSources(userPresetRoot).revision)
    const bytes = readFileSync(enableTablePath(userPresetRoot))
    for (const body of [
      { sources: { main: id, subagent: null } },
      { sources: { main: '../escape', subagent: null }, expectedRevision: selection.revision },
      { sources: { main: 'missing-source', subagent: null }, expectedRevision: selection.revision },
      { sources: { main: id }, expectedRevision: selection.revision },
      { sources: { main: null, subagent: null }, expectedRevision: selection.revision, refreshOnly: true },
      { sources: { main: null, subagent: null }, expectedRevision: selection.revision, extra: true },
    ]) assert.notEqual((await post(body)).status, 200)
    const remote = fakeRes()
    await handlers.get(PREFIX + BRIDGE_ENDPOINTS.personaSources)(fakeReq({ socket: { remoteAddress: '192.168.1.4' } }), remote)
    assert.equal(remote.status, 403)
    assert.deepEqual(readFileSync(enableTablePath(userPresetRoot)), bytes)
    const removed = await skillsPost(handlers, 'moduleDelete')({ id })
    assert.equal(removed.status, 400)
    assert.match(removed.body.message, /人设|persona/)
    assert.equal(existsSync(join(dir, 'module.yml')), true)
  } finally {
    writePersonaSources(userPresetRoot, original, readPersonaSources(userPresetRoot).revision)
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
    registerSettingsBridge(ctx, { ns: 'prompt-tool', models: () => ({ available: true, providers: [] }),
      skills: () => skillsStateStub({ skillsRoot: root, listSkills, setSkillPolicy }), afterSkillsChange: () => { refreshes += 1 } })
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
    registerSettingsBridge(ctx, { ns: 'prompt-tool', models: () => ({ available: true, providers: [] }),
      skills: () => skillsStateStub({
        skillsRoot: root,
        listSkills,
        patchSkillFolders: (folders) => writeSkillsState({ folders }, stateFile),
      }) })
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

test('归属门：形状豁免只对「编辑目标当身份用」的端点生效——坏定义仍可删模块、可切总闸', async () => {
  const brokenDir = makeUserPresetDir('pt-broken-subject-')
  const brokenId = basename(brokenDir)
  // 活动模块的定义不可解析：形状核（loadModuleDefinition/readModuleLayerSettings）必然失败。
  writeFileSync(join(brokenDir, 'module.yml'), 'id: [unclosed\n', 'utf8')
  const otherDir = makeUserPresetDir('pt-delete-target-')
  const otherId = basename(otherDir)
  writeFileSync(join(otherDir, 'module.yml'), `id: ${otherId}\nmodules: []\n`, 'utf8')
  const { ctx, handlers } = makeHarness()
  registerSettingsBridge(ctx, {
    ns: 'prompt-tool',
    models: () => ({ available: true, providers: [] }),
    skills: () => skillsStateStub(),
    moduleDirectory: () => brokenDir,
  })
  const call = async (endpoint, body) => {
    const handler = handlers.get(PREFIX + BRIDGE_ENDPOINTS[endpoint])
    assert.ok(handler, `${endpoint} 端点应注册`)
    const res = fakeRes()
    await handler(fakeReq({ [Symbol.asyncIterator]: async function* () {
      yield Buffer.from(JSON.stringify(body))
    } }), res)
    return { status: res.status, payload: JSON.parse(res.body) }
  }

  // 对照：模块类读端点仍核形状（豁免不是「坏定义一律放行」）。
  const denied = await call('rules', { expectedModuleId: brokenId })
  assert.equal(denied.status, 400, `rules 读仍须核形状：${JSON.stringify(denied.payload)}`)
  assert.equal(denied.payload.ok, false)

  // 豁免一：坏定义不挡全局总闸保存（mutate 只把目标当 descriptor 投影）。
  const toggled = await call('mutate', { ops: [{ op: 'set', path: ['modulesEnabled'], value: true }] })
  assert.equal(toggled.status, 200, `总闸保存不该被坏模块挡住：${JSON.stringify(toggled.payload)}`)

  // 豁免二：坏定义仍可删除**另一个**模块（moduleDelete 只把目标当「在用」判据）。
  const deleted = await call('moduleDelete', { id: otherId })
  assert.equal(deleted.status, 200, `坏模块不该让别的模块删不掉：${JSON.stringify(deleted.payload)}`)
  assert.equal(existsSync(otherDir), false)
})

test('声明面：读没声明 400 module-not-declared，写路径建立声明，任一节存在即算已声明，解析失败不降级', async () => {
  const undeclared = makeUserPresetDir('pt-declares-missing-')
  const declared = makeUserPresetDir('pt-declares-empty-')
  const broken = makeUserPresetDir('pt-declares-broken-')
  writeFileSync(join(undeclared, 'module.yml'), `id: ${basename(undeclared)}\nmodules: []\nrules: []\n`, 'utf8')
  writeFileSync(join(declared, 'module.yml'), `id: ${basename(declared)}\nmodules: []\ncustomTools: []\nlayerSettings: {}\n`, 'utf8')
  writeFileSync(join(broken, 'module.yml'), `id: ${basename(broken)}\nrules: [unclosed\n`, 'utf8')
  let dir = undeclared
  const { ctx, handlers } = makeHarness()
  registerSettingsBridge(ctx, { ns: 'prompt-tool', models: () => ({ available: true, providers: [] }),
    skills: () => skillsStateStub(), moduleDirectory: () => dir })

  const before = readFileSync(join(undeclared, 'module.yml'), 'utf8')
  // 声明面逐节：每个节端点自己那条 400 都要在场——逐节断言（不是遇错即停），
  // 缺哪一节就红在哪一节；端点的策略值/登记表不再由 shared 快照守，这里就是它们的行为面判据。
  const undeclaredSections = [
    ['customTools', 'customTools'],
    ['persona', 'persona'],
  ]
  for (const [endpoint, sections] of undeclaredSections) {
    const denied = await call(handlers, endpoint)
    assert.equal(denied.status, 400, `未声明 ${sections} 必须拒绝：${JSON.stringify(denied.payload)}`)
    assert.equal(denied.payload.code, 'module-not-declared', `${endpoint} 的错误码`)
    assert.match(denied.payload.message, new RegExp(sections), `${endpoint} 的 message 要点名缺的节`)
  }
  const moduleDefaults = await call(handlers, 'paramOverrides')
  assert.equal(moduleDefaults.status, 200, 'modules 声明可读取有效默认参数')
  assert.deepEqual(moduleDefaults.payload.value.overrides, {})
  assert.equal(readFileSync(join(undeclared, 'module.yml'), 'utf8'), before, '逐节读拒绝都零写入')

  // 未登记声明面的端点照旧放行（「登记表不得过度登记」的行为面配对）。
  assert.equal((await call(handlers, 'describe')).status, 200, '未登记声明的端点不看声明面')

  // 全局变量跨模块共享，与这个模块是否声明 `variables` 无关：global 读不受声明面约束，module 读仍拒。
  // （从 module-subject 那份重复用例里并过来的唯一判据。）
  const globalRead = await call(handlers, 'moduleVariables', { scope: 'global' })
  assert.equal(globalRead.status, 200, `全局变量读不该被模块声明挡住：${JSON.stringify(globalRead.payload)}`)
  const moduleRead = await call(handlers, 'moduleVariables', { scope: 'module' })
  assert.equal(moduleRead.status, 400)
  assert.equal(moduleRead.payload.code, 'module-not-declared')
  assert.match(moduleRead.payload.message, /variables/)
  assert.equal(readFileSync(join(undeclared, 'module.yml'), 'utf8'), before, '全局读也没有写盘')

  // 写路径不查声明面：允许给已有模块添加第一节，写成功后该节真实存在，随后读也合法。
  const tool = { id: 'shell', description: '运行命令', output: { schema: { type: 'string' } }, execute: { kind: 'shell', command: 'echo' } }
  const write = await call(handlers, 'customTools', { customTools: [tool] })
  assert.equal(write.status, 200, `写路径应放行并建立声明：${JSON.stringify(write.payload)}`)
  assert.equal(declares(undeclared, 'customTools'), true, '写路径建立声明')
  const readBack = await call(handlers, 'customTools')
  assert.equal(readBack.status, 200, `写后读应合法：${JSON.stringify(readBack.payload)}`)
  assert.deepEqual(readBack.payload.value.customTools, [tool])

  dir = declared
  assert.deepEqual((await call(handlers, 'customTools')).payload.value.customTools, [], 'customTools: [] 算已声明')
  assert.equal((await call(handlers, 'paramOverrides')).status, 200, 'layerSettings 也算声明（数组任一存在）')

  dir = broken
  const unparsable = await call(handlers, 'customTools')
  assert.equal(unparsable.status, 400)
  assert.equal(unparsable.payload.code, 'rules-invalid', '解析失败是既有错误，不得降级成「没声明」')
})

test('声明面：paramOverrides 写路径建立 layerSettings 声明（读 200 不算建立）', async () => {
  const dir = makeUserPresetDir('pt-declares-param-write-')
  const file = join(dir, 'module.yml')
  writeFileSync(file, `id: ${basename(dir)}\nmodules: []\nrules: []\n`, 'utf8')
  const { ctx, handlers } = makeHarness()
  registerSettingsBridge(ctx, { ns: 'prompt-tool', models: () => ({ available: true, providers: [] }),
    skills: () => skillsStateStub(), moduleDirectory: () => dir })

  assert.equal(declares(dir, 'layerSettings'), false, '前置：未声明 layerSettings')
  const write = await call(handlers, 'paramOverrides', { overrides: { modelTemperature: 0.3 } })
  assert.equal(write.status, 200, `写路径应放行：${JSON.stringify(write.payload)}`)
  assert.equal(declares(dir, 'layerSettings'), true, '写路径建立声明')
  const readBack = await call(handlers, 'paramOverrides')
  assert.equal(readBack.status, 200, `写后读应合法：${JSON.stringify(readBack.payload)}`)
  assert.deepEqual(readBack.payload.value.overrides, { modelTemperature: 0.3 })
})

test('能力参数桥：默认不落盘，主子独立保存回退，所有用户参数往返且非法值零写入', async () => {
  const dir = makeUserPresetDir('pt-engine-fields-'), id = basename(dir), file = join(dir, 'module.yml')
  writeFileSync(file, JSON.stringify({ id, modules: ['present-as', 'run-code-env', 'tool-git-bash', 'instruction-hint'], rules: [],
    moduleConfigs: { 'present-as': { mode: 'ptc', privateField: 'do-not-expose' } } }), 'utf8')
  const { ctx, handlers } = makeHarness()
  registerSettingsBridge(ctx, { ns: 'prompt-tool', models: () => ({ available: true, providers: [] }),
    skills: () => skillsStateStub(), moduleDirectory: () => dir })
  const request = async overrides => {
    const result = await call(handlers, 'paramOverrides', overrides === undefined ? {} : { overrides, expectedModuleId: id, rebuild: false })
    assert.equal(result.status, 200, JSON.stringify(result.payload))
    return result.payload.value
  }
  const initial = await request()
  assert.deepEqual(initial.overrides, {})
  assert.equal(initial.effective.ptcMainMode, 'ptc')
  assert.equal(initial.effective.ptcSubagentMode, 'ptc')
  assert.ok(initial.effective.runCodeEnvKeys.includes('PATH'))
  assert.equal(initial.effective.toolGitBashTimeoutMs, 120000)
  assert.equal(initial.effective.toolGitBashMaxOutputBytes, 64000)
  assert.equal(initial.effective.instructionHintPromoteOn, 'either')
  assert.equal(initial.effective.privateField, undefined, '未知行配置不出桥')
  await request({ ptcMainMode: 'native' })
  assert.equal((await request()).effective.ptcSubagentMode, 'ptc')
  await request({ ptcSubagentMode: 'native' })
  assert.deepEqual((await request()).overrides, { ptcMainMode: 'native', ptcSubagentMode: 'native' })
  await request({ ptcMainMode: '' })
  assert.equal((await request()).effective.ptcMainMode, 'ptc')
  assert.equal((await request()).effective.ptcSubagentMode, 'native')
  const fields = {
    presentAsEnabled: false, runCodeEnvEnabled: false, runCodeEnvKeys: ['HOME'],
    toolGitBashPath: 'D:/portable/Git/bin/bash.exe', toolGitBashTimeoutMs: 60000, toolGitBashMaxOutputBytes: 32000,
    instructionHint: true, instructionHintPromoteOn: 'tool-call', instructionHintIncludeSubagents: false,
    instructionHintProjectTemplate: 'Project {{ROOT}}: {{FILES}}', instructionHintGlobalTemplate: 'Global {{FILES}}',
    instructionHintSuffixTemplate: 'Reference only.', instructionHintMessageTemplate: '{{FILES}} {{SUFFIX}}',
  }
  await request(fields)
  const saved = await request()
  for (const [key, value] of Object.entries(fields)) {
    assert.deepEqual(saved.overrides[key], value, key)
    assert.deepEqual(saved.effective[key], value, key)
  }
  const source = parseYaml(readFileSync(file, 'utf8'))
  assert.deepEqual(source.rules, [], '能力编辑不伪造规则')
  assert.equal(source.layerSettings['tool-pipeline'].ptcMainMode, undefined)
  const before = readFileSync(file, 'utf8')
  for (const overrides of [{ ptcMainMode: 'both' }, { toolGitBashTimeoutMs: 0 }, { toolGitBashMaxOutputBytes: 1.5 }, { instructionHintPromoteOn: 'unknown' }]) {
    const result = await call(handlers, 'paramOverrides', { overrides, expectedModuleId: id })
    assert.equal(result.status, 400, JSON.stringify(result.payload))
    assert.equal(readFileSync(file, 'utf8'), before)
  }
  await request({ runCodeEnvKeys: [], toolGitBashTimeoutMs: '', instructionHintProjectTemplate: '' })
  const restored = await request()
  assert.ok(restored.effective.runCodeEnvKeys.includes('PATH'))
  assert.equal(restored.effective.toolGitBashTimeoutMs, 120000)
  assert.equal(restored.effective.instructionHintProjectTemplate, initial.effective.instructionHintProjectTemplate)
})

test('param-overrides：空主语＝全局层——写 config.yml 的 layerSettings，模块 module.yml 零改动', async () => {
  const moduleDir = makeUserPresetDir('pt-global-layer-')
  writeFileSync(join(moduleDir, 'module.yml'), `id: ${basename(moduleDir)}\nmodules: []\nrules: []\n`, 'utf8')
  const moduleBefore = readFileSync(join(moduleDir, 'module.yml'), 'utf8')
  const configFile = join(storageRootOf(bridgeHome), 'config.yml')
  const { ctx, handlers } = makeHarness()
  registerSettingsBridge(ctx, { ns: 'prompt-tool', models: () => ({ available: true, providers: [] }),
    skills: () => skillsStateStub(), moduleDirectory: (moduleId) => moduleId === undefined ? '' : moduleDir })
  const call = async (endpoint, body = {}, target) => {
    const handler = handlers.get(PREFIX + BRIDGE_ENDPOINTS[endpoint])
    assert.ok(handler, `${endpoint} 端点应注册`)
    const res = fakeRes()
    await handler(fakeReq({
      headers: { host: 'localhost', ...(target === undefined ? {} : { 'x-module-id': target }) },
      async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) },
    }), res)
    return { status: res.status, payload: JSON.parse(res.body) }
  }

  const empty = await call('paramOverrides', { overrides: { instructionHint: true } })
  assert.equal(empty.status, 200, `空主语必须写全局层：${JSON.stringify(empty.payload)}`)
  assert.equal(readFileSync(join(moduleDir, 'module.yml'), 'utf8'), moduleBefore, '全局层写入不碰任何模块定义')
  assert.match(readFileSync(configFile, 'utf8'), /instructionHint: true/, '全局值落在存储根 config.yml')
  const readBack = await call('paramOverrides')
  assert.equal(readBack.status, 200)
  assert.deepEqual(readBack.payload.value.overrides, { instructionHint: true }, '空主语读回全局值')

  const moduleWrite = await call('paramOverrides', { overrides: { instructionHint: false } }, basename(moduleDir))
  assert.equal(moduleWrite.status, 200, `模块主语照旧写模块：${JSON.stringify(moduleWrite.payload)}`)
  assert.match(readFileSync(join(moduleDir, 'module.yml'), 'utf8'), /instructionHint: false/, '模块写路径不变')
  assert.deepEqual((await call('paramOverrides')).payload.value.overrides, { instructionHint: true },
    '模块写不影响全局层（两处各存各的，优先级由 resolveModuleParams 判）')
})

test('bootstrap：config.yml 层名笔误只降级成诊断，不打掉首屏（也不再 400/500）', async () => {
  const moduleDir = makeUserPresetDir('pt-global-typo-')
  writeFileSync(join(moduleDir, 'module.yml'), `id: ${basename(moduleDir)}\nmodules: []\nrules: []\n`, 'utf8')
  const configFile = join(storageRootOf(bridgeHome), 'config.yml')
  const before = existsSync(configFile) ? readFileSync(configFile, 'utf8') : ''
  // 层名笔误：`pre-step-typo` 不是合法插入点 ⇒ 全局层形状校验抛错（爆炸半径原本覆盖首屏 + 全部装配）。
  writeFileSync(configFile, 'schemaVersion: 3\nenabled: []\nlayerSettings:\n  pre-step-typo:\n    instructionHint: true\n', 'utf8')
  try {
    const { ctx, handlers } = makeHarness()
    registerSettingsBridge(ctx, { ns: 'prompt-tool', models: () => ({ available: true, providers: [] }),
      skills: () => skillsStateStub(), moduleDirectory: (moduleId) => moduleId === undefined ? '' : moduleDir })
    const res = fakeRes()
    await handlers.get(PREFIX + BRIDGE_ENDPOINTS.bootstrap)(fakeReq({
      async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({})) },
    }), res)
    assert.equal(res.status, 200, `全局层笔误不得打掉工作台首屏：${res.body}`)
    const payload = JSON.parse(res.body)
    assert.deepEqual(payload.globalParams, {}, '全局段按空读回（软失败）')
    const warnings = payload.meta?.meta?.moduleWarnings ?? []
    assert.ok(warnings.some((message) => message.includes('全局层') && message.includes('pre-step-typo')),
      `要能看出诊断（模块页 role=alert 可见）：${JSON.stringify(warnings)}`)
  } finally {
    if (before.length > 0) writeFileSync(configFile, before, 'utf8')
    else rmSync(configFile, { force: true })
  }
})
