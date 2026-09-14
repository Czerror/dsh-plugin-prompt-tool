// 负责人事实契约：/bootstrap 的 instructions.owner 来自 pre-step 协调器对该会话的观察，
// 没有协调服务或尚未观察过时为 null（不猜）。这是 UI「官方指令行仍在 → 独立来源不参战」
// 提示的唯一数据来源，不能靠客户端本地推断。
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { BRIDGE_ENDPOINTS, PRE_STEP_COORDINATOR_SERVICE, SETTINGS_BRIDGE_PREFIX, registerSettingsBridge } =
  await import('../../lib/index.mjs')

const promptConfigsPath = SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.promptConfigs
const configsDir = mkdtempSync(join(tmpdir(), 'pt-owner-configs-'))
after(() => rmSync(configsDir, { recursive: true, force: true }))

function handlersWith(getService) {
  const registered = new Map()
  const sctx = {
    settings: { describe: () => [{ ns: 'prompt-tool', value: {}, base: {} }], mutate: async () => {} },
    webServer: { register: ({ path, handler }) => { registered.set(path, handler); return () => {} } },
    agents: { get: () => undefined },
    tools: { schemas: () => [] },
    presetConfigs: { read: () => [] },
    get: getService,
    effect: (fn) => fn(),
  }
  registerSettingsBridge(
    { inject: (_deps, cb) => cb(sctx) },
    'prompt-tool',
    () => ({ available: true }),
    () => ({}),
    () => '',
    undefined,
    () => configsDir,
  )
  return registered
}

function fakeReq(body) {
  const req = {
    method: 'POST',
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: 'localhost' },
    body: body === undefined ? undefined : JSON.stringify(body),
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

/** 指令快照与负责人事实在 /prompt-configs 与 /bootstrap 走同一入口；这里取前者。 */
const callInstructions = async (getService) => {
  const handler = handlersWith(getService).get(promptConfigsPath)
  assert.ok(handler, '/prompt-configs 已注册')
  const res = fakeRes()
  await handler(fakeReq({ sessionId: 's-owner' }), res)
  assert.equal(res.status, 200, res.body)
  return JSON.parse(res.body).value.instructions
}

test('指令负责人事实：协调器观察到官方指令行 → owner.officialInstructions = true', async () => {
  const instructions = await callInstructions((name) =>
    name === PRE_STEP_COORDINATOR_SERVICE ? { officialOwnerOf: (id) => (id === 's-owner' ? true : undefined) } : undefined)
  assert.equal(instructions.owner.officialInstructions, true)
})

test('指令负责人事实：协调器观察到插件独立来源负责 → false', async () => {
  const service = { officialOwnerOf: (id) => (id === 's-owner' ? false : undefined) }
  const instructions = await callInstructions((name) => (name === PRE_STEP_COORDINATOR_SERVICE ? service : undefined))
  assert.equal(instructions.owner.officialInstructions, false)
})

test('指令负责人事实：协调器尚未观察过该会话 → null（不猜）', async () => {
  const service = { officialOwnerOf: () => undefined }
  const instructions = await callInstructions((name) => (name === PRE_STEP_COORDINATOR_SERVICE ? service : undefined))
  assert.equal(instructions.owner.officialInstructions, null)
})

test('指令负责人事实：没有协调服务（独立引擎/测试宿主）时为 null，不猜成冲突', async () => {
  const instructions = await callInstructions(() => undefined)
  assert.equal(instructions.owner.officialInstructions, null)
})
