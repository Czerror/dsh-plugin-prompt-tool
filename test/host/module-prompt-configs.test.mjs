// 合并自 prompt-configs.test.mjs(17) + configs-validate.test.mjs(10) + templates.test.mjs(6)
//（2026-09-17 测试归一精简 Wave 2）。三份都通过 lib 入口工作，合并后统一在隔离 DSH_HOME 下
// 动态加载：原本静态 import 的 configs-validate / templates 改为动态 import（它们只调模板库与
// 校验纯函数，不读 DSH_HOME，语义等价）；原 prompt-configs 缺 after 清理，这里统一登记还原。
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse, parseDocument } from 'yaml'

// 隔离 DSH_HOME：writeModule 的模板解析（resolveModuleDir）用户模块优先——
// 真实用户环境 .prompt-tool/<id> 会遮蔽包内模板，测试必须隔离。
// 注意：paths 模块顶层缓存 MODULES_DIR（join(DSH_HOME, ...)），
// host/index 必须全部在 env 设置后动态 import，否则读到真实用户根。
const home = mkdtempSync(join(tmpdir(), 'pt-prompt-configs-home-'))
const previousHome = process.env.DSH_HOME
process.env.DSH_HOME = home
after(() => {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  rmSync(home, { recursive: true, force: true })
})
const { FIXTURE_MODULE_ID, installFixtureModule } = await import('../fixtures/module-template.mjs')
const {
  mergePromptConfigs,
  modelRequestConfigs,
  renderPromptConfigYaml,
} = await import('../../src/host/prompt-configs.ts')
const { Config, readModulesEnabled } = await import('../../src/config.ts')
const { createPromptConfigs } = await import('../../engine/schema.mjs')
const { writeModule } = await import('../../src/host/write-module.ts')
// 模板定位契约以打包目录 lib/ 为锚；其余行为直接覆盖当前源码。
const { loadPromptTemplates } = await import('../../lib/index.mjs')
const { planRulesMigration } = await import('../../src/host/rules-migration.ts')
const { loadModuleSpec } = await import('../../src/host/manifest.ts')
const { injectionConfigSpec } = await import('../../engine/rule-spec.mjs')

/** 旧参数夹具先显式离线转换，writer 只消费 canonical rules。 */
function generatedConfigs(options = {}, prompt = 'PROMPT') {
  const dir = mkdtempSync(join(tmpdir(), 'pt-wp-configs-'))
  try {
    // 模板解析根 = modulesRoot：先把夹具模板装到输出根。
    installFixtureModule(dir)
    const file = join(dir, FIXTURE_MODULE_ID, 'module.yml')
    const doc = parseDocument(readFileSync(file, 'utf8'))
    for (const [key, value] of Object.entries({ firstTurnAnchor: false, firstTurnCustom: false, guideCustom: false, injectPrompt: true, ...options })) doc.setIn(['layerSettings', 'pre-step', key], value)
    writeFileSync(file, doc.toString())
    writeFileSync(join(dir, FIXTURE_MODULE_ID, 'preset.md'), prompt)
    for (const item of planRulesMigration(dir).items) writeFileSync(join(item.directory, item.definitionFile), item.nextDefinition)
    writeModule({ modulesRoot: dir, moduleId: FIXTURE_MODULE_ID })
    const source = loadModuleSpec(join(dir, FIXTURE_MODULE_ID))
    const specs = source.rules.flatMap(rule => rule.then.filter(action => action.kind === 'inject-text').map(action => ({
      ...injectionConfigSpec(rule, action, source), enabled: rule.enabled !== false,
    })))
    const byId = Object.fromEntries(specs.map((spec) => [spec.id, spec]))
    return { specs, byId, rules: Object.fromEntries(parse(readFileSync(file, 'utf8')).rules.map(rule => [rule.id, rule])) }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// —— 提示词配置的合并、读写与 writeModule 生成（原 prompt-configs.test.mjs） ——

test('子代理模型路由：生成的请求补丁只覆盖本地子代理，缺少完整路由时继承', async () => {
  const { createPromptConfigs } = await import('../../engine/schema.mjs')
  const { applyPromptConfigs } = await import('../../engine/executor.mjs')
  const handlers = new Map()
  const ctx = {
    on: (name, handler) => { handlers.set(name, handler); return () => handlers.delete(name) },
    get: () => undefined,
    effect: (register) => register(),
    logger: { warn: (message) => assert.fail(message) },
  }
  const patches = modelRequestConfigs({
    subagentModelProvider: ' child-provider ', subagentModelName: ' child-model ', subagentTemperature: '0.25',
  })
  const release = applyPromptConfigs(ctx, createPromptConfigs(patches))
  const request = handlers.get('agent/request')
  const base = { provider: 'parent-provider', model: 'parent-model', temperature: 1 }
  const agent = (depth) => ({ options: {}, session: { header: { delegationDepth: depth } } })
  assert.deepEqual(await request({ agent: agent(0) }, async () => base), base, '主会话保持原请求')
  assert.deepEqual(await request({ agent: agent(1) }, async () => base), {
    provider: 'child-provider', model: 'child-model', temperature: 0.25,
  }, '本地子代理请求使用完整路由与采样参数')
  assert.deepEqual(modelRequestConfigs({ subagentModelProvider: 'child-provider' }), [], '半路由不产生请求覆盖')
  release()
  assert.equal(handlers.has('agent/request'), false, '释放后撤回本地请求监听')
})

test('共享参数存储：显示层变化不迁移磁盘路径，退役编辑器参数原样留存', async () => {
  const { engineParamPath, readLayerSettings } = await import('../../src/host/module-layer-settings.ts')
  const { saveModuleParams } = await import('../../src/host/manifest.ts')
  const root = mkdtempSync(join(home, 'layer-settings-'))
  const dir = join(root, 'example')
  mkdirSync(dir)
  const file = join(dir, 'module.yml')
  writeFileSync(file, 'id: example\nlayerSettings:\n  tool-pipeline:\n    strReplaceEditorMaxOutputChars: 16000\n    toolGitBashEnabled: false\n', 'utf8')
  saveModuleParams(root, 'example', { toolGitBashEnabled: true }, undefined)
  const saved = parse(readFileSync(file, 'utf8'))
  assert.equal(saved.layerSettings['tool-pipeline'].strReplaceEditorMaxOutputChars, 16000, '旧值作为未知数据保留')
  assert.deepEqual(readLayerSettings(saved.layerSettings), { toolGitBashEnabled: true }, '旧值不再投影到公开参数')
  assert.deepEqual(engineParamPath('subagentModelProvider'), ['layerSettings', 'subagent-start', 'subagentModelProvider'])
  assert.deepEqual(engineParamPath('maxDepth'), ['layerSettings', 'subagent-start', 'maxDepth'])
})

test('mergePromptConfigs：同名 id 后者覆盖且保留位置，新 id 追加末尾', () => {
  const defaults = generatedConfigs().specs
  const merged = mergePromptConfigs(defaults, [
    { id: 'near-anchor', enabled: false, strategy: 'static', text: '覆盖后的锚点' },
    { id: 'extra', strategy: 'static', layer: 'system-section', text: '新增提示词配置' },
  ])
  assert.deepEqual(merged.map((spec) => spec.id), ['near-anchor', 'router-guide', 'prompt-injector', 'extra'])
  assert.equal(merged[0].enabled, false)
  assert.equal(merged[0].text, '覆盖后的锚点')
  assert.equal(merged[3].layer, 'system-section')
})

test('renderPromptConfigYaml：YAML 特殊起始字符的名称/路径往返无损（否则整首预设解析失败）', () => {
  // 真实素材：ST 预设里的条目名以上述字符开头，裸写会被 YAML 当流程序列/映射/锚点解析而报错。
  const names = ['[主控制器]全能世界书', '{{user}}档案', '[new]剧情生成器[可生成多个事件]', '[mvu_update]输出规则', '- 破折号开头', '#井号开头', 'a: 带冒号', '*锚点', '&引用', '!标签', '%百分号', '?问号']
  for (const name of names) {
    const yaml = renderPromptConfigYaml({ id: 'cfg', name, strategy: 'static', text: '正文' })
    const parsed = parse(yaml)
    assert.equal(parsed.name, name, `name 往返必须无损：${name}`)
    assert.equal(typeof parsed.name, 'string')
    // 单行字段：不得把值渲染成多行块标量。
    assert.ok(yaml.split('\n').find((line) => line.startsWith('name:')) !== undefined)
  }
  // 其他用户字符串字段同样走安全标量。
  const extra = renderPromptConfigYaml({ id: 'cfg', strategy: 'static', fill: '[fill]', templateFile: '{{tpl}}/x.yml', group: '[g]', text: '正文' })
  const parsedExtra = parse(extra)
  assert.equal(parsedExtra.fill, '[fill]')
  assert.equal(parsedExtra.templateFile, '{{tpl}}/x.yml')
  assert.equal(parsedExtra.group, '[g]')
  // 多行名称退化为单行双引号标量（JSON 字符串是合法 YAML 标量）。
  const multiline = renderPromptConfigYaml({ id: 'cfg', name: '第一行\n第二行', strategy: 'static', text: 'x' })
  assert.match(multiline, /^name: "第一行\\n第二行"$/m)
  assert.equal(parse(multiline).name, '第一行\n第二行')
})

test('renderPromptConfigYaml 全字段开放：variables/identity/params 嵌套完整回读', () => {
  const yaml = renderPromptConfigYaml({
    id: 'full',
    name: '全字段提示词配置',
    enabled: true,
    strategy: 'static',
    layer: 'tool-pipeline',
    configKind: 'anchor',
    order: 42,
    role: 'user',
    group: 'mode',
    exclusive: true,
    position: 'after-all',
    dedupe: 'batch',
    promotion: 'main',
    modelScope: 'pro',
    subject: 'toolArgs',
    match: { keys: ['a', 'b'], secondaryKeys: ['c'], logic: 'all', caseSensitive: true, wholeWords: true, useRegex: false },
    sourceKind: 'full-kind',
    form: 'hint',
    summary: '摘要',
    text: '第一行\n第二行',
    templateFile: 'template.json',
    fill: 'env-facts',
    variables: { WHO: '李雷' },
    identity: { field: 'plugin', value: 'full-kind' },
    params: { toolNames: 'bash,run_code', patch: { maxTokens: 2048 } },
  })
  const doc = parse(yaml, { logLevel: 'silent' })
  assert.equal(doc.id, 'full')
  assert.equal(doc.layer, 'tool-pipeline')
  assert.equal(doc.text, '第一行\n第二行')
  assert.equal(doc.subject, 'toolArgs')
  assert.deepEqual(doc.match, { keys: ['a', 'b'], secondaryKeys: ['c'], logic: 'all', caseSensitive: true, wholeWords: true, useRegex: false })
  assert.deepEqual(doc.identity, { field: 'plugin', value: 'full-kind' })
  assert.deepEqual(doc.variables, { WHO: '李雷' })
  assert.equal(doc.params.toolNames, 'bash,run_code')
  assert.deepEqual(doc.params.patch, { maxTokens: 2048 })
})

test('writeModule 生成夹具模板的提示词配置模块（人设走顶层 persona 段，不再生成 persona 配置卡），数字前缀决定执行顺序', () => {
  const { specs } = generatedConfigs()
  assert.deepEqual(specs.map((spec) => spec.id), ['near-anchor', 'router-guide', 'prompt-injector'])
  for (const spec of specs) {
    assert.equal(spec.layer, 'pre-step')
    assert.equal(spec.configKind, 'ordered')
    assert.equal(typeof spec.order, 'number')
    assert.equal(spec.role, 'user')
  }
})

test('writeModule 处理空提示词时 prompt-injector 结构完整', () => {
  const { byId } = generatedConfigs({}, '')
  assert.equal(byId['prompt-injector'].enabled, false, '空提示词无内容可注入，应禁用')
  assert.equal(byId['prompt-injector'].strategy, 'anchor-notice')
  assert.equal(byId['prompt-injector'].params.text, '')
  assert.equal(byId['prompt-injector'].params.firstTurnWord, '', '确认词无内置默认（默认值归模板/预设）')
  assert.ok(byId['prompt-injector'].params.anchorWords.length > 0, '确认集合仍来自模板锚句派生')
})

test('writeModule 开启 firstTurnAnchor 时 near-anchor 启用并携带自定义锚定句', () => {
  const { byId } = generatedConfigs({ firstTurnAnchor: true, firstTurnText: 'ANCHOR SENTENCE' })
  assert.equal(byId['near-anchor'].enabled, true)
  assert.equal(byId['near-anchor'].strategy, 'first-turn-anchor')
  assert.equal(byId['near-anchor'].position, 'after-user')
  assert.equal(byId['near-anchor'].params.useCustom, false)
  assert.equal(byId['near-anchor'].params.text, 'ANCHOR SENTENCE', '自定义锚文本统一写 text 契约键')
})

test('旧模板离线迁移后 router-guide 关闭且模型范围归规则条件', () => {
  const { byId, rules } = generatedConfigs()
  assert.equal(byId['router-guide'].enabled, false)
  assert.ok((rules['router-guide'].if.all ?? [rules['router-guide'].if]).some(condition => condition.scope?.modelScope === 'flash'))
  assert.equal(byId['router-guide'].params.useCustom, false)
  assert.equal(byId['router-guide'].params.text, '')
})

test('Config：部署设置仅保留模块运行总闸', () => {
  const config = Config({})
  assert.deepEqual(Object.keys(config), ['modulesEnabled'])
  assert.equal(readModulesEnabled({}), true)
  assert.equal(readModulesEnabled({ modulesEnabled: false }), false)
  assert.throws(() => readModulesEnabled({ modulesEnabled: 1 }), /必须是布尔值/)
})

// —— 模板库（原 templates.test.mjs） ——

test('模板库全部条目通过引擎权威校验（模板即合法配置）', async () => {
  for (const template of loadPromptTemplates()) {
    assert.doesNotThrow(() => createPromptConfigs([template.spec]), template.file)
  }
})
