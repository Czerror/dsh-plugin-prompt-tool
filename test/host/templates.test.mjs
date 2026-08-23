import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parse } from 'yaml'
import { loadPromptTemplates, validatePromptConfigs } from '../../lib/index.mjs'

test('loadPromptTemplates：按文件名数字前缀顺序返回包内模板库', () => {
  const templates = loadPromptTemplates()
  assert.equal(templates.length, 11)
  assert.deepEqual(templates.map((template) => template.file), [
    '10-pre-step.yml',
    '14-first-turn-anchor.yml',
    '15-guide-auto.yml',
    '16-custom-fallback.yml',
    '18-placeholder-env-facts.yml',
    '20-system-section.yml',
    '30-runtime-context.yml',
    '40-agent-request.yml',
    '50-llm-stream.yml',
    '60-tool-pipeline.yml',
    '70-subagent-maintenance.yml',
  ])
})

test('loadPromptTemplates：content 是合法单对象 YAML 且与解析后的 spec 一致', () => {
  for (const template of loadPromptTemplates()) {
    const doc = parse(template.content)
    assert.deepEqual(doc, template.spec, template.file)
    assert.equal(typeof template.spec.id, 'string')
    assert.ok(template.spec.id.length > 0, template.file)
  }
})

test('模板库覆盖六个注入层级与两个 placeholder 数据源', () => {
  const specs = loadPromptTemplates().map((template) => template.spec)
  const byId = new Map(specs.map((spec) => [spec.id, spec]))
  assert.equal(byId.get('example-pre-step').layer, 'pre-step')
  assert.equal(byId.get('example-system-section').layer, 'system-section')
  assert.equal(byId.get('example-runtime-context').layer, 'runtime-context')
  assert.equal(byId.get('example-agent-request').layer, 'agent-request')
  assert.equal(byId.get('example-llm-stream').layer, 'llm-stream')
  assert.equal(byId.get('example-tool-pipeline').layer, 'tool-pipeline')
  assert.equal(byId.get('example-placeholder').fill, 'env-facts')
})

test('pre-step 通用模板覆盖字段变体：mergeMode / configKind 可切换', () => {
  const specs = loadPromptTemplates().map((template) => template.spec)
  const a = specs.find((spec) => spec.id === 'example-pre-step')
  assert.equal(a.mergeMode, 'separate')
  assert.equal(a.configKind, 'ordered')
})

test('模板库全部条目通过引擎权威校验（模板即合法配置）', async () => {
  for (const template of loadPromptTemplates()) {
    const result = await validatePromptConfigs([template.spec])
    assert.equal(result.valid, true, `${template.file}: ${JSON.stringify(result.errors)}`)
  }
})
