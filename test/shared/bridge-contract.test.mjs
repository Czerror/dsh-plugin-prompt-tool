import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { fakeReq, fakeRes, handlerTable, isolatedHome } from '../fixtures/host-harness.mjs'
// 隔离 DSH_HOME：夹具登记 after 清理并在文件末尾还原旧值（别让后续用例读到临时 HOME）；
// 设置必须在动态 import 那些 import 时冻结路径的模块之前。
const { home } = isolatedHome('pt-contract-')
process.env.DSH_HOME = home
const {
  BRIDGE_ENDPOINTS, SETTINGS_BRIDGE_PREFIX, MAX_BRIDGE_BODY_BYTES, BRIDGE_SUBJECT_POLICY, readSubjectHeader,
} = await import('../../src/shared/bridge-contract.ts')
const { registerSettingsBridge } = await import('../../src/runtime/settings-bridge.ts')
const { bridgeTransaction } = await import('../../src/runtime/bridge-transaction.ts')
const { MODULE_CAPABILITIES, ENGINE_EDITOR_GROUP_MAP, INJECTION_POINT_ORDER } = await import('../../src/shared/engine-capabilities.ts')
const { getEngineMeta, LAYER_ORDER } = await import('../../engine/schema.mjs')
const bridgeDisposers = []
// 先放掉本轮注册的端点，再让夹具的 after 清掉 home（登记顺序即执行顺序）。
test.after(() => {
  for (const dispose of bridgeDisposers) dispose()
})

// 跨端契约测试：shared 常量（client 消费）必须与 server 注册路由逐点一致。

function makeHarness(otherServices = {}, logger = undefined) {
  const table = handlerTable()
  const agentPresets = {
    list: async () => [{ id: 'official', trust: 'system' }],
    acquireScope: async (id) => ({ key: { id }, [Symbol.asyncDispose]: async () => {} }),
    ...otherServices.agentPresets,
  }
  const sctx = {
    settings: {
      describe: () => [{ ns: 'prompt-tool', value: { promptText: 'P' }, base: {} }],
      mutate: async () => {},
    },
    webServer: { register: table.register },
    agents: {
      get: (id) => id === 'live-session' ? { id } : undefined,
    },
    tools: {
      schemas: () => [{ name: 'bash', description: '运行命令' }],
      ...otherServices.tools,
    },
    get: (name) => name === 'agentPresets' ? agentPresets : otherServices[name],
    effect: (fn) => { const dispose = fn(); if (dispose) bridgeDisposers.push(dispose) },
  }
  // Cordis 语义：未 inject 的服务属性访问直接抛错，可选服务只能经 ctx.get 解析。
  Object.defineProperty(sctx, 'agentPresets', {
    get() { throw new Error('cannot get property "agentPresets" without inject') },
  })
  const ctx = { inject: (_deps, cb) => cb(sctx), ...(logger === undefined ? {} : { logger }) }
  return { ctx, handlers: table.handlers }
}

/** 文件层调用策略的技能状态替身：技能实体留在官方技能根，插件只提供引用目录、清单与策略写入。 */
function makeSkillsState(overrides = {}) {
  const state = { version: 4, folders: [] }
  return {
    skillsRoot: 'D:/isolated/skills',
    folders: [],
    listSkills: () => [],
    setSkillPolicy: () => ({ ok: true, changed: true, invocation: { modelInvocable: true, userInvocable: true } }),
    patchSkillFolders: () => ({ ok: true, state, exists: true }),
    ...overrides,
  }
}

function register(skillsState = makeSkillsState(), bridgeDeps = {}) {
  const { ctx, handlers } = makeHarness()
  registerSettingsBridge(ctx, {
    ns: 'prompt-tool',
    models: () => ({ available: true, providers: ['deepseek-official'] }),
    skills: () => skillsState,
    ...bridgeDeps,
  })
  return handlers
}

/** /bootstrap 与 /meta 必须同源（同一份 loadEngineMeta）：逐字段表驱动比对，不各自组装。 */
function assertMetaSameSource(boot, meta, keys) {
  for (const key of keys) assert.deepEqual(boot[key], meta[key], `/bootstrap 与 /meta 必须同源：${key}`)
}

test('契约：client 前缀与 server 注册前缀同源', () => {
  assert.equal(SETTINGS_BRIDGE_PREFIX, '/api/prompt-tool/settings')
})

// ── 主语策略表：一次读写的主语是哪个模块 ─────────────────────────────────────────
// 只守键集：漏标一个端点即失败。逐端点的**策略值**不在这里锁快照（加端点/改策略就要手改
// 测试，且 typecheck 只保证键集），改由端点行为守——required 端点无主语 400 见
// test/host/module-subject.test.mjs 与 test/host/settings-bridge.test.mjs，optional 端点空主语 200 见后者。

test('契约：主语策略表登记每一个端点，策略值只认三态', () => {
  assert.deepEqual(Object.keys(BRIDGE_ENDPOINTS).sort(), Object.keys(BRIDGE_SUBJECT_POLICY).sort(),
    'BRIDGE_SUBJECT_POLICY 必须与 BRIDGE_ENDPOINTS 逐 key 一致')
  for (const [key, policy] of Object.entries(BRIDGE_SUBJECT_POLICY)) {
    assert.ok(['required', 'optional', 'none'].includes(policy), `${key} 的策略非法：${policy}`)
  }
})

test('契约：主语头解析三态——absent 只认「头完全没有」，其余非法形状一律 invalid', () => {
  const cases = [
    [undefined, { state: 'absent' }],
    [null, { state: 'absent' }],
    ['', { state: 'invalid' }],
    ['   ', { state: 'invalid' }],
    [42, { state: 'invalid' }],
    [['a'], { state: 'invalid' }],
    ['a'.repeat(65), { state: 'invalid' }],
    ['../x', { state: 'invalid' }],
    ['A/B', { state: 'invalid' }],
    ['Ponytail', { state: 'invalid' }],
    ['ponytail', { state: 'ok', id: 'ponytail' }],
    ['  demo-module  ', { state: 'ok', id: 'demo-module' }],
  ]
  for (const [input, expected] of cases) {
    assert.deepEqual(readSubjectHeader(input), expected, `readSubjectHeader(${JSON.stringify(input)}) 判定错误`)
  }
})

// ── 桥事务（src/runtime/bridge-transaction.ts）：一次请求的边界与信封 ──────────────
// 这些用例是事务的规格：loopback／Origin、只收 POST、32 MiB 上限、body 三态、
// 以及「不得替 handler 兜底成功」。此前 44 个端点各自实现这套规则，只在两个端点上被测。

/** 事务级假请求：只带事务实际读的字段。 */
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

test('契约：桥事务拒绝非 loopback，且不进入 handler', async () => {
  let handled = 0
  const route = bridgeTransaction({ handle: () => { handled += 1 } }, txDeps())
  const res = txRes()
  await route(txReq({ remoteAddress: '203.0.113.1', chunks: ['{}'] }), res)
  assert.equal(res.state.status, 403)
  assert.deepEqual(txJson(res), { ok: false, code: 'settings-not-exposed', message: 'loopback requests only' })
  assert.equal(handled, 0, '边界不通过时 handler 不得被调用')
})

test('契约：桥事务拒绝跨站 Origin（同 host 不同端口也不行）', async () => {
  for (const origin of ['https://example.com', 'http://127.0.0.1:9999']) {
    const res = txRes()
    await bridgeTransaction({ handle: () => {} }, txDeps())(
      txReq({ headers: { host: '127.0.0.1:56184', origin }, chunks: ['{}'] }), res)
    assert.equal(res.state.status, 403, `Origin ${origin} 必须被拒`)
  }
})

test('契约：桥事务只收 POST', async () => {
  const res = txRes()
  await bridgeTransaction({ handle: () => {} }, txDeps())(txReq({ method: 'GET', chunks: ['{}'] }), res)
  assert.equal(res.state.status, 405)
  assert.equal(txJson(res).code, 'settings-not-exposed')
})

test('契约：桥事务超过 32 MiB 上限回 413，且不进入 handler', async () => {
  let handled = 0
  const oversized = Buffer.alloc(MAX_BRIDGE_BODY_BYTES + 1, 0x20)
  const res = txRes()
  await bridgeTransaction({ handle: () => { handled += 1 } }, txDeps())(txReq({ chunks: [oversized] }), res)
  assert.equal(res.state.status, 413)
  assert.equal(txJson(res).code, 'bridge-body-too-large')
  assert.equal(handled, 0)
})

test('契约：桥事务把解析后的 record 与编辑目标交给 handler', async () => {
  const seen = []
  const route = bridgeTransaction({ handle: (tx) => { seen.push([tx.record, tx.editDir()]); tx.write(200, { ok: true, value: {} }) } }, txDeps())
  const res = txRes()
  await route(txReq({ chunks: [JSON.stringify({ sessionId: ' s-1 ', scope: 'module' })] }), res)
  assert.equal(res.state.status, 200)
  assert.deepEqual(seen, [[{ sessionId: ' s-1 ', scope: 'module' }, 'module-dir']])
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

test('契约：载荷字段形状不进事务——端点保留自己的错误码', async () => {
  const res = txRes()
  await bridgeTransaction({
    handle: (tx) => {
      assert.deepEqual(tx.record, { sessionId: 42 })
      tx.write(400, { ok: false, code: 'skills-list-rejected', message: 'sessionId must be a string' })
    },
  }, txDeps())(txReq({ chunks: [JSON.stringify({ sessionId: 42 })] }), res)
  assert.equal(res.state.status, 400)
  assert.equal(txJson(res).code, 'skills-list-rejected')
})

test('契约：moduleName 的公开主语与身份安全边界', async () => {
  const { userModulesDir } = await import('../../src/host/manifest.ts')
  const subjectDir = join(userModulesDir(), 'module-name-subject')
  mkdirSync(subjectDir, { recursive: true })
  writeFileSync(join(subjectDir, 'module.yml'), 'id: module-name-subject\nname: 原名\nmodules: []\nrules: []\n', 'utf8')
  const handlers = register(makeSkillsState(), {
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
  const readonlyHandlers = register(makeSkillsState(), { moduleDirectory: () => join(tmpdir(), 'pt-module-name-readonly') })
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
})

test('契约：所有端点路径全部注册且无多余', () => {
  const handlers = register()
  const expected = Object.values(BRIDGE_ENDPOINTS)
  const registered = [...handlers.keys()].sort()
  const wanted = expected.map((p) => SETTINGS_BRIDGE_PREFIX + p).sort()
  assert.deepEqual(registered, wanted)
})

// ── 全路径拒绝扫描：边界只有事务一处实现，因此必须在**每条**路径上可观测 ──────────────
// 例外清单为空：声明 body:'none' 的原始流端点同样先过边界，请求流只在进入 handler 后才消费。

/** 逐条路径打同一个请求；返回 [路径, 状态, 载荷]，扫描条数参与断言。 */
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

test('部署总闸经桥读写 modulesEnabled', async () => {
  const handlers = new Map()
  const subjectDir = join(home, 'gate-subject')
  mkdirSync(subjectDir, { recursive: true })
  writeFileSync(join(subjectDir, 'module.yml'), 'id: gate-subject\nmodules: []\n', 'utf8')
  let value = { modulesEnabled: false }
  const writes = []
  const scope = {
    settings: {
      describe: () => [{ ns: 'prompt-tool', value, base: {}, revision: 1 }],
      mutate: async (_ns, ops) => {
        writes.push(ops)
        for (const op of ops) {
          if (op.op === 'unset') delete value[op.path[0]]
          else value[op.path[0]] = op.value
        }
      },
    },
    get: () => undefined,
    webServer: { register: ({ path, handler }) => { handlers.set(path, handler); return () => {} } },
    effect: fn => { const dispose = fn(); if (dispose) bridgeDisposers.push(dispose) },
  }
  registerSettingsBridge({ inject: (_deps, callback) => callback(scope) }, {
    ns: 'prompt-tool',
    models: () => ({}),
    skills: () => makeSkillsState(),
    // describe 在策略表里是 required：它的主语就是模块段，读取必须带主语头（无头 → 400）。
    moduleDirectory: () => subjectDir,
  })
  const read = fakeRes()
  await handlers.get(SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.describe)(
    fakeReq({ headers: { 'x-module-id': 'gate-subject' } }), read)
  assert.equal(JSON.parse(read.body).value.value.modulesEnabled, false)
  const save = async ops => {
    const res = fakeRes()
    await handlers.get(SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.mutate)(fakeReq({ body: { ops } }), res)
    return res
  }
  const changed = await save([{ op: 'set', path: ['modulesEnabled'], value: true }])
  assert.equal(changed.status, 200, changed.body)
  assert.deepEqual(value, { modulesEnabled: true })
  assert.deepEqual(writes[0].at(-1), { op: 'set', path: ['modulesEnabled'], value: true })
  const rejected = await save([{ op: 'set', path: ['modulesEnabled'], value: 1 }])
  assert.equal(rejected.status, 409)
  assert.deepEqual(value, { modulesEnabled: true }, '非法取值不落盘')
})

test('契约：/bootstrap 聚合 meta + overrides + variables + promptConfigs 供客户端单请求消费', async () => {
  // 技能事实用非空数据断言透传：stub 的默认空表无法区分「如实下发」与「兜底成空」。
  const entry = { id: 'user-dsh:D:/isolated/skills:demo-skill', name: 'demo-skill', source: 'user-dsh', rank: 400, valid: true, modelInvocable: false, userInvocable: true, path: 'D:/isolated/skills/demo-skill/SKILL.md' }
  const handlers = register(makeSkillsState({
    folders: ['D:/referenced'],
    listSkills: () => [entry],
  }))
  const handler = handlers.get(SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.bootstrap)
  assert.ok(handler, '/bootstrap 端点未注册')
  const res = fakeRes()
  await handler(fakeReq(), res)
  assert.equal(res.status, 200)
  const payload = JSON.parse(res.body)
  assert.equal(payload.ok, true)
  // 没有编辑目标时仍返回已知的设置/技能事实，不捏造模块变量快照或版本。
  assert.ok(payload.meta !== undefined && payload.meta.meta !== undefined)
  assert.deepEqual(payload.overrides.overrides, {}, '无激活模块时参数覆盖是空表（对象），不是数组或 undefined')
  assert.equal(payload.variables, undefined)
  assert.ok(Array.isArray(payload.promptConfigs.promptConfigs))
  // 技能事实在同一聚合响应里下发：清单 + 引用目录 + 用户技能根。
  // 调用策略不单独下发——它已经逐条表达在 skillCatalog 条目的 modelInvocable / userInvocable 里。
  assert.deepEqual(payload.activeSkillsDirs, ['D:/isolated/skills'])
  assert.deepEqual(payload.skillFolders, ['D:/referenced'])
  assert.deepEqual(payload.skillCatalog, [entry])
  assert.equal(payload.skillsComplete, false, '无注册表观测时不得宣称会话技能清单完整')
  // 空主语没有模块段：不再拿包内默认模块冒充当前模块（两个键整体缺席，不是空对象）。
  assert.equal('moduleParams' in payload, false, '空主语时 moduleParams 整体缺席')
  assert.equal('moduleFacts' in payload, false, '空主语时 moduleFacts 整体缺席')
})

test('契约：/meta 与 /bootstrap 同源下发 layerOrder 与 editorGroups，且只含白名单字段', async () => {
  const engineMeta = getEngineMeta()
  assert.deepEqual(engineMeta.layerOrder, [
    'pre-step', 'system-section', 'runtime-context', 'agent-request', 'llm-stream',
    'tool-pipeline', 'turn-stop', 'subagent-start', 'subagent-end',
  ])
  assert.deepEqual([...LAYER_ORDER], engineMeta.layerOrder, 'LAYER_ORDER 必须是九层固定顺序')
  assert.deepEqual([...INJECTION_POINT_ORDER], engineMeta.layerOrder, '前端退化默认必须与引擎层序同源')
  assert.deepEqual([...engineMeta.layers], [...LAYER_ORDER].sort(), 'layers 仍是排序后的合法集合（旧消费方不变）')
  // 两份层清单：九层给视图筛选与规则级 layer，八层（去 tool-pipeline）才可注入。
  assert.deepEqual([...engineMeta.injectionLayers], [...LAYER_ORDER].filter((layer) => layer !== 'tool-pipeline'))
  assert.deepEqual([...engineMeta.layers].filter((layer) => !engineMeta.injectionLayers.includes(layer)), ['tool-pipeline'], '两份清单的差集只有工具链层')

  const handlers = register()
  const metaRes = fakeRes()
  await handlers.get(SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.meta)(fakeReq(), metaRes)
  assert.equal(metaRes.status, 200)
  const meta = JSON.parse(metaRes.body).value.meta
  assert.deepEqual(meta.layerOrder, engineMeta.layerOrder)
  assert.deepEqual(meta.injectionLayers, engineMeta.injectionLayers, '/meta 下发的可注入层与 schema 同源')
  assert.ok(Array.isArray(meta.editorGroups) && meta.editorGroups.length > 0)
  // 同源：host 下发的编辑组与共享契约逐条一致（含能力组）。
  assert.deepEqual(meta.editorGroups.map(({ id }) => id), ENGINE_EDITOR_GROUP_MAP.map(({ id }) => id))
  const capabilityIds = MODULE_CAPABILITIES.map(({ id }) => id)
  const groupIds = meta.editorGroups.map(({ id }) => id)
  assert.equal(new Set(groupIds).size, groupIds.length, '编辑组 id 必须唯一（能力组与专用组不重复登记）')
  for (const id of capabilityIds) assert.ok(groupIds.includes(id), `能力 ${id} 必须有主归属`)
  for (const group of meta.editorGroups) {
    // 白名单：只有四个可序列化字段，不夹带路径、行级配置、校验函数或服务实例。
    assert.deepEqual(Object.keys(group).sort(), group.relatedLayers === undefined
      ? ['displayLayer', 'hook', 'id']
      : ['displayLayer', 'hook', 'id', 'relatedLayers'])
    assert.equal(typeof group.id, 'string')
    assert.equal(typeof group.hook, 'string')
    assert.ok(meta.layerOrder.includes(group.displayLayer), `${group.id} 主归属层非法：${group.displayLayer}`)
    for (const related of group.relatedLayers ?? []) {
      assert.ok(meta.layerOrder.includes(related), `${group.id} 相关层非法：${related}`)
      assert.notEqual(related, group.displayLayer, `${group.id} 相关层不能与主归属层相同`)
    }
  }
  const serialized = JSON.stringify(meta.editorGroups)
  assert.equal(serialized.includes('function'), false, '不得下发函数')
  assert.equal(serialized.includes(':\\'), false, '不得下发本地路径')

  // /bootstrap 与 /meta 同源：同一份 layerOrder / editorGroups，不各自组装。
  const bootRes = fakeRes()
  await handlers.get(SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.bootstrap)(fakeReq(), bootRes)
  assert.equal(bootRes.status, 200)
  const boot = JSON.parse(bootRes.body).meta.meta
  assertMetaSameSource(boot, meta, ['layerOrder', 'injectionLayers', 'editorGroups', 'layerContracts'])
  assert.deepEqual(meta.layerContracts, getEngineMeta().layerContracts)
  assert.equal(Object.keys(meta.layerContracts).length, 9)
})

test('契约：官方装配刻度随 /meta 与 /bootstrap 同源下发，服务缺失时整张表缺席且只告警一次', async (t) => {
  // 刻度数值只认官方实现：这里挂真实 SystemPrompt，不喂手抄数值。
  const root = new Context()
  await root.plugin(SystemPrompt, { includeHarnessIdentity: false })
  t.after(async () => { await root.fiber.dispose() })

  const warnings = []
  const present = makeHarness({ systemPrompt: root.systemPrompt }, { warn: (message) => warnings.push(message) })
  registerSettingsBridge(present.ctx, {
    ns: 'prompt-tool',
    models: () => ({ available: true, providers: ['deepseek-official'] }),
    skills: () => makeSkillsState(),
  })
  const metaRes = fakeRes()
  await present.handlers.get(SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.meta)(fakeReq(), metaRes)
  assert.equal(metaRes.status, 200)
  const meta = JSON.parse(metaRes.body).value.meta
  assert.ok(meta.officialOrders, '真实服务在位时必须下发刻度')
  assert.equal(meta.officialOrders.sections.length, 6)
  assert.equal(meta.officialOrders.contexts.length, 1)
  for (const segment of [...meta.officialOrders.sections, ...meta.officialOrders.contexts]) {
    assert.equal(typeof segment.id, 'string')
    assert.equal(Number.isFinite(segment.from), true)
    assert.equal(Number.isFinite(segment.to), true)
    assert.ok(segment.from <= segment.to, `${segment.id}: from 不得大于 to`)
  }
  assert.equal(JSON.stringify(meta.officialOrders).includes('function'), false, '不得下发函数')
  assert.equal(warnings.length, 0, '服务在位时不得告警')

  const bootRes = fakeRes()
  await present.handlers.get(SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.bootstrap)(fakeReq(), bootRes)
  assert.equal(bootRes.status, 200)
  assertMetaSameSource(JSON.parse(bootRes.body).meta.meta, meta, ['officialOrders'])

  // 服务缺失：字段整体缺席、端点不失败，且只告警一次（两个端点共用同一函数）。
  const missingWarnings = []
  const missing = makeHarness({}, { warn: (message) => missingWarnings.push(message) })
  registerSettingsBridge(missing.ctx, {
    ns: 'prompt-tool',
    models: () => ({ available: true, providers: ['deepseek-official'] }),
    skills: () => makeSkillsState(),
  })
  for (const endpoint of [BRIDGE_ENDPOINTS.meta, BRIDGE_ENDPOINTS.meta]) {
    const res = fakeRes()
    await missing.handlers.get(SETTINGS_BRIDGE_PREFIX + endpoint)(fakeReq(), res)
    assert.equal(res.status, 200, '服务缺失不得让端点失败')
    assert.equal(JSON.parse(res.body).value.meta.officialOrders, undefined, '服务缺失 ⇒ 字段整体缺席，绝不部分下发')
  }
  assert.equal(missingWarnings.length, 1, '取值失败只告警一次，不随请求刷屏')
  assert.match(missingWarnings[0], /官方装配档位/)
})

test('契约：复制引擎目录即可提供层契约，不依赖 src', async () => {
  const copied = mkdtempSync(join(tmpdir(), 'pt-engine-copy-'))
  try {
    cpSync(new URL('../../engine', import.meta.url), join(copied, 'engine'), { recursive: true })
    const copy = await import(pathToFileURL(join(copied, 'engine', 'schema.mjs')).href)
    assert.deepEqual([...copy.LAYER_ORDER], [...LAYER_ORDER])
  } finally {
    rmSync(copied, { recursive: true, force: true })
  }
})

test('契约：成功载荷统一为 { ok: true, value }', async () => {
  const handlers = register()
  // 抽样无需 settings/descriptor 依赖的端点，断言客户端 typed bridge 消费形状（res.value.*）。
  for (const path of [SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.meta, SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.skillsList]) {
    const handler = handlers.get(path)
    assert.ok(handler, `端点未注册: ${path}`)
    const res = fakeRes()
    await handler(fakeReq(), res)
    assert.equal(res.status, 200)
    const payload = JSON.parse(res.body)
    assert.equal(payload.ok, true)
    assert.ok(payload.value !== undefined && payload.value !== null, `${path} 成功载荷必须带 value`)
  }
})

test('契约：/tool-surface 返回存活 Agent 的只读工具面摘要，未知 session 稳定错误', async () => {
  const handlers = register()
  const handler = handlers.get(SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.toolSurface)
  assert.ok(handler, '/tool-surface 端点未注册')
  const ok = fakeRes()
  await handler(fakeReq({ body: { sessionId: 'live-session' } }), ok)
  assert.equal(ok.status, 200)
  const payload = JSON.parse(ok.body)
  assert.equal(payload.ok, true)
  assert.deepEqual(payload.value.tools, [{ name: 'bash', description: '运行命令' }], '只返回 name/description')
  assert.equal(payload.value.source, 'session')
  const unknown = fakeRes()
  await handler(fakeReq({ body: { sessionId: 'nope' } }), unknown)
  assert.equal(unknown.status, 404)
  const unknownPayload = JSON.parse(unknown.body)
  assert.equal(unknownPayload.ok, false)
  assert.equal(unknownPayload.code, 'tool-surface-unknown-session')
})

test('契约：/rule-diagnostics 只回判定计数，未启用不入账且读取不触发求值', async () => {
  const { recordRuleOutcome, resetRuleDiagnostics } = await import('../../src/runtime/rule-diagnostics.ts')
  const handlers = register()
  const handler = handlers.get(SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.ruleDiagnostics)
  assert.ok(handler, '/rule-diagnostics 端点未注册')
  resetRuleDiagnostics()
  const empty = fakeRes()
  await handler(fakeReq({ body: {} }), empty)
  assert.equal(empty.status, 200)
  const emptyPayload = JSON.parse(empty.body).value
  assert.deepEqual(emptyPayload.records, [], '未产生判定时回空数组，不伪报')
  // 状态栏的「X/Y 规则」顺路带回全仓配置卡；本用例隔离 DSH_HOME，没有启用模块即为空清单。
  assert.deepEqual(emptyPayload.configs?.entries ?? [], [], '无启用模块时配置清单为空')
  assert.equal('dropped' in emptyPayload, false, '未超限不带 dropped')
  recordRuleOutcome({ moduleId: 'm', ruleId: 'r', channel: 'agent/pre-step', outcome: 'unavailable' })
  recordRuleOutcome({ moduleId: 'm', ruleId: 'r', channel: 'agent/pre-step', outcome: 'unavailable' })
  recordRuleOutcome({ moduleId: 'm', ruleId: 'r', channel: 'agent/pre-step', outcome: 'disabled' })
  const filled = fakeRes()
  await handler(fakeReq({ body: {} }), filled)
  assert.deepEqual(JSON.parse(filled.body).value.records, [
    { moduleId: 'm', ruleId: 'r', channel: 'agent/pre-step', hit: 0, miss: 0, unavailable: 2, error: 0 },
  ])
  resetRuleDiagnostics()
})

test('契约：/rule-diagnostics 身份上限溢出可见——512 条封顶并报 dropped', async (t) => {
  const { recordRuleOutcome, resetRuleDiagnostics, ruleDiagnosticsSnapshot, RULE_DIAGNOSTIC_LIMIT } = await import('../../src/runtime/rule-diagnostics.ts')
  const handlers = register()
  const handler = handlers.get(SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.ruleDiagnostics)
  resetRuleDiagnostics()
  t.after(() => resetRuleDiagnostics())
  for (let index = 0; index <= RULE_DIAGNOSTIC_LIMIT; index += 1) {
    recordRuleOutcome({ moduleId: 'm', ruleId: `r${index}`, channel: 'agent/pre-step', outcome: 'hit' })
  }
  assert.equal(ruleDiagnosticsSnapshot().length, RULE_DIAGNOSTIC_LIMIT, '身份表封顶 512 条')
  const overflow = fakeRes()
  await handler(fakeReq({ body: {} }), overflow)
  const payload = JSON.parse(overflow.body)
  assert.equal(payload.value.records.length, RULE_DIAGNOSTIC_LIMIT)
  assert.equal(payload.value.dropped, 1, '超限丢弃的判定次数随响应下发')
  resetRuleDiagnostics()
  const clean = fakeRes()
  await handler(fakeReq({ body: {} }), clean)
  const cleanPayload = JSON.parse(clean.body).value
  assert.deepEqual(cleanPayload.records, [])
  assert.equal('dropped' in cleanPayload, false, '未超限的响应不带 dropped')
})

test('契约：负责人事实按当前语义恒为 null——没有 true 生产者，也不捏造 false', async () => {
  const handlers = register()
  const res = fakeRes()
  await handlers.get(SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.bootstrap)(fakeReq({ body: { sessionId: 'live-session' } }), res)
  assert.equal(res.status, 200, res.body)
  // 字段仍在载荷里（老客户端契约），值只可能是 null：undefined 会让 strict equal 失败。
  assert.strictEqual(JSON.parse(res.body).instructions.owner.officialInstructions, null, '未观察到即 null')
})

test('契约：/tool-surface 支持官方 preset scope 且只读有效 schema', async () => {
  const handlers = register()
  const handler = handlers.get(SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.toolSurface)
  const ok = fakeRes()
  await handler(fakeReq({ body: { presetId: 'official' } }), ok)
  assert.equal(ok.status, 200)
  const payload = JSON.parse(ok.body)
  assert.equal(payload.value.source, 'preset')
  assert.equal(payload.value.presetId, 'official')
  assert.deepEqual(payload.value.tools, [{ name: 'bash', description: '运行命令' }])

  const invalid = fakeRes()
  await handler(fakeReq({ body: { sessionId: 'live-session', presetId: 'official' } }), invalid)
  assert.equal(invalid.status, 400)
  assert.equal(JSON.parse(invalid.body).code, 'tool-surface-invalid')
})

test('契约：/persona 未配置 moduleDir 时稳定拒绝', async () => {
  const handlers = register()
  const handler = handlers.get(SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.persona)
  assert.ok(handler, '/persona 端点未注册')
  const res = fakeRes()
  await handler(fakeReq({ body: {} }), res)
  assert.equal(res.status, 400)
  const payload = JSON.parse(res.body)
  assert.equal(payload.ok, false)
  assert.equal(payload.code, 'module-dir-unavailable')
})

test('契约：工具预览在 schema 成功或抛错时均释放 revision lease', async () => {
  for (const fail of [false, true]) {
    const key = {}
    let acquired = 0
    let released = 0
    const { ctx, handlers } = makeHarness({
      agentPresets: { acquireScope: async () => {
        acquired++
        return { key, [Symbol.asyncDispose]: async () => { released++ } }
      } },
      tools: { schemas: (scope) => {
        assert.equal(scope, key)
        if (fail) throw new Error('schema failed')
        return [{ name: 'example', description: 'example' }]
      } },
    })
    registerSettingsBridge(ctx, { ns: 'prompt-tool', models: () => ({ available: true, providers: [] }), skills: () => makeSkillsState() })
    const handler = handlers.get(SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.toolSurface)
    const res = fakeRes()
    await handler(fakeReq({ body: { presetId: 'official' } }), res)
    assert.equal(res.status, fail ? 409 : 200)
    assert.equal(acquired, 1)
    assert.equal(released, 1)
    const unknown = fakeRes()
    await handler(fakeReq({ body: { presetId: 'unknown' } }), unknown)
    assert.equal(unknown.status, 404)
    assert.equal(acquired, 1, '未知预设不得获取 scope')
  }
})

test('契约：失败载荷统一为 { ok: false, code?, message? }', async () => {
  const handlers = register()
  // 非法方法触发 405 失败分支。
  const handler = handlers.get(SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.meta)
  const res = fakeRes()
  await handler(fakeReq({ method: 'GET' }), res)
  assert.equal(res.status, 405)
  const payload = JSON.parse(res.body)
  assert.equal(payload.ok, false)
  assert.equal(typeof payload.code, 'string')
  assert.equal(typeof payload.message, 'string')
})
