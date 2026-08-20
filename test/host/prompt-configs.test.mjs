import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'
import {
  loadPromptConfigFiles,
  mergePromptConfigs,
  renderPromptConfigYaml,
} from '../../lib/preset-core.mjs'
import { writePreset } from '../../lib/index.mjs'

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
      guideText: options.guideText ?? '',
      guideCustom: options.guideCustom === true,
      injectPrompt: options.injectPrompt !== false,
      subagentModelProvider: '',
      subagentModelName: '',
      bootstrapMaxTokens: 0,
      usePtcMode: true,
      promptConfigs: [],
      promptConfigsDir: '',
    })
    const specs = loadPromptConfigFiles(join(dir, 'prompt-configs'))
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
  assert.deepEqual(merged.map((spec) => spec.id), ['near-anchor', 'router-guide', 'prompt-injector', 'instruction-hint', 'extra'])
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
    assert.throws(() => loadPromptConfigFiles(join(dir, 'missing')), /not readable/)
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
    audience: '公用',
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

test('writePreset 生成 anchored 四个提示词配置模块，数字前缀决定执行顺序', () => {
  const { specs } = generatedConfigs()
  assert.deepEqual(specs.map((spec) => spec.id), ['near-anchor', 'router-guide', 'prompt-injector', 'instruction-hint'])
  for (const spec of specs) {
    assert.equal(spec.layer, 'pre-step')
    assert.equal(spec.configKind, 'ordered')
    assert.equal(typeof spec.order, 'number')
    assert.equal(spec.role, 'user')
  }
})

test('writePreset 处理空提示词时 prompt-injector 结构完整', () => {
  const { byId } = generatedConfigs({}, '')
  assert.equal(byId['prompt-injector'].enabled, true)
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
  assert.equal(byId['near-anchor'].params.firstTurnText, 'ANCHOR SENTENCE')
})

test('writePreset 开启 firstTurnCustom 时 near-anchor 固定使用自定义文本', () => {
  const { byId } = generatedConfigs({ firstTurnAnchor: true, firstTurnText: 'CUSTOM', firstTurnCustom: true })
  assert.equal(byId['near-anchor'].params.useCustom, true)
  assert.equal(byId['near-anchor'].params.firstTurnText, 'CUSTOM')
})

test('writePreset 开启 firstTurnAnchor 且空锚点文本时生成自动模式配置', () => {
  const { byId } = generatedConfigs({ firstTurnAnchor: true, firstTurnText: '' })
  assert.equal(byId['near-anchor'].params.firstTurnText, '')
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
