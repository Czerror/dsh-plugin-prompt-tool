import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  buildModelOptions,
  modelChoiceValue,
  parseModelChoice,
} from '../../src/client/features/models/model-options.ts'

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
