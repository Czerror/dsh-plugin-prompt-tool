import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fakeReq, fakeRes, handlerTable, isolatedHome } from '../fixtures/host-harness.mjs'
// 隔离 DSH_HOME：夹具登记 after 清理并在文件末尾还原旧值（别让后续用例读到临时 HOME）；
// 设置必须在动态 import 那些 import 时冻结路径的模块之前。
const { home } = isolatedHome('pt-contract-')
process.env.DSH_HOME = home
const {
  BRIDGE_ENDPOINTS, SETTINGS_BRIDGE_PREFIX, MAX_BRIDGE_BODY_BYTES,
} = await import('../../src/shared/bridge-contract.ts')
const { registerSettingsBridge } = await import('../../src/runtime/settings-bridge.ts')
const { bridgeTransaction } = await import('../../src/runtime/bridge-transaction.ts')
const { materializeModuleDefinition } = await import('../../src/host/module-slices.ts')
const bridgeDisposers = []
// 先放掉本轮注册的端点，再让夹具的 after 清掉 home（登记顺序即执行顺序）。
test.after(() => {
  for (const dispose of bridgeDisposers) dispose()
})

// 跨端契约测试：shared 常量（client 消费）必须与 server 注册路由逐点一致。

function makeHarness(otherServices = {}, logger = undefined) {
  const table = handlerTable()
  const sctx = {
    on: () => () => {},
    settings: {
      describe: () => [{ ns: 'prompt-tool', value: { promptText: 'P' }, base: {} }],
      mutate: async () => {},
    },
    webServer: { register: table.register },
    agents: {
      list: () => [],
      get: (id) => id === 'live-session' ? { id } : undefined,
    },
    tools: {
      schemas: () => [{ name: 'bash', description: '运行命令' }],
      ...otherServices.tools,
    },
    get: (name) => otherServices[name],
    effect: (fn) => { const dispose = fn(); if (dispose) bridgeDisposers.push(dispose) },
  }
  const ctx = { inject: (_deps, cb) => cb(sctx), ...(logger === undefined ? {} : { logger }) }
  return { ctx, handlers: table.handlers }
}

function register(bridgeDeps = {}) {
  const { ctx, handlers } = makeHarness()
  registerSettingsBridge(ctx, {
    ns: 'prompt-tool',
    models: () => ({ available: true, providers: ['deepseek-official'] }),
    ...bridgeDeps,
  })
  return handlers
}

function txReq({ method = 'POST', remoteAddress = '127.0.0.1', headers = { host: '127.0.0.1' }, chunks = [] } = {}) {
  return {
    method,
    headers,
    socket: { remoteAddress },
    async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield Buffer.from(chunk) },
  }
}

/** 事务级假响应：记录状态、头、正文与 writeHead 次数。 */
function txRes() {
  const state = { status: undefined, body: '', writes: 0 }
  return {
    state,
    writeHead(status) { state.status = status; state.writes += 1 },
    end(payload) { if (payload !== undefined) state.body += payload },
  }
}

/** 事务级假依赖：编辑目标固定（字段形状判断归各端点，事务不管）。 */
function txDeps(overrides = {}) {
  return { editDir: () => 'module-dir', ...overrides }
}

const txJson = (res) => JSON.parse(res.state.body)

async function scanEveryBridgePath(makeRequest) {
  const handlers = register()
  const paths = Object.values(BRIDGE_ENDPOINTS)
  const seen = []
  for (const path of paths) {
    const full = SETTINGS_BRIDGE_PREFIX + path
    const handler = handlers.get(full)
    assert.ok(handler, `${full} 未注册`)
    const res = fakeRes()
    await handler(makeRequest(), res)
    seen.push([full, res.status, JSON.parse(res.body)])
  }
  assert.equal(seen.length, Object.keys(BRIDGE_ENDPOINTS).length,
    `扫描 ${seen.length} 条路径，路径表 ${Object.keys(BRIDGE_ENDPOINTS).length} 条`)
  return seen
}

test('契约：桥事务超过 32 MiB 上限回 413，且不进入 handler', async () => {
  let handled = 0
  const oversized = Buffer.alloc(MAX_BRIDGE_BODY_BYTES + 1, 0x20)
  const res = txRes()
  await bridgeTransaction({ handle: () => { handled += 1 } }, txDeps())(txReq({ chunks: [oversized] }), res)
  assert.equal(res.state.status, 413)
  assert.equal(txJson(res).code, 'bridge-body-too-large')
  assert.equal(handled, 0)
})

test('契约：桥事务的 body 两态——json 解析空体、none 不消费请求流', async () => {
  // json（缺省）：空请求体解析成空对象（形状校验由 handler 按字段做，现有端点在缺字段时自回 400）。
  let jsonRecord
  const json = txRes()
  await bridgeTransaction({ body: 'json', handle: (tx) => { jsonRecord = tx.record; tx.write(400, { ok: false, code: 'field-missing' }) } }, txDeps())(txReq(), json)
  assert.deepEqual(jsonRecord, {})
  assert.equal(json.state.status, 400)

  // 省略 body 即 json：默认档与显式声明行为一致。
  let defaultRecord
  const fallback = txRes()
  await bridgeTransaction({ handle: (tx) => { defaultRecord = tx.record; tx.write(200, { ok: true, value: {} }) } }, txDeps())(txReq(), fallback)
  assert.deepEqual(defaultRecord, {})
  assert.equal(fallback.state.status, 200)

  // none：不解析、也**不消费请求流**——原始流端点（上传）要自己读 tx.req。
  let noneRecord, readByTransaction = false
  const none = txRes()
  const req = txReq({ chunks: ['not json at all'] })
  const originalIterator = req[Symbol.asyncIterator].bind(req)
  req[Symbol.asyncIterator] = () => { readByTransaction = true; return originalIterator() }
  await bridgeTransaction({ body: 'none', handle: (tx) => { noneRecord = tx.record; tx.write(200, { ok: true, value: {} }) } }, txDeps())(req, none)
  assert.deepEqual(noneRecord, {})
  assert.equal(none.state.status, 200)
  assert.equal(readByTransaction, false, 'body:none 不得消费请求流')
})

test('契约：桥事务不为 handler 兜底成功——静默 500、抛错 500、已写过则不再补写', async () => {
  const silent = txRes()
  await bridgeTransaction({ handle: () => {} }, txDeps())(txReq({ chunks: ['{}'] }), silent)
  assert.equal(silent.state.status, 500)
  assert.equal(txJson(silent).code, 'bridge-handler-silent')

  const failed = txRes()
  await bridgeTransaction({ handle: () => { throw new Error('boom') } }, txDeps())(txReq({ chunks: ['{}'] }), failed)
  assert.equal(failed.state.status, 500)
  assert.equal(txJson(failed).code, 'bridge-handler-failed')

  const wroteThenThrew = txRes()
  await bridgeTransaction({ handle: (tx) => { tx.write(409, { ok: false, code: 'x' }); throw new Error('after write') } }, txDeps())(txReq({ chunks: ['{}'] }), wroteThenThrew)
  assert.equal(wroteThenThrew.state.status, 409)
  assert.equal(wroteThenThrew.state.writes, 1)
})

test('契约：moduleName 主语安全与 rules 非正文紧凑保存的写前拒绝', async () => {
  const { userModulesDir } = await import('../../src/host/module-dirs.ts')
  const subjectDir = join(userModulesDir(), 'module-name-subject')
  mkdirSync(subjectDir, { recursive: true })
  writeFileSync(join(subjectDir, 'module.yml'), 'id: module-name-subject\nname: 原名\nmodules: []\nrules: []\n', 'utf8')
  materializeModuleDefinition(subjectDir)
  const handlers = register({
    moduleDirectory: (id) => id === 'module-name-subject' ? subjectDir : '',
    overridesChanged: async () => { throw new Error('refresh unavailable') },
  })
  const path = SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.moduleName
  const missing = fakeRes()
  await handlers.get(path)(fakeReq({ body: {}, headers: {} }), missing)
  assert.equal(missing.status, 400)
  assert.equal(JSON.parse(missing.body).code, 'module-dir-unavailable')
  const conflict = fakeRes()
  await handlers.get(path)(fakeReq({ body: { name: '新名', expectedRevision: '0'.repeat(64), expectedModuleId: 'other' }, headers: { 'x-module-id': 'module-name-subject' } }), conflict)
  assert.equal(conflict.status, 400)
  assert.equal(JSON.parse(conflict.body).code, 'module-subject-conflict')
  const readonly = fakeRes()
  const readonlyHandlers = register({ moduleDirectory: () => join(tmpdir(), 'pt-module-name-readonly') })
  await readonlyHandlers.get(path)(fakeReq({ body: { name: '新名', expectedRevision: '0'.repeat(64), expectedModuleId: 'module-name-subject' }, headers: { 'x-module-id': 'module-name-subject' } }), readonly)
  assert.equal(readonly.status, 403)
  assert.equal(JSON.parse(readonly.body).code, 'module-readonly')
  const read = fakeRes()
  await handlers.get(path)(fakeReq({ body: {}, headers: { 'x-module-id': 'module-name-subject' } }), read)
  assert.equal(read.status, 200)
  const initial = JSON.parse(read.body).value
  assert.equal(initial.name, '原名')
  const saved = fakeRes()
  await handlers.get(path)(fakeReq({ body: { name: '新名', expectedRevision: initial.revision, expectedModuleId: 'module-name-subject' }, headers: { 'x-module-id': 'module-name-subject' } }), saved)
  assert.equal(saved.status, 200, '运行刷新失败不能伪报名称未保存')
  assert.equal(JSON.parse(saved.body).value.persisted, true)
  assert.match(JSON.parse(saved.body).value.publicationError, /refresh unavailable/)
  const again = fakeRes()
  await handlers.get(path)(fakeReq({ body: {}, headers: { 'x-module-id': 'module-name-subject' } }), again)
  assert.equal(JSON.parse(again.body).value.name, '新名')
  const stale = fakeRes()
  await handlers.get(path)(fakeReq({ body: { name: '过期写入', expectedRevision: initial.revision, expectedModuleId: 'module-name-subject' }, headers: { 'x-module-id': 'module-name-subject' } }), stale)
  assert.equal(stale.status, 409)
  assert.equal(JSON.parse(stale.body).code, 'module-name-conflict')
  const definitionFile = join(subjectDir, 'module.yml')
  const invalidFormat = fakeRes()
  writeFileSync(definitionFile, 'id: module-name-subject\nname: external\nmodules: []\nrules: []\nlayerSettings: []\n')
  await handlers.get(path)(fakeReq({ body: {}, headers: { 'x-module-id': 'module-name-subject' } }), invalidFormat)
  assert.equal(invalidFormat.status, 200, '格式门只核对已提交清单')
  assert.equal(JSON.parse(invalidFormat.body).value.name, '新名')

  // 非正文 compactEdit 必须在提交及发布前拒绝，不能返回失败却已删除规则。
  const rulesDir = join(userModulesDir(), 'compact-rejection')
  mkdirSync(rulesDir, { recursive: true })
  const rulesFile = join(rulesDir, 'module.yml')
  writeFileSync(rulesFile, JSON.stringify({ id: 'compact-rejection', modules: [], rules: [{ id: 'keep', then: [{ id: 'text', kind: 'inject-text', config: { text: 'KEEP' } }] }] }))
  materializeModuleDefinition(rulesDir)
  writeFileSync(rulesFile, 'id: compact-rejection\nmodules: []\n')
  let publications = 0
  let effectiveGeneration, publicationFailure, failScheduling = true
  const rulesHandler = register({
    moduleDirectory: () => rulesDir,
    schedulePublication: id => {
      assert.equal(id, 'compact-rejection')
      publications++
      if (failScheduling) throw new Error('rules refresh unavailable')
      publicationFailure = undefined
    },
    rulesChanged: (id, generation) => {
      assert.equal(id, 'compact-rejection')
      publications++
      effectiveGeneration = generation
      publicationFailure = undefined
    },
    publicationFailures: () => publicationFailure === undefined ? [] : [{ moduleId: 'compact-rejection', message: publicationFailure, at: 0 }],
    moduleGenerations: () => [{ agentId: 'agent-a', generation: effectiveGeneration }],
  }).get(SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.rules)
  const headers = { 'x-module-id': 'compact-rejection' }
  const rulesRead = fakeRes()
  await rulesHandler(fakeReq({ body: { expectedModuleId: 'compact-rejection' }, headers }), rulesRead)
  assert.equal(rulesRead.status, 200)
  const initialRules = JSON.parse(rulesRead.body).value
  effectiveGeneration = initialRules.definitionRevision
  assert.deepEqual(JSON.parse(rulesRead.body).value.rules.map(rule => rule.id), ['keep'], '声明门与规则读取使用本地提交')
  const rulesBytes = readFileSync(rulesFile)
  const rejected = fakeRes()
  await rulesHandler(fakeReq({ body: {
    expectedModuleId: 'compact-rejection', compactEdit: true,
    expectedRevisions: initialRules.revisions,
    edits: [{ previousId: 'keep', rule: null }],
  }, headers }), rejected)
  assert.deepEqual(readFileSync(rulesFile), rulesBytes, '拒绝 compactEdit 删除时完整定义不得变化')
  assert.equal(publications, 0, '拒绝 compactEdit 删除时不得安排发布')
  assert.equal(rejected.status, 400)
  assert.equal(JSON.parse(rejected.body).code, 'rules-invalid')

  const edited = fakeRes()
  await rulesHandler(fakeReq({ body: {
    expectedModuleId: 'compact-rejection', compactEdit: true,
    expectedRevisions: initialRules.revisions,
    edits: [{ previousId: 'keep', rule: { ...initialRules.rules[0], name: 'NEW' } }],
  }, headers }), edited)
  assert.equal(edited.status, 200, edited.body)
  const receipt = JSON.parse(edited.body).value
  assert.equal(receipt.persisted, true)
  assert.equal(receipt.rule.name, 'NEW')
  assert.equal(receipt.publicationPending, true)
  assert.notEqual(receipt.definitionRevision, initialRules.definitionRevision)
  assert.deepEqual(receipt.effectiveGenerations, [{ agentId: 'agent-a', generation: initialRules.definitionRevision }])
  const retry = async expectedDefinitionRevision => {
    const response = fakeRes()
    await rulesHandler(fakeReq({ body: { expectedModuleId: 'compact-rejection', refreshOnly: true, expectedDefinitionRevision }, headers }), response)
    return response
  }
  assert.equal((await retry(initialRules.definitionRevision)).status, 409)
  assert.equal(publications, 1, '旧代凭据不能启动发布')
  const refreshed = await retry(receipt.definitionRevision)
  assert.equal(refreshed.status, 200, refreshed.body)
  const resumed = JSON.parse(refreshed.body).value
  assert.equal(resumed.definitionRevision, receipt.definitionRevision, '重试只发布已提交代')
  assert.equal(resumed.publicationPending, false)
  assert.deepEqual(resumed.effectiveGenerations, [{ agentId: 'agent-a', generation: receipt.definitionRevision }])

  failScheduling = false
  const queued = fakeRes()
  await rulesHandler(fakeReq({ body: {
    expectedModuleId: 'compact-rejection', compactEdit: true,
    expectedRevisions: resumed.revisions,
    edits: [{ previousId: 'keep', rule: { ...resumed.rules[0], name: 'QUEUED' } }],
  }, headers }), queued)
  assert.equal(queued.status, 200, queued.body)
  const queuedReceipt = JSON.parse(queued.body).value
  assert.equal(queuedReceipt.persisted, true)
  assert.equal(queuedReceipt.publicationPending, undefined, '已入队不等于发布失败')
  assert.deepEqual(queuedReceipt.effectiveGenerations, resumed.effectiveGenerations, '回执先于 Agent 配装')
  publicationFailure = '后台配装失败'
  const failedRead = fakeRes()
  await rulesHandler(fakeReq({ body: { expectedModuleId: 'compact-rejection' }, headers }), failedRead)
  const failed = JSON.parse(failedRead.body).value
  assert.equal(failed.definitionRevision, queuedReceipt.definitionRevision)
  assert.equal(failed.publicationError, publicationFailure)
  assert.equal(failed.publicationPending, true)

  const { commitModuleDefinition, loadModuleDefinition } = await import('../../src/host/module-slices.ts')
  const { readModuleLocalCommit } = await import('../../src/host/module-local-state.ts')
  const current = loadModuleDefinition(rulesDir)
  current.doc.set('name', 'Updated module metadata')
  commitModuleDefinition(current, current.doc)
  const metadata = readModuleLocalCommit(rulesDir)
  assert.notEqual(metadata.generation, queuedReceipt.definitionRevision)
  writeFileSync(join(rulesDir, 'rules', '.objects', metadata.inputs), 'invalid inputs')
  const recovered = fakeRes()
  await rulesHandler(fakeReq({ body: { expectedModuleId: 'compact-rejection' }, headers }), recovered)
  assert.equal(recovered.status, 200, recovered.body)
  assert.equal(JSON.parse(recovered.body).value.definitionRevision, queuedReceipt.definitionRevision)
  const writeThroughFallback = fakeRes()
  await rulesHandler(fakeReq({ body: {
    expectedModuleId: 'compact-rejection', compactEdit: true, expectedRevisions: failed.revisions,
    edits: [{ previousId: 'keep', rule: { ...failed.rules[0], name: 'SHOULD NOT SAVE' } }],
  }, headers }), writeThroughFallback)
  assert.equal(writeThroughFallback.status, 400, writeThroughFallback.body)
  assert.equal(readModuleLocalCommit(rulesDir).generation, metadata.generation)
})

test('契约：全部桥路径拒绝非 loopback，无一条绕过事务', async () => {
  const scanned = await scanEveryBridgePath(() => fakeReq({ body: {}, remoteAddress: '203.0.113.1' }))
  for (const [path, status, payload] of scanned) {
    assert.equal(status, 403, `${path} 必须拒绝非 loopback`)
    assert.equal(payload.ok, false, `${path} 拒绝载荷必须 ok:false`)
    assert.equal(payload.code, 'settings-not-exposed', `${path} 拒绝码必须与设置桥同源`)
  }
})

test('契约：全部桥路径只收 POST 且拒绝跨站 Origin', async () => {
  for (const [path, status] of await scanEveryBridgePath(() => fakeReq({ body: {}, method: 'GET' }))) {
    assert.equal(status, 405, `${path} 必须只收 POST`)
  }
  for (const [path, status] of await scanEveryBridgePath(() => fakeReq({ body: {}, headers: { origin: 'https://example.com' } }))) {
    assert.equal(status, 403, `${path} 必须拒绝跨站 Origin`)
  }
})

test('契约：JSON 端点拒绝未知字段——400 bridge-request-invalid', async () => {
  const handlers = register()
  const handler = handlers.get(SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.models)
  assert.ok(handler, '/models 端点未注册')
  const res = fakeRes()
  await handler(fakeReq({ body: { refresh: true, extra: true } }), res)
  assert.equal(res.status, 400)
  const payload = JSON.parse(res.body)
  assert.equal(payload.ok, false)
  assert.equal(payload.code, 'bridge-request-invalid')
  assert.match(payload.message, /extra/, '错误消息点名多余字段')
})
