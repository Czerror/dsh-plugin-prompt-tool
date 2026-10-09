import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml, parseDocument } from 'yaml'
import { Context } from '@deepseek-ai/cordis'

// 隔离 DSH_HOME：writeModule 的模板解析（resolveModuleDir）用户模块优先——
// 真实用户环境 .prompt-tool/modules/<id> 会遮蔽包内模板，测试必须隔离。
const home = mkdtempSync(join(tmpdir(), 'pt-wp-home-'))
process.env.DSH_HOME = home
const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const { FIXTURE_MODULE_ID, FIXTURE_MODULE_SRC, installFixtureModule, installFixtureModuleInHome } = await import('../fixtures/module-template.mjs')
const { ensureModuleReady, writeModule } = await import('../../src/host/write-module.ts')
const { prepareAssembly } = await import('../../src/runtime/agent-assembly.ts')
const { loadModuleSpec, saveModuleParams } = await import('../../src/host/manifest.ts')
const { planRulesMigration } = await import('../../src/host/rules-migration.ts')
const { promptConfigToRule } = await import('../../src/host/rule-builder.ts')
const { readModuleRules, editModuleRules } = await import('../../src/host/module-rules.ts')
// 夹具模板同时装进隔离 DSH_HOME 的官方模块根（resolveModuleDir 场景）与各测试的输出根（见 makeOptions）。
installFixtureModuleInHome(home)
migrateFixtures(join(home, '.prompt-tool', 'modules'))
test.after(() => rmSync(home, { recursive: true, force: true }))

/** 只在测试准备阶段显式消费离线候选；writer 不负责兼容读取或迁移。 */
function migrateFixtures(root) {
  for (const item of planRulesMigration(root).items) writeFileSync(join(item.directory, item.definitionFile), item.nextDefinition)
}

function patchRule(dir, id, change) {
  const current = readModuleRules(dir)
  const rule = current.rules.find(rule => rule.id === id)
  const next = change(rule)
  const settingsChanged = next !== null && ['enabled', 'group', 'exclusive'].some(key => next[key] !== rule[key])
  return editModuleRules(dir, { expectedRevisions: current.revisions, edits: [{ previousId: id, rule: next, settingsChanged }] })
}

function projectedConfig(directory, id) {
  const rule = readModuleRules(directory).rules.find(rule => rule.id === id)
  const config = rule?.then.find(action => action.kind === 'inject-text')?.config
  return config === undefined ? undefined : { ...config, enabled: rule.enabled !== false }
}

function makeOptions(modulesRoot) {
  // 模板解析根 = options.modulesRoot（其次包内 modules/）：夹具缺失时安装；
  // 测试已自行复制并改写过模块定义时不覆盖。
  if (!existsSync(join(modulesRoot, FIXTURE_MODULE_ID, 'module.yml'))) installFixtureModule(modulesRoot)
  migrateFixtures(modulesRoot)
  return {
    modulesRoot,
    moduleId: FIXTURE_MODULE_ID,
  }
}

async function liveWriter(t, initial) {
  const { apply } = await import('../../src/index.ts')
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  ctx.provide('skills', { registerProvider: (factory) => { factory({ invalidate() {}, signal: new AbortController().signal }); return () => {} } })
  ctx.provide('agents', { list: () => [] })
  ctx.provide('webServer', {})
  const values = { modulesEnabled: true, ...initial }
  apply(ctx, Object.fromEntries(Object.keys(values).map(key => [key, { get: () => values[key] }])))
  return async (patch) => {
    Object.assign(values, patch)
    ctx.emit('loader/volatile-update')
    await new Promise(resolve => setImmediate(resolve))
  }
}

function installWriterModule(id) {
  const moduleDir = join(home, '.prompt-tool', 'modules')
  const dir = join(moduleDir, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'module.yml'), JSON.stringify({
    id, modules: ['prompt-config-engine'],
    content: { presetText: `BODY-${id}`, agentsText: `AGENTS-${id}` },
    layerSettings: { 'pre-step': {
      firstTurnAnchor: true, firstTurnCustom: true, firstTurnText: `PARAM-${id}`,
      guideEnabled: true, guideCustom: true, guideText: `GUIDE-${id}`,
    } },
    promptConfigs: [
      { id: 'near-anchor', strategy: 'first-turn-anchor', enabled: false, params: { useCustom: true, text: 'RULE' } },
      { id: 'router-guide', strategy: 'guide-auto', enabled: false, params: { useCustom: false, text: 'RULE' } },
    ],
  }), 'utf8')
  migrateFixtures(moduleDir)
  writeModule(`BODY-${id}`, { modulesRoot: moduleDir, moduleId: id, agentsInstructionText: `AGENTS-${id}` })
  return dir
}

test('公共重建入口：已离线迁移规则逐模块重建，不串用模块正文', async () => {
  const dirs = ['writer-a', 'writer-b'].map(installWriterModule)
  for (const id of ['writer-b', 'writer-a']) ensureModuleReady(id, { modulesRoot: join(home, '.prompt-tool', 'modules') })
  for (const [index, id] of ['writer-a', 'writer-b'].entries()) {
    const dir = dirs[index]
    const config = projectedConfig(dir, 'near-anchor')
    assert.equal(config.enabled, true, `${id} 使用定义中的共享开关`)
    assert.equal(config.params.text, `PARAM-${id}`, `${id} 使用定义中的共享正文`)
    const guide = projectedConfig(dir, 'router-guide')
    assert.equal(guide.enabled, true)
    assert.equal(guide.params.text, `GUIDE-${id}`)
    assert.equal(loadModuleSpec(dir).rules.find(rule => rule.id === 'router-guide').if, undefined, '自定义引导没有模型范围门')
    assert.equal(readFileSync(join(dir, 'agents.md'), 'utf8'), `AGENTS-${id}`)
  }
})

test('规则所有者：无旧快捷参数的同名规则保留自身字段，物化不覆盖模块排序', () => {
  const root = mkdtempSync(join(home, 'rule-owner-'))
  const dir = join(root, 'example')
  mkdirSync(dir)
  const configs = [
    { id: 'near-anchor', strategy: 'first-turn-anchor', enabled: true, params: { useCustom: true, text: 'RULE ANCHOR' } },
    { id: 'router-guide', strategy: 'guide-auto', enabled: true, modelScope: 'all', params: { useCustom: true, text: 'RULE GUIDE' } },
    { id: 'prompt-injector', strategy: 'custom-fallback', enabled: false, params: { text: 'RULE BODY', firstTurnWord: 'custom' } },
  ]
  writeFileSync(join(dir, 'module.yml'), JSON.stringify({ id: 'example', order: 91, modules: [], rules: configs.map(promptConfigToRule) }), 'utf8')
  writeModule('UNRELATED BODY', { modulesRoot: root, moduleId: 'example' })
  for (const expected of configs) {
    const actual = projectedConfig(dir, expected.id)
    assert.equal(actual.enabled, expected.enabled)
    for (const [key, value] of Object.entries(expected.params)) assert.deepEqual(actual.params[key], value)
    assert.equal(actual.fieldSources, undefined, '新产物不再声明模块快捷参数拥有规则字段')
  }
  assert.equal(parseYaml(readFileSync(join(dir, 'module.yml'), 'utf8')).order, 91)
})

test('旧来源运行时拒绝，显式离线迁移后只认规则事务；未承接旧键拒迁并保留', () => {
  const root = mkdtempSync(join(home, 'legacy-rules-'))
  installFixtureModule(root)
  const dir = join(root, FIXTURE_MODULE_ID)
  const file = join(dir, 'module.yml')
  const doc = parseDocument(readFileSync(file, 'utf8'))
  doc.setIn(['layerSettings', 'pre-step', 'firstTurnAnchor'], true)
  doc.setIn(['layerSettings', 'pre-step', 'firstTurnText'], 'Start your reasoning with the exact sentence: Go now.')
  doc.setIn(['layerSettings', 'pre-step', 'complexPattern'], 'complex-task')
  doc.setIn(['layerSettings', 'pre-step', 'guideEnabled'], false)
  doc.setIn(['layerSettings', 'pre-step', 'guideCustom'], true)
  doc.setIn(['layerSettings', 'pre-step', 'guideText'], 'LEGACY GUIDE')
  writeFileSync(file, doc.toString(), 'utf8')
  writeFileSync(join(dir, 'preset.md'), 'LEGACY BODY', 'utf8')
  assert.throws(() => loadModuleSpec(dir), /离线迁移/)
  assert.throws(() => writeModule('LEGACY BODY', { modulesRoot: root, moduleId: FIXTURE_MODULE_ID }), /离线迁移/)
  migrateFixtures(root)
  const loaded = loadModuleSpec(dir)
  const nearRule = loaded.rules.find(rule => rule.id === 'near-anchor')
  const guideRule = loaded.rules.find(rule => rule.id === 'router-guide')
  const near = nearRule.then[0].config
  const guide = guideRule.then[0].config
  const injector = loaded.rules.find(rule => rule.id === 'prompt-injector').then[0].config
  assert.equal(nearRule.enabled, true)
  assert.equal(near.params.complexPattern, 'complex-task')
  assert.equal(guide.params.complexPattern, 'complex-task', '共享复杂模式交给两条规则')
  assert.equal(guideRule.enabled, false)
  assert.equal(guide.params.useCustom, true, '停用不丢弃已保存的自定义模式偏好')
  assert.ok(!(guideRule.if?.all ?? [guideRule.if]).some(condition => condition?.scope?.modelScope === 'flash'))
  assert.equal(injector.params.text, 'LEGACY BODY')
  assert.ok(injector.params.anchorWords.includes('go'))
  const imported = writeModule('LEGACY BODY', { modulesRoot: root, moduleId: FIXTURE_MODULE_ID, targetModuleId: 'imported', sourceDir: dir })
  assert.equal(projectedConfig(imported, 'near-anchor').params.complexPattern, 'complex-task')
  patchRule(dir, 'near-anchor', rule => ({ ...rule, enabled: false, then: [{ ...rule.then[0], config: { ...near, params: { ...near.params, text: 'OWNED RULE' } } }] }))
  saveModuleParams(root, FIXTURE_MODULE_ID, { maxDepth: 0 }, undefined)
  const saved = parseYaml(readFileSync(file, 'utf8'))
  assert.equal(saved.layerSettings['pre-step']?.firstTurnText, undefined)
  assert.equal(saved.layerSettings['pre-step']?.complexPattern, undefined)
  assert.equal(saved.layerSettings['subagent-start'].maxDepth, 0)
  ensureModuleReady(FIXTURE_MODULE_ID, { modulesRoot: root })
  const ownedNear = loadModuleSpec(dir).rules.find(rule => rule.id === 'near-anchor')
  assert.equal(ownedNear.enabled, false)
  assert.equal(ownedNear.then[0].config.params.text, 'OWNED RULE')
  assert.throws(() => saveModuleParams(root, FIXTURE_MODULE_ID, { firstTurnText: '' }, undefined), /旧规则参数/)
  assert.equal(loadModuleSpec(dir).rules.find(rule => rule.id === 'near-anchor').then[0].config.params.text, 'OWNED RULE')
  const orphanDir = join(root, 'orphan')
  mkdirSync(orphanDir)
  writeFileSync(join(orphanDir, 'module.yml'), 'id: orphan\nmodules: []\nlayerSettings:\n  pre-step:\n    guideWeak: KEEP\n', 'utf8')
  assert.throws(() => saveModuleParams(root, 'orphan', undefined, []), /离线迁移/)
  assert.equal(parseYaml(readFileSync(join(orphanDir, 'module.yml'), 'utf8')).layerSettings['pre-step'].guideWeak, 'KEEP')
  assert.throws(() => planRulesMigration(root), /无损承接/)
  assert.throws(() => writeModule('', { modulesRoot: root, moduleId: 'orphan' }), /离线迁移/)
  assert.equal(parseYaml(readFileSync(join(orphanDir, 'module.yml'), 'utf8')).layerSettings['pre-step'].guideWeak, 'KEEP')
})

test('运行总闸：关闭再开启不改模块定义或物化产物字节', async (t) => {
  const dir = installWriterModule('writer-gate')
  const files = ['module.yml', 'agents.md', ...readdirSync(join(dir, 'rules')).map(file => join('rules', file))]
  const before = files.map(file => readFileSync(join(dir, file)))
  const update = await liveWriter(t, { modulesEnabled: true })
  for (const modulesEnabled of [false, true]) {
    await update({ modulesEnabled })
    for (const [index, file] of files.entries()) {
      assert.equal(existsSync(join(dir, file)), true, `${file} 不能被总闸删除`)
      assert.deepEqual(readFileSync(join(dir, file)), before[index], `${file} 不能被总闸改写`)
    }
  }
  await update({ modulesEnabled: false })
  patchRule(dir, 'near-anchor', rule => ({ ...rule, then: [{ ...rule.then[0], config: { ...rule.then[0].config, params: { ...rule.then[0].config.params, text: 'SAVED-WHILE-OFF' } } }] }))
  ensureModuleReady('writer-gate', { modulesRoot: join(home, '.prompt-tool', 'modules') })
  assert.equal(projectedConfig(dir, 'near-anchor').params.text, 'SAVED-WHILE-OFF')
})

test('writeModule 不生成共享引擎或宿主组合，规则切片保持可装配', async () => {
  const dir = join(tmpdir(), `prompt-tool-wp-${process.pid}-${Date.now()}`)
  const moduleDir = join(dir, 'preset')
  try {
    writeModule('PROMPT', makeOptions(moduleDir))
    // 共享引擎自阶段 2 起由**插件包**提供（组合行引用 dsh-plugin-prompt-tool/engine/*.mjs）：
    // 模块根下不再出现 .engine/ 目录，也不再写引擎指纹文件。
    assert.equal(existsSync(join(moduleDir, '.engine')), false, '模块根不再物化 .engine')
    assert.equal(existsSync(join(moduleDir, '.pt-engine-fingerprint')), false, '不再写引擎指纹文件')
    assert.deepEqual(readdirSync(moduleDir).filter((name) => name.startsWith('.')), [],
      '模块根不残留 .engine/.pt-engine-fingerprint/临时目录')
    assert.equal(existsSync(join(moduleDir, 'fixture', 'engine')), false, '子模块不复制 engine')
    assert.equal(existsSync(join(moduleDir, 'agent.cordis.yml')), false, '模块根不再写容器根转发')
    assert.equal(existsSync(join(moduleDir, 'fixture', 'agent.cordis.yml')), false)
    const prepared = await prepareAssembly(moduleDir, 'fixture', () => true)
    for (const module of ['rule-engine', 'run-code-env', 'tool-git-bash', 'skill-search']) {
      assert.ok(existsSync(join(ROOT, 'engine', `${module}.mjs`)),
        `说明符 ${module}.mjs 应在包内引擎目录存在（否则引用悬空）`)
    }
    assert.ok(prepared.rules.length > 0)
    assert.equal(existsSync(join(moduleDir, 'fixture', 'rules', '_settings.yml')), true)
    // 引擎指纹（.engine/.pt-engine-fingerprint + 内容摘要比对、未变则不重刷）已随共享引擎
    // 归位插件包整体删除：二次写入不再有「是否重刷共享引擎」这一步，只需保证产物本身幂等。
    const stable = readFileSync(join(moduleDir, 'fixture', 'rules', '_settings.yml'), 'utf8')
    writeModule('PROMPT', makeOptions(moduleDir))
    assert.equal(readFileSync(join(moduleDir, 'fixture', 'rules', '_settings.yml'), 'utf8'), stable,
      '二次写入产物逐字节稳定（引擎说明符不来回改写）')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writeModule 物化模型请求动作，条件区分主/子且空参数不生成覆盖', () => {
  const dir = join(tmpdir(), `prompt-tool-wp-${process.pid}-${Date.now()}`)
  const moduleDir = join(dir, 'preset')
  try {
    const options = makeOptions(moduleDir)
    const source = join(moduleDir, FIXTURE_MODULE_ID)
    const current = readModuleRules(source)
    const model = (id, audience, patch) => ({ id, layer: 'agent-request', if: { scope: { audience } }, then: [{ id: 'request', kind: 'request-params', modelScope: 'all', patch }] })
    editModuleRules(source, { expectedRevisions: current.revisions, edits: [
      { previousId: null, rule: model('model-params', 'main', { reasoningEffort: 'high', temperature: 1, maxTokens: 32000 }) },
      { previousId: null, rule: model('subagent-model-params', 'subagent', { reasoningEffort: 'max' }) },
    ] })
    writeModule('PROMPT', options)
    const rules = readModuleRules(source).rules
    const main = rules.find(rule => rule.id === 'model-params')
    const child = rules.find(rule => rule.id === 'subagent-model-params')
    assert.deepEqual(main.if, { scope: { audience: 'main' } })
    assert.deepEqual(main.then[0].patch, { reasoningEffort: 'high', temperature: 1, maxTokens: 32000 })
    assert.deepEqual(child.if, { scope: { audience: 'subagent' } })
    assert.deepEqual(child.then[0].patch, { reasoningEffort: 'max' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writeModule：module.yml 的模块行参数经参数桥进入内存配装', async () => {
  const dir = join(tmpdir(), `prompt-tool-wp-${process.pid}-${Date.now()}`)
  const moduleDir = join(dir, 'preset')
  try {
    // B7 T3：原用例的载体是 `pre-step.allowKinds` → `context-gate` 行；两者都已删除。
    // 换成本地自己写的模板（不污染共享夹具），机制与断言不变。
    mkdirSync(join(moduleDir, FIXTURE_MODULE_ID), { recursive: true })
    writeFileSync(join(moduleDir, FIXTURE_MODULE_ID, 'module.yml'),
      'id: fixture\nname: fixture\nversion: "1"\nengineCompat: ">=0.4.2"\n'
      + 'modules: [tool-git-bash]\nlayerSettings:\n  tool-pipeline:\n    toolGitBashEnabled: false\n', 'utf8')
    writeModule('PROMPT', makeOptions(moduleDir))
    const rows = (await prepareAssembly(moduleDir, FIXTURE_MODULE_ID, () => true)).modules
    const toolGitBash = rows.find((row) => row?.id === 'tool-git-bash')
    assert.ok(toolGitBash, '内存配装应含 tool-git-bash 行')
    assert.equal(toolGitBash.config.enabled, false, '参数桥把 layerSettings 参数写进该行的 config')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writeModule 写正文资产不改已有规则所有权', () => {
  const dir = join(tmpdir(), `prompt-tool-src-${process.pid}-${Date.now()}`)
  const moduleDir = join(dir, 'preset')
  try {
    const options = makeOptions(moduleDir)
    const moduleFile = join(moduleDir, 'fixture', 'module.yml')
    const before = readFileSync(moduleFile, 'utf8')
    writeModule('FILE CONTENT', options)
    const injector = projectedConfig(join(moduleDir, 'fixture'), 'prompt-injector')
    assert.equal(injector.params.text, parseYaml(before).rules.find(rule => rule.id === 'prompt-injector').then[0].config.params.text)
    assert.doesNotMatch(JSON.stringify(injector), /SETTINGS TEXT/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writeModule 生成 agents.md 内容资产', () => {
  const dir = join(tmpdir(), `prompt-tool-md-${process.pid}-${Date.now()}`)
  const moduleDir = join(dir, 'preset')
  try {
    writeModule('PRESET CONTENT', { ...makeOptions(moduleDir), agentsInstructionText: 'AGENTS CONTENT' })
    assert.equal(readFileSync(join(moduleDir, 'fixture', 'agents.md'), 'utf8'), 'AGENTS CONTENT')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writeModule 失败时保留旧生成目录', () => {
  const dir = join(tmpdir(), `prompt-tool-wp-${process.pid}-${Date.now()}`)
  const moduleDir = join(dir, 'preset')
  mkdirSync(join(moduleDir, 'fixture'), { recursive: true })
  writeFileSync(join(moduleDir, 'fixture', 'keep.txt'), 'old', 'utf8')
  try {
    assert.throws(() => writeModule('PROMPT', { ...makeOptions(moduleDir), moduleId: 'missing-template' }))
    assert.equal(readFileSync(join(moduleDir, 'fixture', 'keep.txt'), 'utf8'), 'old')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writeModule 拒绝非法 moduleId（路径穿越防护）', () => {
  const dir = join(tmpdir(), `prompt-tool-sec-${process.pid}-${Date.now()}`)
  const moduleDir = join(dir, 'preset')
  try {
    assert.throws(
      () => writeModule('PROMPT', { ...makeOptions(moduleDir), moduleId: '../escape' }),
      /非法模块 id/,
    )
    assert.throws(
      () => writeModule('PROMPT', { ...makeOptions(moduleDir), moduleId: 'a/b' }),
      /非法模块 id/,
    )
    // 官方 agent-presets id 约束（PRESET_ID /^[a-z0-9][a-z0-9-]*$/）：中文/大写
    // 目录名会被宿主 discovery 静默跳过（会话 resume 报 preset not found），必须 fail loud。
    assert.throws(
      () => writeModule('PROMPT', { ...makeOptions(moduleDir), moduleId: '夏瑾-天琴座-beta-2-42' }),
      /非法模块 id/,
    )
    assert.throws(
      () => writeModule('PROMPT', { ...makeOptions(moduleDir), moduleId: 'Fixture' }),
      /非法模块 id/,
    )
    assert.ok(!existsSync(join(dir, 'escape')), '不得写入容器根之外')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writeModule 预设变量只读顶层 variables，清空后不复活 params 中的旧内容键', () => {
  const dir = join(tmpdir(), `prompt-tool-uikeys-${process.pid}-${Date.now()}`)
  const moduleDir = join(dir, 'preset')
  try {
    // 旧 params 内容键及嵌套 params.variables 保留原文件，但不再成为变量源。
    cpSync(FIXTURE_MODULE_SRC, join(moduleDir, 'fixture'), { recursive: true })
    const presetFile = join(moduleDir, 'fixture', 'module.yml')
    const doc = parseDocument(readFileSync(presetFile, 'utf8'))
    doc.setIn(['params', 'legacyVar'], '旧值')
    doc.setIn(['params', 'legacyEmpty'], '')
    doc.setIn(['params', 'wordsCloud'], '旧默认')
    doc.setIn(['params', 'variables'], { nested: '不是模板变量' })
    doc.get('modules', true).add('tool-config-engine')
    writeFileSync(presetFile, doc.toString(), 'utf8')
    migrateFixtures(moduleDir)
    const variables = { wordsCloud: '1500字', 日期: '', usePtcMode: '同名内容变量' }
    saveModuleParams(moduleDir, 'fixture', undefined, undefined, variables)
    const storedParams = parseYaml(readFileSync(presetFile, 'utf8')).params
    writeModule('PROMPT', makeOptions(moduleDir))
    const pcDir = join(moduleDir, 'fixture', 'rules')
    const parsed = projectedConfig(join(moduleDir, 'fixture'), 'near-anchor')
    for (const key of ['firstTurnAnchor', 'firstTurnText', 'modelProvider', 'modelName',
      'guideText', 'usePtcMode', 'injectPrompt', 'bootstrapMaxTokens', 'toolFilterAllow']) {
      assert.equal(parsed.params?.[key], undefined, `配置 params 不得含 UI 管理键 ${key}`)
    }
    // 顶层变量不靠 PARAM_KEYS 猜测用途，允许与引擎参数同名；配置文件保持干净。
    const varsFile = join(pcDir, 'variables.yml')
    assert.ok(existsSync(varsFile), 'variables.yml 生成')
    const vars = parseYaml(readFileSync(varsFile, 'utf8'))
    assert.deepEqual(vars, variables, '变量文件只包含顶层变量，保留空串与同名键')
    assert.equal(parsed.params?.wordsCloud, undefined, '内容变量不再进 params')
    saveModuleParams(moduleDir, 'fixture', undefined, undefined, {})
    writeModule('PROMPT', makeOptions(moduleDir))
    assert.deepEqual(parseYaml(readFileSync(varsFile, 'utf8')), {}, '清空顶层变量后切片为空映射，params 内容键不复活')
    assert.deepEqual(parseYaml(readFileSync(presetFile, 'utf8')).params, storedParams, '不迁移或清理原 params')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writeModule 自定义工具拒绝坏定义，合法 DSL 在配装期编译且不写旧产物', async () => {
  const dir = join(tmpdir(), `prompt-tool-ctools-${process.pid}-${Date.now()}`)
  const moduleDir = join(dir, 'preset')
  try {
    cpSync(FIXTURE_MODULE_SRC, join(moduleDir, 'fixture'), { recursive: true })
    const presetFile = join(moduleDir, 'fixture', 'module.yml')
    const doc = parseDocument(readFileSync(presetFile, 'utf8'))
    doc.setIn(['customTools'], [
      {
        id: 'greet',
        name: 'my_greet',
        description: '打招呼',
        parameters: { who: { type: 'string', required: true, description: '对象' } },
        output: { schema: { type: 'object', additionalProperties: true } },
        execute: { kind: 'shell', command: 'Write-Output "hi {{args.who}}"' },
      },
      { id: 'bad', name: 'no execute' },
    ])
    doc.get('modules', true).add('tool-config-engine')
    writeFileSync(presetFile, doc.toString(), 'utf8')
    const options = makeOptions(moduleDir)
    assert.throws(() => writeModule('PROMPT', options), /customTools/)
    const fixed = parseDocument(readFileSync(presetFile, 'utf8'))
    fixed.deleteIn(['customTools', 1])
    writeFileSync(presetFile, fixed.toString())
    writeModule('PROMPT', options)
    const prepared = await prepareAssembly(moduleDir, 'fixture', () => true)
    const toolRow = prepared.modules.find(row => row.id === 'tool-config-engine')
    const parsed = toolRow.config.tools[0]
    assert.equal(existsSync(join(moduleDir, 'fixture', 'custom-tools')), false)
    assert.equal(parsed.name, 'my_greet')
    assert.equal(parsed.execute.kind, 'shell')
    assert.deepEqual(parsed.parameters, { type: 'object', properties: { who: { type: 'string', description: '对象' } }, required: ['who'] }, '参数 DSL 经官方转换器物化为标准 JSON Schema')
    assert.equal(typeof toolRow.config.resourceRoot, 'string')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writeModule 用户副本缺组合源时拒绝，不回退包内同名模板', () => {
  const moduleDir = join(home, '.prompt-tool', 'modules')
  const userMinimal = join(moduleDir, 'pt-minimal')
  try {
    rmSync(userMinimal, { recursive: true, force: true })
    mkdirSync(userMinimal, { recursive: true })
    // 纯元数据副本：无 modules/params/promptConfigs，目录也无 agent.cordis.yml。
    writeFileSync(join(userMinimal, 'module.yml'), 'name: 极简模式（旧）\ndescription: 旧版种子副本\norder: 3\n', 'utf8')
    const before = readFileSync(join(userMinimal, 'module.yml'), 'utf8')
    assert.throws(() => writeModule('PROMPT', { ...makeOptions(moduleDir), moduleId: 'pt-minimal' }), /no modules.*composition/)
    assert.equal(existsSync(join(userMinimal, 'agent.cordis.yml')), false)
    assert.equal(readFileSync(join(userMinimal, 'module.yml'), 'utf8'), before)
    const spec = parseYaml(readFileSync(join(userMinimal, 'module.yml'), 'utf8'))
    assert.equal(spec.modules, undefined, '不注入包内 modules（无迁移）')
    assert.equal(spec.name, '极简模式（旧）', '用户命名保留')
    assert.equal(spec.description, '旧版种子副本', '用户描述保留')
  } finally {
    rmSync(userMinimal, { recursive: true, force: true })
  }
})

test('R3 离线迁移后的规则保留作者定义，只有显式规则事务才能改写', () => {
  const dir = join(tmpdir(), `prompt-tool-preserve-${process.pid}-${Date.now()}`)
  /** 安装夹具并把定义改成「作者显式声明」形态，覆盖 runtimeOf 曾补默认值的键。 */
  const install = (moduleDir) => {
    installFixtureModule(moduleDir)
    const file = join(moduleDir, FIXTURE_MODULE_ID, 'module.yml')
    const doc = parseDocument(readFileSync(file, 'utf8'))
    doc.setIn(['layerSettings', 'pre-step', 'firstTurnAnchor'], true)
    doc.setIn(['layerSettings', 'pre-step', 'firstTurnText'], 'ANCHOR TEXT')
    doc.setIn(['layerSettings', 'pre-step', 'injectPrompt'], false)
    doc.setIn(['layerSettings', 'subagent-start', 'subagentModelProvider'], 'sub-provider')
    doc.setIn(['layerSettings', 'subagent-start', 'subagentModelName'], 'sub-model')
    writeFileSync(file, doc.toString(), 'utf8')
    migrateFixtures(moduleDir)
    return moduleDir
  }
  const readConfig = (moduleDir, id) => projectedConfig(join(moduleDir, FIXTURE_MODULE_ID), id)
  const subagentRule = moduleDir => readModuleRules(join(moduleDir, FIXTURE_MODULE_ID)).rules.find(rule => rule.id === 'subagent-model-params')
  try {
    // 调用方只给部署字段（与 installModulePackage / 离线物化调用同源）：不得覆盖作者定义。
    const kept = install(join(dir, 'kept'))
    writeModule('PRESET BODY', { modulesRoot: kept, moduleId: FIXTURE_MODULE_ID })
    assert.equal(readConfig(kept, 'near-anchor').enabled, true, '省略 firstTurnAnchor 时保留定义里的 true')
    assert.equal(readConfig(kept, 'near-anchor').params.text, 'ANCHOR TEXT', '省略 firstTurnText 不清空作者文本')
    assert.equal(readConfig(kept, 'prompt-injector').enabled, false, '省略 injectPrompt 时保留定义里的 false')
    assert.deepEqual(subagentRule(kept)?.then[0].patch, { provider: 'sub-provider', model: 'sub-model' },
      '省略子代理模型路由时保留定义')

    // 显式局部事务才能关闭/开启规则或移除路由；writer 不再读取旧业务覆盖参数。
    const explicit = install(join(dir, 'explicit'))
    const modulePath = join(explicit, FIXTURE_MODULE_ID)
    patchRule(modulePath, 'near-anchor', rule => ({ ...rule, enabled: false }))
    patchRule(modulePath, 'prompt-injector', rule => ({ ...rule, enabled: true }))
    patchRule(modulePath, 'subagent-model-params', () => null)
    writeModule('PRESET BODY', { modulesRoot: explicit, moduleId: FIXTURE_MODULE_ID })
    assert.equal(readConfig(explicit, 'near-anchor').enabled, false, '显式 false 覆盖定义')
    assert.equal(readConfig(explicit, 'prompt-injector').enabled, true, '显式 true 覆盖定义')
    assert.equal(subagentRule(explicit), undefined, '显式删除后不设置路由')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writeModule：模板名与输出目录名分离，安全 id 输出仍渲染包内模板', () => {
  const outputRoot = mkdtempSync(join(home, 'split-'))
  writeModule('', {
    ...makeOptions(outputRoot),
    moduleId: FIXTURE_MODULE_ID,
    targetModuleId: 'pt-safe',
  })
  assert.equal(parseYaml(readFileSync(join(outputRoot, 'pt-safe', 'module.yml'), 'utf8')).id, 'pt-safe')
  assert.equal(existsSync(join(outputRoot, 'pt-safe', 'rules', '_settings.yml')), true)
  assert.equal(existsSync(join(outputRoot, 'standard')), false, '模板名不会被当成输出目录')
})
