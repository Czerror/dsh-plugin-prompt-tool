import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveProviderModels } from '../../src/client/app/workspace/pages/model-route-status.ts'

test('模型状态只返回当前选中服务商的模型', () => {
  const catalog = {
    deepseek: ['deepseek-chat', 'deepseek-reasoner'],
    openai: ['gpt-5', 'gpt-5-mini'],
  }
  assert.deepEqual(resolveProviderModels(catalog, 'openai', ['deepseek', 'openai']), {
    provider: 'openai',
    models: ['gpt-5', 'gpt-5-mini'],
  })
})

test('模型状态仅在服务商一致时补入宿主默认模型', () => {
  const catalog = { openai: ['gpt-5'] }
  assert.deepEqual(resolveProviderModels(catalog, 'openai', ['openai'], {
    provider: 'deepseek',
    model: 'deepseek-chat',
  }), {
    provider: 'openai',
    models: ['gpt-5'],
  })
  assert.deepEqual(resolveProviderModels({}, '', ['openai'], {
    provider: 'deepseek',
    model: 'deepseek-chat',
  }), {
    provider: 'deepseek',
    models: ['deepseek-chat'],
  })
})
