import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parse } from 'yaml'
import { loadPromptTemplates, validatePromptConfigs } from '../../lib/index.mjs'

test('loadPromptTemplates：按文件名数字前缀顺序返回包内模板库', () => {
  const templates = loadPromptTemplates()
  assert.equal(templates.length, 16)
  assert.deepEqual(templates.map((template) => template.file), [
    '10-pre-step.yml',
    '11-merged-a.yml',
    '12-merged-b.yml',
    '13-anchor.yml',
    '14-first-turn-anchor.yml',
    '15-guide-auto.yml',
    '16-custom-fallback.yml',
    '17-instruction-hint.yml',
    '18-placeholder-env-facts.yml',
    '19-placeholder-skill-catalog.yml',
    '20-system-section.yml',
    '30-runtime-context.yml',
    '31-runtime-context-placeholder.yml',
    '40-agent-request.yml',
    '50-llm-stream.yml',
    '60-tool-pipeline.yml',
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
  assert.equal(byId.get('example-skill-catalog').fill, 'skill-catalog')
})

test('merged 模板对保持同 position + 同 mergeGroup，priority 递增', () => {
  const specs = loadPromptTemplates().map((template) => template.spec)
  const a = specs.find((spec) => spec.id === 'example-merged-a')
  const b = specs.find((spec) => spec.id === 'example-merged-b')
  assert.equal(a.mergeMode, 'merged')
  assert.equal(b.mergeMode, 'merged')
  assert.equal(a.position, 'before-all')
  assert.equal(b.position, 'before-all')
  assert.equal(a.mergeGroup, 'grp')
  assert.equal(b.mergeGroup, 'grp')
  assert.equal(a.priority, 0)
  assert.equal(b.priority, 1)
})

test('模板库全部条目通过引擎权威校验（模板即合法配置）', async () => {
  for (const template of loadPromptTemplates()) {
    const result = await validatePromptConfigs([template.spec])
    assert.equal(result.valid, true, `${template.file}: ${JSON.stringify(result.errors)}`)
  }
})
