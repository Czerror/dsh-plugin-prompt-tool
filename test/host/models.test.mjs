import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  detectModels,
  installDefaultModelRoute,
  invalidateModelCatalog,
  listAdvertisedModels,
  peekModelCatalog,
  resolveSubagentStartOptions,
} from '../../lib/index.mjs'

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

test('installDefaultModelRoute：仅思维程度非空时与宿主当前选择合并写入（不劫持模型路由）', () => {
  const saved = []
  const ctx = {
    get: (name) => name === 'agentDefaultModel'
      ? {
          currentSelection: () => ({ provider: 'host-p', model: 'host-m', reasoningEffort: 'low' }),
          saveSelection: (selection) => { saved.push(selection) },
        }
      : undefined,
  }
  installDefaultModelRoute(ctx, () => true, () => '', () => '', () => 'high')
  assert.deepEqual(saved, [{ provider: 'host-p', model: 'host-m', reasoningEffort: 'high' }],
    '思维程度应合并宿主当前默认选择写入')
})

test('installDefaultModelRoute：仅思维程度但宿主无当前选择时不写盘', () => {
  let called = false
  const ctx = {
    get: (name) => name === 'agentDefaultModel'
      ? { currentSelection: () => ({}), saveSelection: () => { called = true } }
      : undefined,
  }
  installDefaultModelRoute(ctx, () => true, () => '', () => '', () => 'high')
  assert.equal(called, false, '宿主当前选择缺 provider/model 时跳过，不写非法选择')
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

test('模型目录缓存按 Context 实例隔离：两个 Context 互不污染（M-10）', async () => {
  const makeCtx = (provider, models) => ({
    get: () => ({
      listProviders: () => [{ id: provider }],
      listModels: async () => models.map((id) => ({ id })),
    }),
  })
  const first = makeCtx('provider-a', ['a-1'])
  const second = makeCtx('provider-b', ['b-1'])
  assert.deepEqual(await listAdvertisedModels(first), { 'provider-a': ['a-1'] })
  assert.deepEqual(peekModelCatalog(first), { 'provider-a': ['a-1'] })
  assert.deepEqual(peekModelCatalog(second), {}, '未查询过的 Context 不得命中另一个 Context 的缓存')
  assert.deepEqual(await listAdvertisedModels(second), { 'provider-b': ['b-1'] })
  assert.deepEqual(peekModelCatalog(first), { 'provider-a': ['a-1'] }, '第二个 Context 刷新不得覆盖第一个')
})

test('模型目录并发刷新合并为一次 provider 查询（M-10）', async () => {
  let calls = 0
  const ctx = {
    get: () => ({
      listProviders: () => [{ id: 'provider-a' }],
      listModels: async () => {
        calls += 1
        return [{ id: 'a-1' }]
      },
    }),
  }
  const [first, second] = await Promise.all([listAdvertisedModels(ctx), listAdvertisedModels(ctx)])
  assert.deepEqual(first, { 'provider-a': ['a-1'] })
  assert.deepEqual(second, { 'provider-a': ['a-1'] })
  assert.equal(calls, 1, '同源并发刷新只查询一次')
})

test('installDefaultModelRoute：apply 返回可等待的同步结果（synced/unchanged/unavailable/failed）', async () => {
  const saved = []
  let host = { provider: 'p', model: 'm', reasoningEffort: 'low' }
  const ctx = {
    get: (name) => name === 'agentDefaultModel'
      ? {
        currentSelection: () => host,
        saveSelection: async (next) => {
          saved.push(next)
          host = { ...next }
        },
      }
      : undefined,
  }
  const apply = installDefaultModelRoute(ctx, () => true, () => 'p', () => 'm', () => 'high')
  const afterInstall = await apply()
  assert.ok(['synced', 'unchanged'].includes(afterInstall.status), 'apply 必须返回四态结果而不是 undefined')
  assert.deepEqual(saved, [{ provider: 'p', model: 'm', reasoningEffort: 'high' }], '安装时同步一次且只写一次')
  assert.equal((await apply()).status, 'unchanged', '宿主值已是目标值时不再写盘')
  assert.equal(saved.length, 1, 'unchanged 不得重复写盘')

  host = { provider: 'p', model: 'other', reasoningEffort: 'high' }
  const changed = await apply()
  assert.equal(changed.status, 'synced', '宿主模型被外部改动后再次同步并报告 synced')
  assert.equal(saved.length, 2)

  const noService = { get: () => undefined }
  const unavailable = await installDefaultModelRoute(noService, () => true, () => 'p', () => 'm')()
  assert.equal(unavailable.status, 'unavailable', '服务缺失必须与失败区分')
  assert.match(unavailable.message ?? '', /agent-default-model/)

  const failing = {
    get: (name) => name === 'agentDefaultModel'
      ? { saveSelection: async () => { throw new Error('EACCES: D:\\secret\\path.json') } }
      : undefined,
  }
  const failed = await installDefaultModelRoute(failing, () => true, () => 'p', () => 'm')()
  assert.equal(failed.status, 'failed', '写盘拒绝必须报告 failed（可重试）')
  assert.ok((failed.message ?? '').length <= 200, '失败提示限长')
  assert.ok(!(failed.message ?? '').includes('secret'), '失败提示不得带出绝对路径')
})

test('模型目录失效：invalidateModelCatalog 后重新全量查询，旧缓存不再命中（M-11）', async () => {
  let calls = 0
  const ctx = {
    get: () => ({
      listProviders: () => [{ id: 'provider-a' }],
      listModels: async () => {
        calls += 1
        return [{ id: `a-${calls}` }]
      },
    }),
  }
  assert.deepEqual(await listAdvertisedModels(ctx), { 'provider-a': ['a-1'] })
  assert.deepEqual(peekModelCatalog(ctx), { 'provider-a': ['a-1'] })
  invalidateModelCatalog(ctx)
  assert.deepEqual(peekModelCatalog(ctx), {}, '失效后 describe 不再读到旧目录')
  assert.deepEqual(await listAdvertisedModels(ctx), { 'provider-a': ['a-2'] }, '失效后重新查询 provider')
  assert.equal(calls, 2)
})

test('模型目录失效在 provider 拓扑变化时接线（llm/adapters-updated）', () => {
  const source = readFileSync(new URL('../../src/index.ts', import.meta.url), 'utf8')
  assert.match(source, /llm\/adapters-updated/, 'index.ts 必须订阅官方 provider 拓扑变化事件')
  assert.match(source, /invalidateModelCatalog\(ctx\)/, '事件回调按 Context 失效目录缓存')
})

test('resolveSubagentStartOptions：只在成对配置时产出显式 agentOptions，不碰 registry（M-06）', () => {
  assert.equal(resolveSubagentStartOptions(() => false, () => 'p', () => 'm'), undefined, '未启用时不产出')
  assert.equal(resolveSubagentStartOptions(() => true, () => '', () => 'm'), undefined, '半路由不产出')
  assert.equal(resolveSubagentStartOptions(() => true, () => 'p', () => ''), undefined, '半路由不产出')
  assert.deepEqual(resolveSubagentStartOptions(() => true, () => 'p', () => 'm'), { provider: 'p', model: 'm' })
  assert.deepEqual(
    resolveSubagentStartOptions(() => true, () => 'p', () => 'm', () => 'high'),
    { provider: 'p', model: 'm', reasoningEffort: 'high' },
  )
  assert.deepEqual(
    resolveSubagentStartOptions(() => true, () => 'p', () => 'm', () => '   '),
    { provider: 'p', model: 'm' },
    '空 effort 不写入',
  )
})
