// /instructions-policy 端点契约：读取默认值、乐观并发写入、白名单拒绝、损坏文件拒绝覆盖、
// loopback 防护。DSH_HOME 指向独立临时目录，绝不触碰真实用户策略文件。
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'pt-instructions-policy-bridge-'))
const previousHome = process.env.DSH_HOME
process.env.DSH_HOME = home
after(() => {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  rmSync(home, { recursive: true, force: true })
})

const { BRIDGE_ENDPOINTS, SETTINGS_BRIDGE_PREFIX, registerSettingsBridge } = await import('../../lib/index.mjs')

const policyPath = join(home, '.prompt-tool', 'instructions.yml')
const endpoint = SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.instructionsPolicy

function handlers() {
  const registered = new Map()
  const sctx = {
    settings: { describe: () => [{ ns: 'prompt-tool', value: {}, base: {} }], mutate: async () => {} },
    webServer: { register: ({ path, handler }) => { registered.set(path, handler); return () => {} } },
    agents: { get: () => undefined },
    tools: { schemas: () => [] },
    get: () => undefined,
    effect: (fn) => fn(),
  }
  registerSettingsBridge({ inject: (_deps, cb) => cb(sctx) }, 'prompt-tool', () => ({ available: true }), () => ({}), () => '')
  return registered
}

function fakeReq(body, overrides = {}) {
  const req = {
    method: 'POST',
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: 'localhost' },
    body: body === undefined ? undefined : JSON.stringify(body),
    ...overrides,
  }
  req[Symbol.asyncIterator] = function* () {
    if (req.body !== undefined) yield Buffer.from(String(req.body))
  }
  return req
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

const call = async (handler, body) => {
  const res = fakeRes()
  await handler(fakeReq(body), res)
  return { status: res.status, payload: JSON.parse(res.body) }
}

test('读取：策略文件缺失时返回默认值（enabled=false）且不创建文件', async () => {
  const handler = handlers().get(endpoint)
  assert.ok(handler, '端点未注册')
  const { status, payload } = await call(handler, {})
  assert.equal(status, 200)
  assert.equal(payload.ok, true)
  assert.equal(payload.value.exists, false)
  assert.equal(payload.value.revision, null)
  assert.equal(payload.value.policy.enabled, false)
  assert.deepEqual(payload.value.policy.defaults, { order: 30, position: 'after-user', promotion: 'none', audience: null, modelScope: 'all' })
  assert.equal(existsSync(policyPath), false)
})

test('写入：expectedRevision=null 创建策略；过期版本返回 409 且文件不变', async () => {
  const handler = handlers().get(endpoint)
  const created = await call(handler, { policy: { enabled: true, files: { f1: { order: 45 } } }, expectedRevision: null })
  assert.equal(created.status, 200)
  assert.equal(created.payload.value.policy.enabled, true)
  assert.equal(existsSync(policyPath), true)
  const raw = readFileSync(policyPath, 'utf8')
  const stale = await call(handler, { policy: { enabled: false }, expectedRevision: null })
  assert.equal(stale.status, 409)
  assert.equal(stale.payload.code, 'instructions-policy-conflict')
  assert.equal(readFileSync(policyPath, 'utf8'), raw)
})

test('写入：未知字段与非有限 order 拒绝，文件不变', async () => {
  const handler = handlers().get(endpoint)
  const raw = readFileSync(policyPath, 'utf8')
  const current = await call(handler, {})
  const withText = await call(handler, { policy: { files: { f1: { text: '正文不得进策略' } } }, expectedRevision: current.payload.value.revision })
  assert.equal(withText.status, 400)
  assert.match(withText.payload.message, /未知字段/)
  const badOrder = await call(handler, { policy: { defaults: { order: -3 } }, expectedRevision: current.payload.value.revision })
  assert.equal(badOrder.status, 400)
  const missingRevision = await call(handler, { policy: { enabled: false } })
  assert.equal(missingRevision.status, 400)
  assert.equal(readFileSync(policyPath, 'utf8'), raw)
})

test('损坏文件：读取带 error，写入拒绝且不覆盖', async () => {
  const handler = handlers().get(endpoint)
  mkdirSync(dirname(policyPath), { recursive: true })
  writeFileSync(policyPath, 'enabled: [unclosed\n', 'utf8')
  const read = await call(handler, {})
  assert.equal(read.status, 200)
  assert.match(read.payload.value.error ?? '', /YAML/)
  const write = await call(handler, { policy: { enabled: true }, expectedRevision: read.payload.value.revision })
  assert.equal(write.status, 409)
  assert.equal(write.payload.code, 'instructions-policy-unreadable')
  assert.equal(readFileSync(policyPath, 'utf8'), 'enabled: [unclosed\n')
})

test('非 loopback 请求被拒绝', async () => {
  const handler = handlers().get(endpoint)
  const res = fakeRes()
  await handler(fakeReq({}, { socket: { remoteAddress: '10.1.2.3' } }), res)
  assert.equal(res.status, 403)
})
