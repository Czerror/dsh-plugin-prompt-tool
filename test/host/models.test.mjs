import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectModels, installDefaultModelRoute, listAdvertisedModels } from '../../lib/index.mjs'

test('detectModels：只统计 live 注册路由', () => {
  const ctx = {
    get: () => ({
      listProviders: () => [
        { id: 'deepseek-official', name: 'DeepSeek' },
        { id: 'local-provider', name: 'Local' },
      ],
    }),
  }
  const detection = detectModels(ctx)
  assert.deepEqual(detection.providers, ['deepseek-official', 'local-provider'], '只显示 live 注册路由')
  assert.equal(detection.available, true)
})

test('detectModels：无 live provider 时 available=false 且带诊断（含 dormant 目录不算检测到）', () => {
  const ctx = { get: () => ({ listProviders: () => [] }) }
  const detection = detectModels(ctx)
  assert.equal(detection.available, false)
  assert.deepEqual(detection.providers, [])
  assert.match(detection.error ?? '', /未返回任何 provider/)
})

test('listAdvertisedModels：官方类方法风格 mock（依赖 this）也能查询到模型目录（防解构丢 this 回归）', async () => {
  // 官方 LlmRuntime.listModels 是类方法（内部经 this 访问 adapters/registration）：
  // mock 用真实类方法风格，解构调用（llm.listModels 提变量）会丢 this 抛错被吞。
  class MockLlm {
    provider = 'deepseek-official'

    listProviders() {
      return [{ id: this.provider, name: 'DeepSeek' }]
    }

    async listModels(provider) {
      assert.equal(provider, this.provider, 'listModels 应经 this 校验 provider（解构调用会失败）')
      return [
        { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', provider },
        { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', provider },
      ]
    }
  }
  const ctx = { get: () => new MockLlm() }
  const catalog = await listAdvertisedModels(ctx)
  assert.deepEqual(catalog, {
    'deepseek-official': ['deepseek-v4-flash', 'deepseek-v4-pro'],
  })
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

test('installDefaultModelRoute：saveSelection 返回被拒 Promise 不产生 unhandledRejection', async () => {
  const rejections = []
  const onUnhandled = (reason) => rejections.push(reason)
  process.on('unhandledRejection', onUnhandled)
  const ctx = {
    get: (name) => name === 'agentDefaultModel'
      ? { saveSelection: () => Promise.reject(new Error('save failed')) }
      : undefined,
  }
  try {
    installDefaultModelRoute(ctx, () => true, () => 'p', () => 'm', () => 'high')
    // 给拒绝传播一个宏任务窗口。
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.deepEqual(rejections, [], '被拒 Promise 必须被捕获，不得触发 unhandledRejection')
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
})
