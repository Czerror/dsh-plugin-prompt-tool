import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parse } from 'yaml'
import { Config, PromptSettingsSchema, validatePromptConfigs } from '../../lib/index.mjs'

const validSpecs = [
  { id: 'sys', name: '系统段', layer: 'system-section', strategy: 'static', order: -50, text: '你是助手', params: { complete: false } },
  { id: 'extra', layer: 'pre-step', strategy: 'static', text: '额外注入', position: 'after-all', dedupe: 'session' },
]

test('validatePromptConfigs：合法数组返回 valid=true、回显输入并渲染逐条 yml 预览', async () => {
  const result = await validatePromptConfigs(validSpecs)
  assert.equal(result.valid, true)
  assert.deepEqual(result.errors, [])
  assert.equal(result.configs.length, 2)
  assert.equal(result.files.length, 2)
  assert.equal(result.files[0].file, '00-sys.yml')
  const doc = parse(result.files[1].content)
  assert.equal(doc.id, 'extra')
  assert.equal(doc.layer, 'pre-step')
  assert.equal(doc.dedupe, 'session')
})

test('validatePromptConfigs：非数组返回结构层错误', async () => {
  const result = await validatePromptConfigs({ id: 'x' })
  assert.equal(result.valid, false)
  assert.equal(result.errors.length, 1)
  assert.equal(result.errors[0].index, -1)
  assert.match(result.errors[0].message, /promptConfigs must be an array/)
})

test('validatePromptConfigs：元素非对象逐条定位 index', async () => {
  const result = await validatePromptConfigs([{ id: 'ok', text: 'A' }, null, 3])
  assert.equal(result.valid, false)
  assert.equal(result.errors.length, 2)
  assert.equal(result.errors[0].index, 1)
  assert.match(result.errors[0].message, /configs\[1\] must be an object/)
  assert.equal(result.errors[1].index, 2)
})

test('validatePromptConfigs：id 缺失或非字符串给出结构层错误', async () => {
  const result = await validatePromptConfigs([{ text: 'A' }, { id: '', text: 'B' }, { id: 42 }])
  assert.equal(result.valid, false)
  assert.deepEqual(result.errors.map((error) => error.index), [0, 1, 2])
  assert.match(result.errors[0].message, /configs\[0\]\.id must be a non-empty string/)
  assert.match(result.errors[2].message, /configs\[2\]\.id must be a non-empty string/)
})

test('validatePromptConfigs：未知 layer / strategy / fill 由引擎权威校验并保留 index', async () => {
  const result = await validatePromptConfigs([
    { id: 'bad-layer', layer: 'nope', text: 'A' },
    { id: 'bad-strategy', strategy: 'nope', text: 'B' },
    { id: 'bad-fill', strategy: 'placeholder', fill: 'nope', layer: 'pre-step' },
  ])
  assert.equal(result.valid, false)
  assert.equal(result.errors.length, 3)
  assert.deepEqual(result.errors.map((error) => error.id), ['bad-layer', 'bad-strategy', 'bad-fill'])
  assert.match(result.errors[0].message, /unknown layer "nope"/)
  assert.match(result.errors[1].message, /unknown strategy "nope"/)
  assert.match(result.errors[2].message, /requires fill/)
})

test('validatePromptConfigs：placeholder 层限制与坏 templateFile 由引擎校验', async () => {
  const result = await validatePromptConfigs([
    { id: 'bad-placeholder-layer', layer: 'system-section', strategy: 'placeholder', fill: 'env-facts' },
    { id: 'bad-template', strategy: 'static', templateFile: './missing-template.yml' },
  ])
  assert.equal(result.valid, false)
  assert.match(result.errors[0].message, /supports layer pre-step or runtime-context only/)
  assert.match(result.errors[1].message, /templateFile "\.\/missing-template\.yml" is not readable/)
})

test('validatePromptConfigs：一条坏配置不吞掉其余错误，全部收集', async () => {
  const result = await validatePromptConfigs([
    { id: 'bad-1', layer: 'nope' },
    { id: 'ok', strategy: 'static', text: 'OK' },
    { id: 'bad-2', strategy: 'placeholder', fill: 'nope' },
  ])
  assert.equal(result.valid, false)
  assert.deepEqual(result.errors.map((error) => error.id), ['bad-1', 'bad-2'])
  assert.deepEqual(result.errors.map((error) => error.index), [0, 2])
})

test('Config / PromptSettingsSchema：只强校验 id，其余字段宽松透传', () => {
  const input = { promptConfigs: [{ id: 'x', layer: 'system-section', params: { complete: true }, text: 'A' }] }
  const config = Config(input)
  assert.equal(config.promptConfigs[0].id, 'x')
  assert.equal(config.promptConfigs[0].layer, 'system-section')
  assert.equal(config.promptConfigs[0].params.complete, true)
  assert.equal(config.promptConfigs[0].text, 'A')
  const settings = PromptSettingsSchema(input)
  assert.equal(settings.promptConfigs[0].layer, 'system-section')
  assert.equal(settings.promptConfigs[0].params.complete, true)
})

test('Config / PromptSettingsSchema：元素缺 id 或元素非对象在 settings 层即拒绝', () => {
  assert.throws(() => Config({ promptConfigs: [{ layer: 'pre-step' }] }), /missing required value/)
  assert.throws(() => PromptSettingsSchema({ promptConfigs: [{ layer: 'pre-step' }] }), /missing required value/)
  assert.throws(() => Config({ promptConfigs: [{ id: 42 }] }), /expected string/)
  assert.throws(() => PromptSettingsSchema({ promptConfigs: [{ id: 42 }] }), /expected string/)
  assert.throws(() => Config({ promptConfigs: [1] }), /expected object/)
  assert.throws(() => PromptSettingsSchema({ promptConfigs: 'x' }), /expected array/)
})
