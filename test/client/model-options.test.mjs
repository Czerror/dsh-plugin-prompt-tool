import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  buildEffortOptions,
  buildModelOptions,
  modelChoiceValue,
  parseModelChoice,
} from '../../src/client/features/models/model-options.ts'

test('思维程度档位来自官方元数据：未查到不虚构，查到就用元数据（M-12）', () => {
  // 未查到（known:false）：只有已保存的当前值，不虚构 off/low/high/max。
  assert.deepEqual(buildEffortOptions(undefined, ''), [], '未知能力时不给任何档位')
  assert.deepEqual(
    buildEffortOptions({ known: false, efforts: [] }, 'high'),
    [{ value: 'high', label: 'high（当前值，模型未声明）' }],
    '存量值保留回显，但不额外编造档位',
  )

  // 已知但该模型不提供推理档位：同样不虚构。
  assert.deepEqual(buildEffortOptions({ known: true, efforts: [] }, ''), [], '模型明确无档位时不显示选择')

  // 已知且声明了档位：选项与显示名都来自元数据，未声明默认档位时补「模型默认」。
  assert.deepEqual(
    buildEffortOptions({ known: true, efforts: [{ id: 'low', name: '低' }, { id: 'high', name: '高' }] }, ''),
    [{ value: '', label: '（模型默认）' }, { value: 'low', label: '低' }, { value: 'high', label: '高' }],
  )

  // 缺 name 用 id 兜底；重复 id 去重；不在目录中的存量值保留。
  assert.deepEqual(
    buildEffortOptions({ known: true, efforts: [{ id: 'low' }, { id: 'low', name: '重复' }] }, 'max'),
    [{ value: 'low', label: 'low' }, { value: 'max', label: 'max（当前值，模型未声明）' }],
  )
})

const cardSource = readFileSync(new URL('../../src/client/features/models/ModelRouteCard.tsx', import.meta.url), 'utf8')

test('模型路由卡只保留模型选择，服务商由模型选项内部回写', () => {
  assert.doesNotMatch(cardSource, /ariaLabel="[^"]*服务商"/)
  assert.match(cardSource, /buildModelOptions/)
  assert.match(cardSource, /parseModelChoice/)
})

test('模型下拉展平全部服务商并按服务商连续分组', () => {
  const options = buildModelOptions({
    deepseek: ['deepseek-chat', 'deepseek-reasoner'],
    openai: ['gpt-5', 'gpt-5-mini'],
  })
  assert.deepEqual(options.map(({ group, label }) => [group, label]), [
    [undefined, '（不设置，继承默认）'],
    ['deepseek', 'deepseek-chat'],
    ['deepseek', 'deepseek-reasoner'],
    ['openai', 'gpt-5'],
    ['openai', 'gpt-5-mini'],
  ])
})

test('同名模型用 provider+model 复合值区分，并保留当前/宿主回显', () => {
  const options = buildModelOptions(
    { deepseek: ['chat'], openai: ['chat'] },
    [{ provider: 'local', model: 'custom' }, { provider: 'openai', model: 'chat' }],
  )
  assert.equal(options.filter((option) => option.label === 'chat').length, 2)
  assert.ok(options.some((option) => option.value === modelChoiceValue('local', 'custom')))
  assert.deepEqual(parseModelChoice(modelChoiceValue('openai', 'chat')), { provider: 'openai', model: 'chat' })
  assert.equal(parseModelChoice(''), undefined)
})
