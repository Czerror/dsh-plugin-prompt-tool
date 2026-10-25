import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fakeReq, fakeRes, isolatedHome, makeHostContext, readBridge } from '../fixtures/host-harness.mjs'

const { moduleRoot } = isolatedHome('pt-publication-state-')
const { registerSettingsBridge } = await import('../../src/runtime/settings-bridge.ts')
const { BRIDGE_ENDPOINTS } = await import('../../src/shared/bridge-contract.ts')
const PREFIX = '/api/prompt-tool/settings'
const TOOL = { id: 'shell', description: '运行命令', output: { schema: { type: 'string' } }, execute: { kind: 'shell', command: 'echo' } }

let sequence = 0
function makeModule(extra = '') {
  const id = `pub-${++sequence}`
  const dir = join(moduleRoot, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'module.yml'), `id: ${id}\nname: ${id}\nmodules: []\n${extra}`, 'utf8')
  return { id, dir }
}

/** 发布回调按开关抛错：同一个 harness 覆盖「已写盘但发布失败」与「重试只重建」。 */
function harness() {
  const target = makeModule()
  const { ctx, handlers } = makeHostContext({})
  const state = { failOverrides: false, failCapability: false, failInstall: false, failList: false }
  registerSettingsBridge(ctx, {
    ns: 'prompt-tool',
    models: () => ({ available: true, providers: [] }),
    skills: () => ({}),
    moduleDirectory: () => target.dir,
    overridesChanged: async () => { if (state.failOverrides) throw new Error('PUBLISH_FAILED') },
    capabilityChanged: async () => { if (state.failCapability) throw new Error('PUBLISH_FAILED') },
    moduleInstalled: async () => { if (state.failInstall) throw new Error('PUBLISH_FAILED') },
    moduleListChanged: async () => { if (state.failList) throw new Error('PUBLISH_FAILED') },
  })
  return { target, handlers, state }
}

async function call(handlers, endpoint, body, id) {
  const handler = handlers.get(PREFIX + BRIDGE_ENDPOINTS[endpoint])
  assert.ok(handler, endpoint + ' 端点已注册')
  const res = fakeRes()
  await handler(fakeReq({ body, headers: { host: 'localhost', ...(id === undefined ? {} : { 'x-module-id': id }) } }), res)
  return readBridge(res)
}

test('paramOverrides：写盘成功、发布失败回 200 + 待发布；refreshOnly 只重试不重写', async () => {
  const { target, handlers, state } = harness()
  state.failOverrides = true
  const saved = await call(handlers, 'paramOverrides', { expectedModuleId: target.id, overrides: { modelTemperature: 0.5 } }, target.id)
  assert.equal(saved.status, 200, saved.message)
  assert.equal(saved.value.persisted, true)
  assert.equal(saved.value.publicationPending, true)
  assert.match(saved.value.publicationError, /PUBLISH_FAILED/)
  const before = readFileSync(join(target.dir, 'module.yml'), 'utf8')
  state.failOverrides = false
  const retried = await call(handlers, 'paramOverrides', { expectedModuleId: target.id, refreshOnly: true }, target.id)
  assert.equal(retried.status, 200, retried.message)
  assert.equal(retried.value.publicationPending, false)
  assert.equal(retried.value.overrides.modelTemperature, 0.5)
  assert.equal(readFileSync(join(target.dir, 'module.yml'), 'utf8'), before, 'refreshOnly 不重写定义')
  const mixed = await call(handlers, 'paramOverrides', { expectedModuleId: target.id, refreshOnly: true, overrides: {} }, target.id)
  assert.equal(mixed.status, 400)
})

test('customTools：写盘成功、发布失败回 200 + 待发布；refreshOnly 只重试', async () => {
  const { target, handlers, state } = harness()
  state.failOverrides = true
  const saved = await call(handlers, 'customTools', { expectedModuleId: target.id, customTools: [TOOL] }, target.id)
  assert.equal(saved.status, 200, saved.message)
  assert.equal(saved.value.publicationPending, true)
  state.failOverrides = false
  const retried = await call(handlers, 'customTools', { expectedModuleId: target.id, refreshOnly: true }, target.id)
  assert.equal(retried.status, 200, retried.message)
  assert.equal(retried.value.publicationPending, false)
  assert.deepEqual(retried.value.customTools, [TOOL])
  const mixed = await call(handlers, 'customTools', { expectedModuleId: target.id, refreshOnly: true, customTools: [TOOL] }, target.id)
  assert.equal(mixed.status, 400)
})

test('moduleCapability：写盘成功、发布失败回 200 + 待发布；refreshOnly 只重建', async () => {
  const { target, handlers, state } = harness()
  state.failCapability = true
  const saved = await call(handlers, 'moduleCapability', { action: 'create', capabilityId: 'instruction-hint', expectedModuleId: target.id }, target.id)
  assert.equal(saved.status, 200, saved.message)
  assert.equal(saved.value.publicationPending, true)
  state.failCapability = false
  const retried = await call(handlers, 'moduleCapability', { expectedModuleId: target.id, refreshOnly: true }, target.id)
  assert.equal(retried.status, 200, retried.message)
  assert.equal(retried.value.publicationPending, false)
  assert.ok(retried.value.capabilityIds.includes('instruction-hint'))
  const mixed = await call(handlers, 'moduleCapability', { action: 'create', capabilityId: 'instruction-hint', expectedModuleId: target.id, refreshOnly: true }, target.id)
  assert.equal(mixed.status, 400)
})

test('其余纳入端点：refreshOnly 只重建，不重复创建/删除/安装', async () => {
  const { target, handlers } = harness()
  for (const [endpoint, body] of [
    ['moduleClone', { id: target.id, refreshOnly: true }],
    ['moduleDuplicate', { id: target.id, refreshOnly: true }],
    ['moduleDelete', { id: target.id, refreshOnly: true }],
    ['moduleEnable', { refreshOnly: true }],
    ['moduleConfigOrder', { refreshOnly: true }],
    ['importModulePackage', { targetId: target.id, refreshOnly: true }],
  ]) {
    const result = await call(handlers, endpoint, body)
    assert.equal(result.status, 200, endpoint + ': ' + result.message)
    assert.equal(result.value.publicationPending, false, endpoint)
  }
  assert.equal(existsSync(target.dir), true, 'refreshOnly 不删除目标模块')
  assert.equal(existsSync(join(moduleRoot, target.id + '-copy')), false, 'refreshOnly 不复制模块')
})
