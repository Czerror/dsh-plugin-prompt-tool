import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectModels, installDefaultModelRoute } from '../../lib/index.mjs'

test('detectModels：providers 只含 live 注册路由，candidates 含 live + 可配置目录（dormant）', () => {
  const ctx = {
    get: () => ({
      listProviders: () => [
        { id: 'deepseek-official', name: 'DeepSeek' },
        { id: 'local-provider', name: 'Local' },
      ],
      listConfigurableProviders: () => [
        { provider: 'deepseek-official', displayName: 'DeepSeek' },
        { provider: 'amazon-bedrock', displayName: 'Amazon Bedrock' },
      ],
    }),
  }
  const detection = detectModels(ctx)
  assert.deepEqual(detection.providers, ['deepseek-official', 'local-provider'], '状态提示只显示已注册路由')
  assert.deepEqual(detection.candidates, ['deepseek-official', 'local-provider', 'amazon-bedrock'], '下拉候选含已注册 + 未注册目录')
  assert.equal(detection.available, true)
})

test('detectModels：无任何 provider 时 available=false 且带诊断', () => {
  const ctx = { get: () => ({ listProviders: () => [], listConfigurableProviders: () => [] }) }
  const detection = detectModels(ctx)
  assert.equal(detection.available, false)
  assert.deepEqual(detection.providers, [])
  assert.deepEqual(detection.candidates, [])
  assert.match(detection.error ?? '', /未返回任何 provider/)
})

test('installDefaultModelRoute：参数非空时写入官方 agent-default-model 默认选择', () => {
  const saved = []
  const ctx = {
    get: (name) => name === 'agentDefaultModel'
      ? { saveSelection: (selection) => { saved.push(selection) } }
      : undefined,
  }
  const apply = installDefaultModelRoute(
    ctx,
    () => true,
    () => 'deepseek-official',
    () => 'deepseek-v4-flash',
  )
  assert.deepEqual(saved, [{ provider: 'deepseek-official', model: 'deepseek-v4-flash' }], '安装时立即写入一次')
  apply()
  assert.equal(saved.length, 2, '重放幂等写入')
})

test('installDefaultModelRoute：未启用（任一参数为空）时不干预', () => {
  let called = false
  const ctx = {
    get: (name) => name === 'agentDefaultModel'
      ? { saveSelection: () => { called = true } }
      : undefined,
  }
  installDefaultModelRoute(ctx, () => false, () => '', () => '')
  assert.equal(called, false, '未设置固定模型路由时不得覆盖用户选择')
})

test('installDefaultModelRoute：agent-default-model 服务缺失时静默跳过不抛错', () => {
  const ctx = { get: () => undefined }
  const apply = installDefaultModelRoute(ctx, () => true, () => 'p', () => 'm')
  apply()
  assert.ok(true, '服务缺失不应抛异常')
})
