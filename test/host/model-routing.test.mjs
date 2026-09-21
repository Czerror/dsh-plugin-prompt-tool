/**
 * 模型路由与模型目录的宿主侧核验。
 *
 * - models：模型检测、模型目录缓存（按 Context 隔离 / 并发合并 / 显式失效）。
 * - model-catalog-refresh（M-11）：`/models` 默认走 10 分钟缓存；显式刷新（客户端 connection/reset、
 *   用户重试）传 `refresh: true` 时必须越过 TTL 重新查询，且非法 body 走统一 400 包装。
 * - param-overrides：只重建当前预设；预设参数不回写全局默认模型。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isolatedHome } from '../fixtures/host-harness.mjs'

const { presetRoot } = isolatedHome('pt-model-routing-')
const {
  BRIDGE_ENDPOINTS,
  apply,
  detectModels,
  invalidateModelCatalog,
  listAdvertisedModels,
  peekModelCatalog,
  registerSettingsBridge,
  resolveSubagentStartOptions,
} = await import('../../lib/index.mjs')

const PREFIX = '/api/prompt-tool/settings'

// —— 模型路由单元用例（原 models.test.mjs） ——

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

/**
 * 行为断言（原实现读 `src/index.ts` 做源码正则匹配，2026-09-17 Wave 2 升级）：
 * 用最小 mock ctx 驱动真实 `apply()`，先填充模型目录缓存，再触发官方 provider 拓扑事件，
 * 断言缓存确实被失效且下一次查询真的重新访问 provider —— 覆盖「接线存在」+「失效生效」两件事。
 * mock ctx 的形状取自既有 `write-preset.test.mjs`（同一套可驱动 apply 的最小宿主面）。
 */
function makeApplyProbeCtx(llm, listeners) {
  const value = { writePreset: false, presetTemplate: 'standard', skillOrder: [], skillsDirs: [], skillRankBase: 250, presetOrder: 5, fallbackText: '' }
  const makeSctx = () => ({
    settings: {
      describe: () => [],
      register: (_ns, _schema, opts) => {
        try { opts.base() } catch { /* mock 环境无宿主上下文 */ }
        return { get: () => value, watch: (cb) => cb(value) }
      },
      installSection: (_owner, _ns, _schema, _entry, hooks) => {
        hooks.setSource(() => value)
        hooks.onChange()
      },
      get: () => undefined,
      mutate: async () => {},
    },
    webServer: { register: () => () => {} },
    commands: { register: () => () => {} },
    tools: { register: () => () => {} },
    effect: (fn) => { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
    on: () => () => {},
    get: (name) => (name === 'llm' ? llm : undefined),
  })
  return {
    logger: { warn: () => {} },
    effect: (fn) => { fn(); return () => {} },
    // 真实 cordis Context 提供事件订阅；本 mock 记录插件订阅的 provider 拓扑事件供用例触发。
    on: (type, handler) => { listeners.set(type, handler); return () => {} },
    skills: { registerProvider: () => {} },
    get: (name) => (name === 'webServer' ? {} : (name === 'llm' ? llm : undefined)),
    provide: () => () => {},
    baseUrl: 'http://localhost:3000',
    inject: (_deps, cb) => { cb(makeSctx()); return () => {} },
  }
}

test('模型目录失效在 provider 拓扑变化时接线（llm/adapters-updated）', async () => {
  let calls = 0
  const llm = {
    listProviders: () => [{ id: 'provider-e2e' }],
    async listModels() {
      calls += 1
      return [{ id: `provider-e2e-${calls}` }]
    },
  }
  const listeners = new Map()
  const ctx = makeApplyProbeCtx(llm, listeners)
  apply(ctx, { writePreset: false, presetTemplate: 'standard', skillOrder: [], skillsDirs: [], skillRankBase: 250, presetOrder: 5, fallbackText: '' })

  // 先填充缓存：目录来自 provider 的一次真实查询。
  assert.deepEqual(await listAdvertisedModels(ctx), { 'provider-e2e': ['provider-e2e-1'] })
  assert.equal(calls, 1)

  // 接线存在：apply 必须订阅官方 provider 拓扑变化事件。
  const handler = listeners.get('llm/adapters-updated')
  assert.equal(typeof handler, 'function', 'index.ts 必须订阅官方 provider 拓扑变化事件')

  // 事件生效：缓存失效，下一次查询重新访问 provider。
  handler()
  assert.deepEqual(peekModelCatalog(ctx), {}, '事件回调按 Context 失效目录缓存')
  assert.deepEqual(await listAdvertisedModels(ctx), { 'provider-e2e': ['provider-e2e-2'] }, '失效后重新查询 provider')
  assert.equal(calls, 2)
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

// —— `/models` 与 `/model-reasoning` 端点（原 model-catalog-refresh.test.mjs） ——

function fakeRes() {
  let status = 0
  let body = ''
  return {
    writeHead(code) { status = code },
    end(payload) { body = payload },
    get status() { return status },
    get body() { return body },
  }
}

/** 计数版 llm 服务：每次 listModels 都记录，用于证明「缓存命中」与「显式刷新」。 */
function makeCatalogHarness() {
  const handlers = new Map()
  const calls = { listModels: 0 }
  const llm = {
    listProviders: () => [{ id: 'deepseek-official' }],
    async listModels(provider) {
      calls.listModels += 1
      return [{ id: `${provider}-v1` }]
    },
  }
  const sctx = {
    get: (name) => (name === 'llm' ? llm : undefined),
    settings: { describe: () => [], get: () => undefined, mutate: async () => {} },
    webServer: { register: ({ path, handler }) => { handlers.set(path, handler) } },
    effect: (fn) => fn(),
  }
  const ctx = { inject: (_deps, cb) => cb(sctx) }
  return { ctx, handlers, calls }
}

function registerCatalog(ctx) {
  registerSettingsBridge(
    ctx,
    () => ({ available: true, providers: ['deepseek-official'] }),
    () => ({ activeSkillsDirs: [], skillCatalog: [] }),
    () => '',
  )
}

function bodyStream(payload) {
  const bytes = Buffer.from(JSON.stringify(payload), 'utf8')
  return {
    [Symbol.asyncIterator]() {
      let sent = false
      return {
        next: async () => {
          if (sent) return { done: true, value: undefined }
          sent = true
          return { done: false, value: bytes }
        },
      }
    },
  }
}

function catalogReq(overrides = {}) {
  return {
    method: 'POST',
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: 'localhost' },
    [Symbol.asyncIterator]() {
      return { next: async () => ({ done: true, value: undefined }) }
    },
    ...overrides,
  }
}

test('/models：缓存命中不重复查询，refresh:true 越过 TTL 重新查询', async () => {
  const { ctx, handlers, calls } = makeCatalogHarness()
  registerCatalog(ctx)
  const handler = handlers.get(PREFIX + BRIDGE_ENDPOINTS.models)
  assert.ok(handler, '/models 端点应注册')

  const first = fakeRes()
  await handler(catalogReq(), first)
  assert.equal(first.status, 200)
  assert.deepEqual(JSON.parse(first.body).value.modelCatalog, { 'deepseek-official': ['deepseek-official-v1'] })
  assert.equal(calls.listModels, 1)

  const cached = fakeRes()
  await handler(catalogReq(), cached)
  assert.equal(cached.status, 200)
  assert.equal(calls.listModels, 1, 'TTL 内再次请求命中缓存，不重复查询 provider')

  const refreshed = fakeRes()
  await handler(catalogReq(bodyStream({ refresh: true })), refreshed)
  assert.equal(refreshed.status, 200)
  assert.equal(calls.listModels, 2, 'refresh:true 必须重新查询')
})

test('/models：非法 body 走统一 400 包装，不触达 provider', async () => {
  const { ctx, handlers, calls } = makeCatalogHarness()
  registerCatalog(ctx)
  const handler = handlers.get(PREFIX + BRIDGE_ENDPOINTS.models)

  const res = fakeRes()
  await handler(catalogReq({ ...bodyStream(['not-an-object']) }), res)
  assert.equal(res.status, 400)
  assert.equal(JSON.parse(res.body).ok, false)
  assert.equal(calls.listModels, 0, '非法载荷不得触发目录查询')
})

test('/model-reasoning：返回官方元数据档位，命中缓存，非法载荷 400（M-12）', async () => {
  const { ctx, handlers, calls } = makeCatalogHarness()
  calls.resolveModelInfo = 0
  const base = ctx.inject
  // 在 harness 的 sctx 上补 resolveModelInfo（官方 llm 服务的推理元数据入口）。
  ctx.inject = (deps, cb) => base(deps, (sctx) => {
    const llm = sctx.get('llm')
    llm.resolveModelInfo = async (_provider, _model) => {
      calls.resolveModelInfo += 1
      return { reasoning: { efforts: [{ id: 'low', name: '低' }, { id: 'high', name: '高' }], defaultEffort: 'low' } }
    }
    cb(sctx)
  })
  registerCatalog(ctx)
  const handler = handlers.get(PREFIX + BRIDGE_ENDPOINTS.modelReasoning)
  assert.ok(handler, '/model-reasoning 端点应注册')

  const ok = fakeRes()
  await handler(catalogReq(bodyStream({ provider: 'deepseek-official', model: 'deepseek-v4-flash' })), ok)
  assert.equal(ok.status, 200)
  assert.deepEqual(JSON.parse(ok.body).value.reasoning, {
    known: true,
    efforts: [{ id: 'low', name: '低' }, { id: 'high', name: '高' }],
    defaultEffort: 'low',
  })
  assert.equal(calls.resolveModelInfo, 1)

  const cached = fakeRes()
  await handler(catalogReq(bodyStream({ provider: 'deepseek-official', model: 'deepseek-v4-flash' })), cached)
  assert.equal(cached.status, 200)
  assert.equal(calls.resolveModelInfo, 1, '同一路由重复查询命中缓存')

  const half = fakeRes()
  await handler(catalogReq(bodyStream({ provider: 'deepseek-official', model: '' })), half)
  assert.equal(half.status, 400)
  assert.equal(JSON.parse(half.body).code, 'reasoning-invalid-shape')

  const notObject = fakeRes()
  await handler(catalogReq(bodyStream(['nope'])), notObject)
  assert.equal(notObject.status, 400)
  assert.equal(calls.resolveModelInfo, 1, '非法载荷不得触发元数据查询')
})

// —— `/param-overrides` 只重建当前预设 ——

function makeParamSyncHarness() {
  const handlers = new Map()
  const sctx = {
    settings: { describe: () => [], get: () => undefined, mutate: async () => {} },
    webServer: { register: ({ path, handler }) => { handlers.set(path, handler) } },
    effect: (fn) => fn(),
  }
  const ctx = { inject: (_deps, cb) => cb(sctx) }
  return { ctx, handlers }
}

function paramSyncReq(payload) {
  const bytes = Buffer.from(JSON.stringify(payload), 'utf8')
  return {
    method: 'POST',
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: 'localhost' },
    [Symbol.asyncIterator]() {
      let sent = false
      return {
        next: async () => {
          if (sent) return { done: true, value: undefined }
          sent = true
          return { done: false, value: bytes }
        },
      }
    },
  }
}

test('/param-overrides 只重建当前预设，返回值不携带全局模型同步', async () => {
  mkdirSync(presetRoot, { recursive: true })
  const dir = join(presetRoot, 'pt-overrides-sync')
  mkdirSync(dir)
  writeFileSync(join(dir, 'preset.yml'), 'id: pt-overrides-sync\n', 'utf8')
  const { ctx, handlers } = makeParamSyncHarness()
  let rebuilds = 0
  try {
    registerSettingsBridge(
      ctx,
      'prompt-tool',
      () => ({ available: true, providers: ['deepseek-official'] }),
      () => ({ activeSkillsDirs: [], skillCatalog: [] }),
      () => '',
      undefined,
      () => dir,
      undefined,
      () => { rebuilds++; return { status: 'synced' } },
    )
    const write = handlers.get(`${PREFIX}${BRIDGE_ENDPOINTS.paramOverrides}`)
    assert.ok(write, '/param-overrides 端点应注册')

    const res = fakeRes()
    await write(paramSyncReq({ overrides: { maxDepth: '' } }), res)
    assert.equal(res.status, 200)
    assert.equal(rebuilds, 1)
    assert.deepEqual(JSON.parse(res.body), { ok: true, value: { overrides: { maxDepth: '' } } })

    const noRebuild = fakeRes()
    await write(paramSyncReq({ overrides: { maxDepth: '' }, rebuild: false }), noRebuild)
    assert.equal(noRebuild.status, 200)
    assert.equal(rebuilds, 1, 'rebuild:false 不重建')
    assert.deepEqual(JSON.parse(noRebuild.body), { ok: true, value: { overrides: { maxDepth: '' } } })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
