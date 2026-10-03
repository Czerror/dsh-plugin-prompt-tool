import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync, existsSync, symlinkSync, unlinkSync } from 'node:fs'
import { join, basename } from 'node:path'
import { parse } from 'yaml'
import { isolatedHome, fakeReq, fakeRes, readBridge } from '../fixtures/host-harness.mjs'

const { home, moduleRoot } = isolatedHome('pt-rules-bridge-')
const { registerSettingsBridge } = await import('../../src/runtime/settings-bridge.ts')
const { writePreset } = await import('../../src/host/write-preset.ts')
const { compileRules } = await import('../../engine/rule-spec.mjs')
const { MAX_BRIDGE_BODY_BYTES } = await import('../../src/shared/bridge-contract.ts')
let sequence = 0

function harness({ readonly = false, rebuildFails = false, afterRebuild } = {}) {
  const id = `rules-${++sequence}`
  const directory = join(readonly ? join(home, 'system') : moduleRoot, id)
  mkdirSync(directory, { recursive: true })
  const file = join(directory, 'module.yml')
  const original = `# 用户注释\nid: ${id}\nmodules: []\nunknown: keep # 未知字段注释\n`
  writeFileSync(file, original)
  let activeDirectory = directory
  let rebuilds = 0
  const disposers = []
  const handlers = new Map()
  const sctx = {
    settings: { describe: () => [] },
    webServer: { register: ({ path, handler }) => { handlers.set(path, handler); return () => {} } },
    get: () => undefined,
    effect: fn => { const dispose = fn(); if (dispose) disposers.push(dispose) },
  }
  const ctx = { inject: (_deps, cb) => cb(sctx) }
  registerSettingsBridge(ctx, 'prompt-tool', () => ({}), () => ({}), () => '', undefined,
    () => activeDirectory, undefined, async () => {
      rebuilds++
      if (rebuildFails) throw new Error('REBUILD_FAILED')
      writePreset('', { moduleDir: moduleRoot, presetTemplate: id, outputId: id, presetOrder: 0, rules: [] })
      await afterRebuild?.(file)
    })
  test.after(() => disposers.forEach(dispose => dispose()))
  return {
    id, directory, file, original,
    get rebuilds() { return rebuilds },
    switchTo: dir => { activeDirectory = dir },
    async call(body = {}, request = {}, endpoint = 'rules') {
      const handler = handlers.get('/api/prompt-tool/settings/' + endpoint)
      assert.equal(typeof handler, 'function', '声明端点已注册')
      const res = fakeRes()
      await handler(fakeReq({ body: { expectedPresetId: id, ...body }, ...request }), res)
      return readBridge(res)
    },
  }
}

const rules = [{ id: 'budget', when: { phase: { promoted: false } }, do: [{ id: 'request', kind: 'request-params', patch: { maxTokens: 64 }, modelScope: 'all' }] }]
const createEdits = items => items.map(rule => ({ previousId: null, rule }))

test('声明读取、只校验、写盘、物化和清空往返；注释与未知字段保留', async () => {
  const h = harness()
  const retired = await h.call({}, {}, 'triggers')
  assert.equal(retired.status, 410)
  assert.equal(retired.code, 'rules-route-retired')
  assert.equal(readFileSync(h.file, 'utf8'), h.original)
  const initial = await h.call()
  assert.equal(initial.status, 200)
  assert.deepEqual(initial.value.rules, [])
  assert.equal(initial.value.meta.actions.length, 9)
  assert.match(initial.value.revision, /^[a-f0-9]{64}$/)
  const checked = await h.call({ edits: createEdits(rules), expectedRevision: initial.value.revision, validateOnly: true })
  assert.equal(checked.ok, true)
  assert.equal(readFileSync(h.file, 'utf8'), h.original)
  assert.equal(h.rebuilds, 0)
  const saved = await h.call({ edits: createEdits(rules), expectedRevision: initial.value.revision })
  assert.equal(saved.ok, true, saved.message)
  assert.equal(h.rebuilds, 1)
  assert.notEqual(saved.value.revision, initial.value.revision)
  assert.deepEqual((await h.call()).value.rules, rules)
  const source = readFileSync(h.file, 'utf8')
  assert.match(source, /用户注释/)
  assert.match(source, /未知字段注释/)
  assert.equal(parse(source).unknown, 'keep')
  const materialized = parse(readFileSync(join(h.directory, 'rules.yml'), 'utf8'))
  assert.deepEqual(materialized.rules, rules)
  assert.equal(compileRules(materialized.rules).length, 1)
  assert.match(readFileSync(join(h.directory, 'agent.cordis.yml'), 'utf8'), /rule-engine/)
  const cleared = await h.call({ edits: [{ previousId: 'budget', rule: null }], expectedRevision: saved.value.revision })
  assert.equal(cleared.ok, true, cleared.message)
  assert.deepEqual((await h.call()).value.rules, [])
  assert.deepEqual(parse(readFileSync(join(h.directory, 'rules.yml'), 'utf8')).rules, [])
})

test('坏声明、错误类型、未知载荷与缺少写入版本均不改盘', async () => {
  const h = harness()
  const { revision } = (await h.call()).value
  for (const payload of [
    { edits: {} },
    { edits: createEdits([{ ...rules[0], do: [{ id: 'bad', kind: 'missing' }] }]) },
    { edits: createEdits([{ ...rules[0], unexpected: true }]) },
    { edits: createEdits(rules), validateOnly: 'true' },
    { edits: createEdits(rules), unknown: true },
    { edits: createEdits(rules), expectedRevision: undefined },
    { edits: createEdits(rules), expectedPresetId: undefined },
  ]) {
    const result = await h.call({ expectedRevision: revision, ...payload })
    assert.equal(result.ok, false, JSON.stringify(payload))
    assert.equal(result.status, 400)
    assert.equal(readFileSync(h.file, 'utf8'), h.original)
  }
  assert.equal(h.rebuilds, 0)
})

test('外部改动和预设切换拒绝陈旧写入；重新读取返回新版本', async () => {
  const h = harness()
  const { revision } = (await h.call()).value
  const changed = h.original + 'external: user-edit\n'
  writeFileSync(h.file, changed)
  const stale = await h.call({ edits: createEdits(rules), expectedRevision: revision })
  assert.equal(stale.status, 409)
  assert.equal(stale.code, 'rules-conflict')
  assert.equal(readFileSync(h.file, 'utf8'), changed)
  const fresh = await h.call()
  assert.notEqual(fresh.value.revision, revision)
  const other = harness()
  h.switchTo(other.directory)
  assert.equal((await h.call({ edits: createEdits(rules), expectedRevision: fresh.value.revision })).status, 409)
  assert.equal(readFileSync(other.file, 'utf8'), other.original)
})

test('只读预设、非回环与跨站请求拒绝；路径不由客户端指定', async () => {
  const h = harness({ readonly: true })
  const { revision } = (await h.call()).value
  assert.equal((await h.call({ edits: createEdits(rules), expectedRevision: revision })).status, 403)
  assert.equal((await h.call({}, { remoteAddress: '192.0.2.1' })).status, 403)
  assert.equal((await h.call({}, { headers: { origin: 'https://example.com' } })).status, 403)
  assert.equal((await h.call({ expectedPresetId: '../outside' })).status, 409)
  assert.equal(readFileSync(h.file, 'utf8'), h.original)
})

test('重建失败如实反馈，已保存定义可重新读取，不报告全部生效', async () => {
  const h = harness({ rebuildFails: true })
  const { revision } = (await h.call()).value
  const result = await h.call({ edits: createEdits(rules), expectedRevision: revision })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'rules-rebuild-failed')
  assert.match(result.message, /已保存/)
  assert.deepEqual(parse(readFileSync(h.file, 'utf8')).rules, rules)
  assert.equal(basename(h.directory), h.id)
})

test('超限请求、链接定义及非模块组合不得写入规则', async () => {
  const h = harness()
  const { revision } = (await h.call()).value
  const oversized = await h.call({}, { raw: ' '.repeat(MAX_BRIDGE_BODY_BYTES + 1) })
  assert.equal(oversized.status, 413)
  assert.equal(readFileSync(h.file, 'utf8'), h.original)
  const composition = `id: ${h.id}\ncomposition: |\n  []\n`
  writeFileSync(h.file, composition)
  const fresh = await h.call()
  const unsupported = await h.call({ edits: createEdits(rules), expectedRevision: fresh.value.revision })
  assert.equal(unsupported.code, 'rules-invalid')
  assert.equal(readFileSync(h.file, 'utf8'), composition)
  const outside = join(home, 'outside-definition.yml')
  writeFileSync(outside, h.original)
  unlinkSync(h.file)
  try {
    symlinkSync(outside, h.file, 'file')
    assert.equal((await h.call({ edits: createEdits(rules), expectedRevision: revision })).ok, false)
    assert.equal(readFileSync(outside, 'utf8'), h.original)
  } finally {
    if (existsSync(h.file)) unlinkSync(h.file)
  }
})

test('文本声明的模板校验与物化均使用当前预设根；越界失败不改盘', async () => {
  const h = harness()
  mkdirSync(join(h.directory, 'assets'))
  writeFileSync(join(h.directory, 'assets', 'notice.txt'), 'TEMPLATE')
  const config = { id: 'notice', layer: 'pre-step', templateFile: './assets/notice.txt' }
  const declarations = [{ id: 'template', do: [{ id: 'inject', kind: 'inject-text', config }] }]
  const { revision } = (await h.call()).value
  const saved = await h.call({ edits: createEdits(declarations), expectedRevision: revision })
  assert.equal(saved.ok, true, saved.message)
  assert.deepEqual(parse(readFileSync(join(h.directory, 'rules.yml'), 'utf8')).rules, declarations)
  const before = readFileSync(h.file, 'utf8')
  const invalid = [{ ...declarations[0], do: [{ id: 'inject', kind: 'inject-text', config: { ...config, templateFile: '../../outside.txt' } }] }]
  const rejected = await h.call({ edits: invalid.map(rule => ({ previousId: rule.id, rule })), expectedRevision: saved.value.revision })
  assert.equal(rejected.status, 400)
  assert.match(rejected.message, /escapes preset root/)
  assert.equal(readFileSync(h.file, 'utf8'), before)
})

test('重建期间规则被另一写者更改时，不把新版本确认为旧草稿的保存凭据', async () => {
  const h = harness({ afterRebuild: file => {
    const content = readFileSync(file, 'utf8')
    writeFileSync(file, content.replace('maxTokens: 64', 'maxTokens: 128'))
  } })
  const { revision } = (await h.call()).value
  const result = await h.call({ edits: createEdits(rules), expectedRevision: revision })
  assert.equal(result.status, 409)
  assert.equal(result.code, 'rules-conflict')
  assert.equal(parse(readFileSync(h.file, 'utf8')).rules[0].do[0].patch.maxTokens, 128)
})
