import test from 'node:test'
import assert from 'node:assert/strict'
import fs, { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
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
function harness(extra = '') {
  const target = makeModule(extra)
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

test('paramOverrides：写盘后切片重建失败仍回 200 + 待发布', async () => {
  const { target, handlers } = harness()
  // 先读一次，让模块已有切片，避免在 ensure 阶段触发注入。
  assert.equal((await call(handlers, 'paramOverrides', {}, target.id)).status, 200)
  const originalRename = fs.renameSync
  const originalRead = fs.readFileSync
  let persistedWritten = false
  fs.renameSync = (from, to) => {
    const result = originalRename(from, to)
    if (String(to).endsWith('module.yml')) persistedWritten = true
    return result
  }
  fs.readFileSync = (path, ...args) => {
    if (persistedWritten && String(path).includes('rules')) throw new Error('SLICE_READ_FAILED')
    return originalRead(path, ...args)
  }
  syncBuiltinESMExports()
  try {
    const saved = await call(handlers, 'paramOverrides', { expectedModuleId: target.id, overrides: { modelTemperature: 0.5 } }, target.id)
    assert.equal(saved.status, 200, saved.message)
    assert.equal(saved.value.persisted, true)
    assert.equal(saved.value.publicationPending, true)
    assert.match(saved.value.publicationError, /SLICE_READ_FAILED/)
  } finally {
    fs.renameSync = originalRename
    fs.readFileSync = originalRead
    syncBuiltinESMExports()
  }
})

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
test('persona：写盘成功、发布失败回 200 + 待发布', async () => {
  const { target, handlers, state } = harness()
  state.failOverrides = true
  const saved = await call(handlers, 'persona', { expectedModuleId: target.id, persona: { main: { prefix: 'x' } } }, target.id)
  assert.equal(saved.status, 200, saved.message)
  assert.equal(saved.value.publicationPending, true)
  assert.equal(saved.value.persona.main.prefix, 'x')
})

test('personaSources：写盘成功、发布失败回 200 + 待发布', async () => {
  const { handlers, state } = harness()
  state.failOverrides = true
  const saved = await call(handlers, 'personaSources', { sources: { main: null, subagent: null }, expectedRevision: null })
  assert.equal(saved.status, 200, saved.message)
  assert.equal(saved.value.publicationPending, true)
})

test('rules：写盘成功、发布失败回 200 + 待发布', async () => {
  const { target, handlers, state } = harness()
  state.failOverrides = true
  const rule = { id: 'r1', then: [{ id: 'a1', kind: 'inject-text', config: { id: 'a1', layer: 'pre-step', text: 'x' } }] }
  const saved = await call(handlers, 'rules', { expectedModuleId: target.id, expectedRulesAbsent: true, createRule: rule }, target.id)
  assert.equal(saved.status, 200, saved.message)
  assert.equal(saved.value.publicationPending, true)
})

test('moduleVariables：写盘成功、发布失败回 200 + 待发布', async () => {
  const { target, handlers, state } = harness('variables: {}\nvariablesEnabled: true\n')
  const initial = await call(handlers, 'moduleVariables', { scope: 'module', expectedModuleId: target.id }, target.id)
  assert.equal(initial.status, 200, initial.message)
  state.failOverrides = true
  const saved = await call(handlers, 'moduleVariables', {
    scope: 'module', variables: { k: 'v' }, enabled: false, expectedModuleId: target.id,
    expectedRevisions: { module: initial.value.revisions.module, settings: initial.value.revisions.settings },
  }, target.id)
  assert.equal(saved.status, 200, saved.message)
  assert.equal(saved.value.publicationPending, true)
})

test('moduleName：写盘成功、发布失败回 200 + 待发布；refreshOnly 只重试', async () => {
  const { target, handlers, state } = harness()
  const current = await call(handlers, 'moduleName', {}, target.id)
  assert.equal(current.status, 200, current.message)
  const before = readFileSync(join(target.dir, 'module.yml'), 'utf8')
  state.failOverrides = true
  const saved = await call(handlers, 'moduleName', { name: '新名', expectedRevision: current.value.revision, expectedModuleId: target.id }, target.id)
  assert.equal(saved.status, 200, saved.message)
  assert.equal(saved.value.publicationPending, true)
  const written = readFileSync(join(target.dir, 'module.yml'), 'utf8')
  assert.notEqual(written, before)
  state.failOverrides = false
  const retried = await call(handlers, 'moduleName', { refreshOnly: true }, target.id)
  assert.equal(retried.status, 200, retried.message)
  assert.equal(retried.value.publicationPending, false)
  assert.equal(readFileSync(join(target.dir, 'module.yml'), 'utf8'), written, 'refreshOnly 不重写名称')
})
test('moduleClone/moduleDuplicate：写盘成功、发布失败回 200 + 待发布', async () => {
  const { target, handlers, state } = harness()
  state.failList = true
  const duplicated = await call(handlers, 'moduleDuplicate', { id: target.id })
  assert.equal(duplicated.status, 200, duplicated.message)
  assert.equal(duplicated.value.publicationPending, true)
  const cloned = await call(handlers, 'moduleClone', { id: 'blank' })
  assert.equal(cloned.status, 200, cloned.message)
  assert.equal(cloned.value.publicationPending, true)
  state.failList = false
  const retried = await call(handlers, 'moduleDuplicate', { id: target.id, refreshOnly: true })
  assert.equal(retried.status, 200, retried.message)
  assert.equal(retried.value.publicationPending, false)
  const mixed = await call(handlers, 'moduleClone', { id: 'blank', refreshOnly: true, autoSuffix: true })
  assert.equal(mixed.status, 400, 'refreshOnly 与 autoSuffix 混用必须拒绝')
})

test('moduleConfigOrder：读响应不带发布字段，refreshOnly 才带', async () => {
  const { handlers } = harness()
  const read = await call(handlers, 'moduleConfigOrder')
  assert.equal(read.status, 200, read.message)
  assert.equal(read.value.persisted, undefined)
  assert.equal(read.value.publicationPending, undefined)
  const retried = await call(handlers, 'moduleConfigOrder', { refreshOnly: true })
  assert.equal(retried.status, 200, retried.message)
  assert.equal(retried.value.persisted, true)
  assert.equal(retried.value.publicationPending, false)
})
