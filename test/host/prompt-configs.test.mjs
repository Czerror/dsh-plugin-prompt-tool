import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'

// 隔离 DSH_HOME：writePreset 的模板解析（resolvePresetDir）用户预设优先——
// 真实用户环境 .agent-presets/<id> 会遮蔽包内模板，测试必须隔离。
// 注意：paths 模块顶层缓存 DEFAULT_PRESET_DIR（join(DSH_HOME, ...)），
// preset-core/index 必须全部在 env 设置后动态 import，否则读到真实用户根。
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'pt-pc-home-'))
const { FIXTURE_PRESET_ID, installFixturePreset } = await import('../fixtures/preset-template.mjs')
const {
  loadPromptConfigFiles,
  mergePromptConfigs,
  renderPromptConfigYaml,
} = await import('../../lib/preset-core.mjs')
const { writePreset } = await import('../../lib/index.mjs')

/** writePreset 生成夹具模板的提示词配置（生产路径：preset.yml 数据 + 顶层 params 动态字段）。 */
function generatedConfigs(options = {}, prompt = 'PROMPT') {
  const dir = mkdtempSync(join(tmpdir(), 'pt-wp-configs-'))
  try {
    // writePreset 的模板解析根 = presetDir：先把夹具模板装到输出根。
    installFixturePreset(dir)
    writePreset(prompt, {
      presetDir: dir,
      presetTemplate: FIXTURE_PRESET_ID,
      presetOrder: 5,
      firstTurnAnchor: options.firstTurnAnchor === true,
      firstTurnText: options.firstTurnText ?? '',
      firstTurnCustom: options.firstTurnCustom === true,
      firstTurnWord: typeof options.firstTurnWord === 'string' ? options.firstTurnWord : undefined,
      guideText: options.guideText ?? '',
      guideCustom: options.guideCustom === true,
      guideEnabled: typeof options.guideEnabled === 'boolean' ? options.guideEnabled : undefined,
      injectPrompt: options.injectPrompt !== false,
      modelProvider: '', subagentModelProvider: '', subagentModelName: '',
      modelName: '',
      bootstrapMaxTokens: 0,
      usePtcMode: true,
      promptConfigs: [],
    })
    const specs = loadPromptConfigFiles(join(dir, FIXTURE_PRESET_ID, 'prompt-configs'))
    const byId = Object.fromEntries(specs.map((spec) => [spec.id, spec]))
    return { specs, byId }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

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

test('loadPromptConfigFiles 扫描 yml 与 json，非法文件 fail loud', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prompt-tool-user-configs-'))
  try {
    writeFileSync(join(dir, '10-a.yml'), 'id: a\nstrategy: static\ntext: A\n')
    writeFileSync(join(dir, '20-b.json'), JSON.stringify({ id: 'b', layer: 'agent-request', params: { patch: { maxTokens: 1 } } }))
    writeFileSync(join(dir, 'ignore.txt'), 'x')
    const specs = loadPromptConfigFiles(dir)
    assert.deepEqual(specs.map((spec) => spec.id), ['a', 'b'])
    assert.equal(specs[1].layer, 'agent-request')
    assert.throws(() => loadPromptConfigFiles(join(dir, 'missing')), /不可读/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('renderPromptConfigYaml：数字形状的 id/name 加引号，回读仍是字符串（否则整个预设挂载失败）', () => {
  const yaml = renderPromptConfigYaml({ id: 'st-prompt-32', name: '1', layer: 'pre-step', strategy: 'static', text: '正文' })
  assert.match(yaml, /^name: ["']1["']$/m, '数字形状名字必须带引号（引号样式由 yaml 适配器决定）')
  const parsed = parse(yaml)
  assert.equal(parsed.name, '1')
  assert.equal(typeof parsed.name, 'string')
  // id 同样：纯数字 id 不带引号会被解析回 number。
  const idYaml = renderPromptConfigYaml({ id: '123', strategy: 'static', text: '正文' })
  assert.match(idYaml, /^id: ["']123["']$/m)
  assert.equal(typeof parse(idYaml).id, 'string')
  // 普通字符串不加引号（不制造无谓 diff）。
  assert.match(renderPromptConfigYaml({ id: 'custom', name: '角色设定', strategy: 'static', text: 'x' }), /^name: 角色设定$/m)
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
    role: 'assistant',
    group: 'mode',
    exclusive: true,
    position: 'after-all',
    dedupe: 'batch',
    promotion: 'main',
    modelScope: 'pro',
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
  assert.deepEqual(doc.identity, { field: 'plugin', value: 'full-kind' })
  assert.deepEqual(doc.variables, { WHO: '李雷' })
  assert.equal(doc.params.toolNames, 'bash,run_code')
  assert.deepEqual(doc.params.patch, { maxTokens: 2048 })
})

test('writePreset 生成夹具模板的提示词配置模块（人设走顶层 persona 段，不再生成 persona 配置卡），数字前缀决定执行顺序', () => {
  const { specs } = generatedConfigs()
  assert.deepEqual(specs.map((spec) => spec.id), ['near-anchor', 'router-guide', 'prompt-injector'])
  assert.deepEqual(specs.map((spec) => spec.id).filter((id) => id.startsWith('agents-file-')), [], '指令文件卡不再物化')
  for (const spec of specs) {
    assert.equal(spec.layer, 'pre-step')
    assert.equal(spec.configKind, 'ordered')
    assert.equal(typeof spec.order, 'number')
    assert.equal(spec.role, 'user')
  }
  assert.equal(specs.some((spec) => spec.layer === 'system-section'), false, '人设不再以 system-section 配置卡承载')
})

test('writePreset 处理空提示词时 prompt-injector 结构完整', () => {
  const { byId } = generatedConfigs({}, '')
  assert.equal(byId['prompt-injector'].enabled, false, '空提示词无内容可注入，应禁用')
  assert.equal(byId['prompt-injector'].strategy, 'custom-fallback')
  assert.equal(byId['prompt-injector'].params.text, '')
  assert.equal(byId['prompt-injector'].params.firstTurnWord, 'we')
})

test('writePreset 开启 firstTurnAnchor 时 near-anchor 启用并携带自定义锚定句', () => {
  const { byId } = generatedConfigs({ firstTurnAnchor: true, firstTurnText: 'ANCHOR SENTENCE' })
  assert.equal(byId['near-anchor'].enabled, true)
  assert.equal(byId['near-anchor'].strategy, 'first-turn-anchor')
  assert.equal(byId['near-anchor'].position, 'after-user')
  assert.equal(byId['near-anchor'].params.useCustom, false)
  assert.equal(byId['near-anchor'].params.text, 'ANCHOR SENTENCE', '自定义锚文本统一写 text 契约键')
})

test('writePreset 开启 firstTurnCustom 时 near-anchor 固定使用自定义文本', () => {
  const { byId } = generatedConfigs({ firstTurnAnchor: true, firstTurnText: 'CUSTOM', firstTurnCustom: true })
  assert.equal(byId['near-anchor'].params.useCustom, true)
  assert.equal(byId['near-anchor'].params.text, 'CUSTOM')
})

test('writePreset 开启 firstTurnAnchor 且空锚点文本时生成自动模式配置', () => {
  const { byId } = generatedConfigs({ firstTurnAnchor: true, firstTurnText: '' })
  assert.equal(byId['near-anchor'].params.text, '')
})

test('writePreset 确认词自动派生：锚句信号词进 anchorWords；显式 firstTurnWord 覆盖', () => {
  const { byId } = generatedConfigs({ firstTurnAnchor: true })
  const words = byId['prompt-injector'].params.anchorWords
  assert.ok(Array.isArray(words) && words.includes('we'), 'build/fix 锚句信号词 we 派生')
  assert.ok(words.includes('let'), 'deep 锚句信号词 let 派生（旧缺陷修复：deep 档确认不再失败）')
  // 自定义锚句 → 首词进确认集合。
  const { byId: custom } = generatedConfigs({ firstTurnAnchor: true, firstTurnText: 'Focus on the core problem' })
  assert.ok(custom['prompt-injector'].params.anchorWords.includes('focus'), '自定义锚句首词派生')
  // 显式 firstTurnWord → 覆盖派生集合。
  const { byId: explicit } = generatedConfigs({ firstTurnAnchor: true, firstTurnWord: 'marker' })
  assert.deepEqual(explicit['prompt-injector'].params.anchorWords, ['marker'], '显式确认词覆盖派生')
})

test('writePreset 关闭 injectPrompt 时 prompt-injector 禁用（引擎仍扫描四个模块）', () => {
  const { byId } = generatedConfigs({ injectPrompt: false })
  assert.equal(byId['prompt-injector'].enabled, false)
})

test('writePreset 默认 router-guide 关闭（firstTurnAnchor=false），自动引导', () => {
  const { byId } = generatedConfigs()
  assert.equal(byId['router-guide'].enabled, false)
  assert.equal(byId['router-guide'].modelScope, 'flash')
  assert.equal(byId['router-guide'].params.useCustom, false)
  assert.equal(byId['router-guide'].params.text, '')
})

test('writePreset 引导开关独立：guideEnabled=true 时锚定关闭仍启用引导', () => {
  const { byId } = generatedConfigs({ firstTurnAnchor: false, guideEnabled: true })
  assert.equal(byId['router-guide'].enabled, true, 'guideEnabled=true 时引导独立启用')
  assert.equal(byId['near-anchor'].enabled, false, '锚定仍关闭（两功能独立）')
  const { byId: fallback } = generatedConfigs({ firstTurnAnchor: false })
  assert.equal(fallback['router-guide'].enabled, false, 'guideEnabled 缺省跟随锚定开关')
})

test('writePreset 开启 firstTurnAnchor 时 router-guide 启用', () => {
  const { byId } = generatedConfigs({ firstTurnAnchor: true })
  assert.equal(byId['router-guide'].enabled, true)
  assert.equal(byId['router-guide'].modelScope, 'flash')
  assert.equal(byId['router-guide'].params.useCustom, false)
})

test('writePreset guideCustom=true 时固定自定义每轮引导（Pro/Flash 都注入）', () => {
  const { byId } = generatedConfigs({ firstTurnAnchor: true, guideCustom: true, guideText: 'CUSTOM GUIDE' })
  assert.equal(byId['router-guide'].enabled, true)
  assert.equal(byId['router-guide'].modelScope, 'all')
  assert.equal(byId['router-guide'].params.useCustom, true)
  assert.equal(byId['router-guide'].params.text, 'CUSTOM GUIDE')
})

test('writePreset injectPrompt=false 且 firstTurnAnchor=true 只启用近锚与引导', () => {
  const { byId } = generatedConfigs({ injectPrompt: false, firstTurnAnchor: true, firstTurnText: 'A' })
  assert.equal(byId['near-anchor'].enabled, true)
  assert.equal(byId['router-guide'].enabled, true)
  assert.equal(byId['prompt-injector'].enabled, false)
  assert.equal(Object.keys(byId).some((id) => id.startsWith('agents-file-')), false, '不再物化指令文件卡')
})
