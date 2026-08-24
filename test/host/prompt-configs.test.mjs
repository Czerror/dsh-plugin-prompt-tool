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
const {
  loadPromptConfigFiles,
  mergePromptConfigs,
  renderPromptConfigYaml,
} = await import('../../lib/preset-core.mjs')
const { writePreset } = await import('../../lib/index.mjs')

/** writePreset 生成 anchored 提示词配置（生产路径：preset.yml 数据 + 顶层 params 动态字段）。 */
function generatedConfigs(options = {}, prompt = 'PROMPT') {
  const dir = mkdtempSync(join(tmpdir(), 'pt-wp-configs-'))
  try {
    writePreset(prompt, {
      presetDir: dir,
      presetOrder: 5,
      firstTurnAnchor: options.firstTurnAnchor === true,
      firstTurnText: options.firstTurnText ?? '',
      firstTurnCustom: options.firstTurnCustom === true,
      firstTurnWord: typeof options.firstTurnWord === 'string' ? options.firstTurnWord : undefined,
      mainPersona: typeof options.mainPersona === 'string' ? options.mainPersona : undefined,
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
    const specs = loadPromptConfigFiles(join(dir, 'anchored', 'prompt-configs'))
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
  assert.deepEqual(merged.map((spec) => spec.id), ['near-anchor', 'router-guide', 'prompt-injector', 'instruction-hint', 'persona-main', 'extra'])
  assert.equal(merged[0].enabled, false)
  assert.equal(merged[0].text, '覆盖后的锚点')
  assert.equal(merged[4].layer, 'system-section')
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
  assert.deepEqual(doc.texts, ['第一行\n第二行'])
  assert.deepEqual(doc.identity, { field: 'plugin', value: 'full-kind' })
  assert.deepEqual(doc.variables, { WHO: '李雷' })
  assert.equal(doc.params.toolNames, 'bash,run_code')
  assert.deepEqual(doc.params.patch, { maxTokens: 2048 })
})

test('writePreset 生成 anchored 提示词配置模块（含 persona-main 人设段），数字前缀决定执行顺序', () => {
  const { specs } = generatedConfigs()
  assert.deepEqual(specs.map((spec) => spec.id), ['near-anchor', 'router-guide', 'prompt-injector', 'instruction-hint', 'persona-main'])
  for (const spec of specs.filter((spec) => spec.id !== 'persona-main')) {
    assert.equal(spec.layer, 'pre-step')
    assert.equal(spec.configKind, 'ordered')
    assert.equal(typeof spec.order, 'number')
    assert.equal(spec.role, 'user')
  }
  const persona = specs.find((spec) => spec.id === 'persona-main')
  assert.equal(persona.layer, 'system-section')
  assert.equal(persona.params.sectionName, 'deployment:persona')
  assert.equal(persona.params.complete, true)
  assert.equal(persona.params.suppressRuntimeContext, true)
  assert.match(persona.text ?? persona.texts?.[0] ?? '', /helpful assistant/)
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

test('writePreset 主会话人设参数化：mainPersona 覆盖 persona-main text；空值保留模板默认', () => {
  const { byId } = generatedConfigs({ mainPersona: '你是专注于 dsh 插件的助手。' })
  const text = byId['persona-main'].text ?? byId['persona-main'].texts?.join(' ')
  assert.ok(text.includes('你是专注于 dsh 插件的助手'), 'mainPersona 覆盖 persona-main text')
  assert.equal(byId['persona-main'].params.sectionName, 'deployment:persona', '人设段身份保留')
  // 空值 = 模板默认人设（不覆盖）。
  const { byId: empty } = generatedConfigs({ mainPersona: '' })
  const emptyText = empty['persona-main'].text ?? empty['persona-main'].texts?.join(' ')
  assert.ok(!emptyText.includes('你是专注于 dsh 插件的助手'), '空 mainPersona 不覆盖模板默认')
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
  assert.equal(byId['instruction-hint'].enabled, true)
})
