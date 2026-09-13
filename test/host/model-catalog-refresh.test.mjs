/**
 * 模型目录的显式刷新入口（M-11）。
 *
 * `/models` 默认走 10 分钟缓存；显式刷新（客户端 connection/reset、用户重试）
 * 传 `refresh: true` 时必须越过 TTL 重新查询，且非法 body 走统一 400 包装。
 */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync, rmSync } from 'node:fs'

const bridgeHome = mkdtempSync(join(tmpdir(), 'pt-model-catalog-home-'))
process.env.DSH_HOME = bridgeHome
const { BRIDGE_ENDPOINTS, registerSettingsBridge } = await import('../../lib/index.mjs')
after(() => rmSync(bridgeHome, { recursive: true, force: true }))

const PREFIX = '/api/prompt-tool/settings'

function fakeReq(overrides = {}) {
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
function makeHarness() {
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

function register(ctx) {
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

test('/models：缓存命中不重复查询，refresh:true 越过 TTL 重新查询', async () => {
  const { ctx, handlers, calls } = makeHarness()
  register(ctx)
  const handler = handlers.get(PREFIX + BRIDGE_ENDPOINTS.models)
  assert.ok(handler, '/models 端点应注册')

  const first = fakeRes()
  await handler(fakeReq(), first)
  assert.equal(first.status, 200)
  assert.deepEqual(JSON.parse(first.body).value.modelCatalog, { 'deepseek-official': ['deepseek-official-v1'] })
  assert.equal(calls.listModels, 1)

  const cached = fakeRes()
  await handler(fakeReq(), cached)
  assert.equal(cached.status, 200)
  assert.equal(calls.listModels, 1, 'TTL 内再次请求命中缓存，不重复查询 provider')

  const refreshed = fakeRes()
  await handler(fakeReq(bodyStream({ refresh: true })), refreshed)
  assert.equal(refreshed.status, 200)
  assert.equal(calls.listModels, 2, 'refresh:true 必须重新查询')
})

test('/models：非法 body 走统一 400 包装，不触达 provider', async () => {
  const { ctx, handlers, calls } = makeHarness()
  register(ctx)
  const handler = handlers.get(PREFIX + BRIDGE_ENDPOINTS.models)

  const res = fakeRes()
  await handler(fakeReq({ ...bodyStream(['not-an-object']) }), res)
  assert.equal(res.status, 400)
  assert.equal(JSON.parse(res.body).ok, false)
  assert.equal(calls.listModels, 0, '非法载荷不得触发目录查询')
})

test('/model-reasoning：返回官方元数据档位，命中缓存，非法载荷 400（M-12）', async () => {
  const { ctx, handlers, calls } = makeHarness()
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
  register(ctx)
  const handler = handlers.get(PREFIX + BRIDGE_ENDPOINTS.modelReasoning)
  assert.ok(handler, '/model-reasoning 端点应注册')

  const ok = fakeRes()
  await handler(fakeReq(bodyStream({ provider: 'deepseek-official', model: 'deepseek-v4-flash' })), ok)
  assert.equal(ok.status, 200)
  assert.deepEqual(JSON.parse(ok.body).value.reasoning, {
    known: true,
    efforts: [{ id: 'low', name: '低' }, { id: 'high', name: '高' }],
    defaultEffort: 'low',
  })
  assert.equal(calls.resolveModelInfo, 1)

  const cached = fakeRes()
  await handler(fakeReq(bodyStream({ provider: 'deepseek-official', model: 'deepseek-v4-flash' })), cached)
  assert.equal(cached.status, 200)
  assert.equal(calls.resolveModelInfo, 1, '同一路由重复查询命中缓存')

  const half = fakeRes()
  await handler(fakeReq(bodyStream({ provider: 'deepseek-official', model: '' })), half)
  assert.equal(half.status, 400)
  assert.equal(JSON.parse(half.body).code, 'reasoning-invalid-shape')

  const notObject = fakeRes()
  await handler(fakeReq(bodyStream(['nope'])), notObject)
  assert.equal(notObject.status, 400)
  assert.equal(calls.resolveModelInfo, 1, '非法载荷不得触发元数据查询')
})
