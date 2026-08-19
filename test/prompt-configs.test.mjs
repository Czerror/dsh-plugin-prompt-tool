import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'
import {
  buildDefaultPromptConfigs,
  buildPromptConfigFiles,
  loadPromptConfigFiles,
  mergePromptConfigs,
  renderPromptConfigYaml,
} from '../lib/preset-core.mjs'

test('默认四条提示词配置 spec 渲染后 YAML 可解析且字段完整', () => {
  const specs = buildDefaultPromptConfigs({ anchorFirstTurn: true, guideCustom: true, guideText: 'CUSTOM' }, 'PROMPT')
  assert.deepEqual(specs.map((spec) => spec.id), ['near-anchor', 'router-guide', 'prompt-injector', 'instruction-hint'])
  for (const spec of specs) {
    const doc = parse(renderPromptConfigYaml(spec), { logLevel: 'silent' })
    assert.equal(doc.id, spec.id)
    assert.equal(doc.layer, spec.layer)
    assert.equal(doc.enabled, spec.enabled)
    assert.equal(doc.strategy, spec.strategy)
  }
})

test('mergePromptConfigs：同名 id 后者覆盖且保留位置，新 id 追加末尾', () => {
  const defaults = buildDefaultPromptConfigs({}, 'P')
  const merged = mergePromptConfigs(defaults, [
    { id: 'near-anchor', enabled: false, strategy: 'static', text: '覆盖后的锚点' },
    { id: 'extra', strategy: 'static', layer: 'system-section', text: '新增提示词配置' },
  ])
  assert.deepEqual(merged.map((spec) => spec.id), ['near-anchor', 'router-guide', 'prompt-injector', 'instruction-hint', 'extra'])
  assert.equal(merged[0].enabled, false)
  assert.equal(merged[0].text, '覆盖后的锚点')
  assert.equal(merged[4].layer, 'system-section')
})

test('buildPromptConfigFiles 合并自定义提示词配置后生成 00-40 文件名且内容正确', () => {
  const files = buildPromptConfigFiles({}, 'P', [
    { id: 'near-anchor', text: '覆盖内容' },
    { id: 'custom', strategy: 'static', layer: 'runtime-context', text: '自定义上下文' },
  ])
  assert.deepEqual(files.map((entry) => entry.file), [
    '00-near-anchor.yml',
    '10-router-guide.yml',
    '20-prompt-injector.yml',
    '30-instruction-hint.yml',
    '40-custom.yml',
  ])
  const near = parse(files[0].content, { logLevel: 'silent' })
  assert.equal(near.text, '覆盖内容')
  const custom = parse(files[4].content, { logLevel: 'silent' })
  assert.equal(custom.layer, 'runtime-context')
  assert.equal(custom.text, '自定义上下文')
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
    subagents: 'inherit',
    modelScope: 'pro',
    sourceKind: 'full-kind',
    form: 'hint',
    summary: '摘要',
    text: '第一行\n第二行',
    templateFile: 'template.json',
    fill: 'env-facts',
    variables: { WHO: '李雷' },
    identity: { field: 'kind', value: 'full-kind' },
    params: { toolNames: 'bash,run_code', patch: { maxTokens: 2048 } },
  })
  const doc = parse(yaml, { logLevel: 'silent' })
  assert.equal(doc.id, 'full')
  assert.equal(doc.layer, 'tool-pipeline')
  assert.equal(doc.text, '第一行\n第二行')
  assert.deepEqual(doc.identity, { field: 'kind', value: 'full-kind' })
  assert.deepEqual(doc.variables, { WHO: '李雷' })
  assert.equal(doc.params.toolNames, 'bash,run_code')
  assert.deepEqual(doc.params.patch, { maxTokens: 2048 })
})
function configByName(options, prompt, name) {
  const config = buildPromptConfigFiles(options, prompt).find((entry) => entry.file.includes(name))
  assert.ok(config, `${name} config file generated`)
  return { content: config.content, yaml: parse(config.content, { logLevel: 'silent' }) }
}


test('buildPromptConfigFiles 恒生成四个提示词配置模块，数字前缀决定执行顺序', () => {
  const files = buildPromptConfigFiles({}, 'PROMPT')
  assert.deepEqual(files.map((entry) => entry.file), [
    '00-near-anchor.yml',
    '10-router-guide.yml',
    '20-prompt-injector.yml',
    '30-instruction-hint.yml',
  ])
  for (const entry of files) {
    const doc = parse(entry.content, { logLevel: 'silent' })
    assert.ok(doc.id)
    assert.equal(typeof doc.strategy, 'string')
    assert.equal(typeof doc.enabled, 'boolean')
    assert.equal(doc.layer, 'pre-step')
    assert.equal(doc.configKind, 'ordered')
    assert.equal(typeof doc.order, 'number')
    assert.equal(doc.role, 'user')
  }
})


test('buildPromptConfigFiles 处理空提示词时提示词配置结构完整', () => {
  const { yaml } = configByName({}, '', '20-prompt-injector')
  assert.equal(yaml.enabled, true)
  assert.equal(yaml.strategy, 'anchor-fallback')
  assert.equal(yaml.params.text, '')
  assert.equal(yaml.params.anchorWord, 'we')
})


test('buildPromptConfigFiles 开启 anchorFirstTurn 时 near-anchor 提示词配置启用并携带自定义锚定句', () => {
  const { yaml } = configByName({ anchorFirstTurn: true, anchorText: 'ANCHOR SENTENCE' }, 'PROMPT', '00-near-anchor')
  assert.equal(yaml.enabled, true)
  assert.equal(yaml.strategy, 'anchor-auto')
  assert.equal(yaml.position, 'after-user')
  assert.equal(yaml.params.useCustom, false)
  assert.equal(yaml.params.anchorText, 'ANCHOR SENTENCE')
})


test('buildPromptConfigFiles 开启 anchorCustom 时 near-anchor 固定使用自定义文本', () => {
  const { yaml } = configByName({ anchorFirstTurn: true, anchorText: 'CUSTOM', anchorCustom: true }, 'PROMPT', '00-near-anchor')
  assert.equal(yaml.params.useCustom, true)
  assert.equal(yaml.params.anchorText, 'CUSTOM')
})


test('buildPromptConfigFiles 开启 anchorFirstTurn 且空锚点文本时生成自动模式配置', () => {
  const { yaml } = configByName({ anchorFirstTurn: true, anchorText: '' }, 'PROMPT', '00-near-anchor')
  assert.equal(yaml.params.anchorText, '')
})


test('buildPromptConfigFiles 关闭 injectPrompt 时 prompt-injector 提示词配置禁用（引擎仍扫描四个模块）', () => {
  const { yaml } = configByName({ injectPrompt: false }, 'PROMPT', '20-prompt-injector')
  assert.equal(yaml.enabled, false)
})

test('buildPromptConfigFiles 默认 router-guide 提示词配置关闭，自动引导', () => {
  const { yaml } = configByName({}, 'PROMPT', '10-router-guide')
  assert.equal(yaml.enabled, false)
  assert.equal(yaml.modelScope, 'flash')
  assert.equal(yaml.params.useCustom, false)
  assert.equal(yaml.params.text, '')
})


test('buildPromptConfigFiles 开启 anchorFirstTurn 时 router-guide 提示词配置启用', () => {
  const { yaml } = configByName({ anchorFirstTurn: true }, 'PROMPT', '10-router-guide')
  assert.equal(yaml.enabled, true)
  assert.equal(yaml.modelScope, 'flash')
  assert.equal(yaml.params.useCustom, false)
})


test('buildPromptConfigFiles guideCustom=true 时固定自定义每轮引导（Pro/Flash 都注入）', () => {
  const { yaml } = configByName({ anchorFirstTurn: true, guideCustom: true, guideText: 'CUSTOM GUIDE' }, 'PROMPT', '10-router-guide')
  assert.equal(yaml.enabled, true)
  assert.equal(yaml.modelScope, 'all')
  assert.equal(yaml.params.useCustom, true)
  assert.equal(yaml.params.text, 'CUSTOM GUIDE')
})


test('buildPromptConfigFiles injectPrompt=false 且 anchorFirstTurn=true 只启用近锚提示词配置', () => {
  const files = buildPromptConfigFiles({ injectPrompt: false, anchorFirstTurn: true, anchorText: 'A' }, 'PROMPT')
  const byName = Object.fromEntries(files.map((entry) => [entry.file, parse(entry.content, { logLevel: 'silent' })]))
  assert.equal(byName['00-near-anchor.yml'].enabled, true)
  assert.equal(byName['10-router-guide.yml'].enabled, true)
  assert.equal(byName['20-prompt-injector.yml'].enabled, false)
  assert.equal(byName['30-instruction-hint.yml'].enabled, true)
})


