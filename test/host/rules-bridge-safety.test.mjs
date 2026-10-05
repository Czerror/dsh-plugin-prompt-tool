import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import fs, { mkdirSync, readFileSync, writeFileSync, existsSync, symlinkSync, unlinkSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { parse } from 'yaml'
import { isolatedHome, fakeReq, fakeRes, readBridge } from '../fixtures/host-harness.mjs'
import { createWorkspaceDrafts } from '../../src/client/data/workspace-drafts.ts'
import { createRuleEditor, getRulesDraft, rulesDirty } from '../../src/client/data/rule-drafts.ts'

const { home, moduleRoot } = isolatedHome('pt-rules-bridge-')
const { registerSettingsBridge } = await import('../../src/runtime/settings-bridge.ts')
const { writePreset } = await import('../../src/host/write-preset.ts')
const { compileRules } = await import('../../engine/rule-spec.mjs')
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
      if (typeof rebuildFails === 'function' ? rebuildFails() : rebuildFails) throw new Error('REBUILD_FAILED')
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
      await handler(fakeReq({ body: { expectedModuleId: id, ...body }, ...request }), res)
      return readBridge(res)
    },
  }
}

const rules = [{ id: 'budget', if: { phase: { promoted: false } }, then: [{ id: 'request', kind: 'request-params', patch: { maxTokens: 64 }, modelScope: 'all' }] }]
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
  assert.match(initial.value.revisions.settings, /^[a-f0-9]{64}$/)
  const checked = await h.call({ edits: createEdits(rules), expectedRevisions: initial.value.revisions, validateOnly: true })
  assert.equal(checked.ok, true)
  assert.equal(readFileSync(h.file, 'utf8'), h.original)
  assert.equal(h.rebuilds, 0)
  const saved = await h.call({ edits: createEdits(rules), expectedRevisions: initial.value.revisions })
  assert.equal(saved.ok, true, saved.message)
  assert.equal(h.rebuilds, 1)
  assert.notEqual(saved.value.revisions.settings, initial.value.revisions.settings)
  assert.deepEqual((await h.call()).value.rules, rules)
  const source = readFileSync(h.file, 'utf8')
  assert.match(source, /用户注释/)
  assert.match(source, /未知字段注释/)
  assert.equal(parse(source).unknown, 'keep')
  const materialized = parse(readFileSync(join(h.directory, 'rules/budget.yml'), 'utf8'))
  assert.deepEqual(materialized, rules[0])
  assert.equal(compileRules([materialized]).length, 1)
  const cleared = await h.call({ edits: [{ previousId: 'budget', rule: null }], expectedRevisions: saved.value.revisions })
  assert.equal(cleared.ok, true, cleared.message)
  assert.deepEqual((await h.call()).value.rules, [])
  assert.deepEqual(parse(readFileSync(join(h.directory, 'rules/_settings.yml'), 'utf8')).rules, {})
})

test('坏声明、错误类型、未知载荷与缺少写入版本均不改盘', async () => {
  const h = harness()
  const { revisions } = (await h.call()).value
  for (const payload of [
    { edits: {} },
    { edits: createEdits([{ ...rules[0], then: [{ id: 'bad', kind: 'missing' }] }]) },
    { edits: createEdits([{ ...rules[0], unexpected: true }]) },
    { edits: createEdits(rules), validateOnly: 'true' },
    { edits: createEdits(rules), unknown: true },
    { edits: createEdits(rules), expectedRevisions: undefined },
    { edits: createEdits(rules), expectedModuleId: undefined },
  ]) {
    const result = await h.call({ expectedRevisions: revisions, ...payload })
    assert.equal(result.ok, false, JSON.stringify(payload))
    assert.equal(result.status, 400)
    assert.equal(readFileSync(h.file, 'utf8'), h.original)
  }
  assert.equal(h.rebuilds, 0)
})

test('外部改动和预设切换拒绝陈旧写入；重新读取返回新版本', async () => {
  const h = harness()
  const { revisions } = (await h.call()).value
  const changed = h.original + 'variablesEnabled: false\n'
  writeFileSync(h.file, changed)
  const stale = await h.call({ edits: createEdits(rules), expectedRevisions: revisions })
  assert.equal(stale.status, 409)
  assert.equal(stale.code, 'rules-conflict')
  assert.equal(readFileSync(h.file, 'utf8'), changed)
  const fresh = await h.call()
  assert.notEqual(fresh.value.revisions.settings, revisions.settings)
  const other = harness()
  h.switchTo(other.directory)
  assert.equal((await h.call({ edits: createEdits(rules), expectedRevisions: fresh.value.revisions })).status, 409)
  assert.equal(readFileSync(other.file, 'utf8'), other.original)
})

test('只读预设、非回环与跨站请求拒绝；路径不由客户端指定', async () => {
  const h = harness({ readonly: true })
  const { revisions } = (await h.call()).value
  assert.equal((await h.call({ edits: createEdits(rules), expectedRevisions: revisions })).status, 403)
  assert.equal((await h.call({}, { remoteAddress: '192.0.2.1' })).status, 403)
  assert.equal((await h.call({}, { headers: { origin: 'https://example.com' } })).status, 403)
  assert.equal((await h.call({ expectedModuleId: '../outside' })).status, 409)
  assert.equal(readFileSync(h.file, 'utf8'), h.original)
})

test('重建失败如实反馈，已保存定义可重新读取，不报告全部生效', async () => {
  const h = harness({ rebuildFails: true })
  const { revisions } = (await h.call()).value
  const result = await h.call({ edits: createEdits(rules), expectedRevisions: revisions })
  assert.equal(result.ok, true)
  assert.equal(result.value.persisted, true)
  assert.match(result.value.publicationError, /已保存/)
  assert.deepEqual(parse(readFileSync(h.file, 'utf8')).rules, rules)
})

test('链接定义及非模块组合不得写入规则', async () => {
  const h = harness()
  const { revisions } = (await h.call()).value
  const composition = `id: ${h.id}\ncomposition: |\n  []\n`
  writeFileSync(h.file, composition)
  const fresh = await h.call()
  const unsupported = await h.call({ edits: createEdits(rules), expectedRevisions: fresh.value.revisions })
  assert.equal(unsupported.code, 'rules-invalid')
  assert.equal(readFileSync(h.file, 'utf8'), composition)
  const outside = join(home, 'outside-definition.yml')
  writeFileSync(outside, h.original)
  unlinkSync(h.file)
  try {
    symlinkSync(outside, h.file, 'file')
    assert.equal((await h.call({ edits: createEdits(rules), expectedRevisions: revisions })).ok, false)
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
  const declarations = [{ id: 'template', then: [{ id: 'inject', kind: 'inject-text', config }] }]
  const { revisions } = (await h.call()).value
  const saved = await h.call({ edits: createEdits(declarations), expectedRevisions: revisions })
  assert.equal(saved.ok, true, saved.message)
  assert.deepEqual(parse(readFileSync(join(h.directory, 'rules/template.yml'), 'utf8')), declarations[0])
  const before = readFileSync(h.file, 'utf8')
  const invalid = [{ ...declarations[0], then: [{ id: 'inject', kind: 'inject-text', config: { ...config, templateFile: '../../outside.txt' } }] }]
  const rejected = await h.call({ edits: invalid.map(rule => ({ previousId: rule.id, rule })), expectedRevisions: saved.value.revisions })
  assert.equal(rejected.status, 400)
  assert.match(rejected.message, /escapes preset root/)
  assert.equal(readFileSync(h.file, 'utf8'), before)
})

test('重建期间规则被另一写者更改时，不把新版本确认为旧草稿的保存凭据', async () => {
  const h = harness({ afterRebuild: file => {
    const content = readFileSync(file, 'utf8')
    writeFileSync(file, content.replace('maxTokens: 64', 'maxTokens: 128'))
  } })
  const { revisions } = (await h.call()).value
  const result = await h.call({ edits: createEdits(rules), expectedRevisions: revisions })
  assert.equal(result.status, 409)
  assert.equal(result.code, 'rules-conflict')
  assert.equal(parse(readFileSync(h.file, 'utf8')).rules[0].then[0].patch.maxTokens, 128)
})

test('变量值与开关各自校验版本，不覆盖陈旧字段，发布失败返回已提交快照', async () => {
  const h = harness({ rebuildFails: true })
  const call = body => h.call(body, {}, 'module-variables')
  const initial = await call({})
  assert.equal(initial.ok, true)
  const saved = await call({ variables: { city: 'A' }, expectedRevisions: { variables: initial.value.revisions.variables } })
  assert.equal(saved.ok, true)
  assert.equal(saved.value.persisted, true)
  assert.match(saved.value.publicationError, /已保存/)
  assert.deepEqual(saved.value.variables, { city: 'A' })
  const stale = await call({ variables: { city: 'STALE' }, expectedRevisions: { variables: initial.value.revisions.variables } })
  assert.equal(stale.status, 409)
  assert.deepEqual(parse(readFileSync(h.file, 'utf8')).variables, { city: 'A' })
  const toggled = await call({ enabled: false, expectedRevisions: { settings: initial.value.revisions.settings } })
  assert.equal(toggled.ok, true, toggled.message)
  assert.equal(toggled.value.enabled, false)
  assert.deepEqual(toggled.value.variables, { city: 'A' })
  assert.equal((await call({ enabled: true, expectedRevisions: { settings: initial.value.revisions.settings } })).status, 409)
  assert.equal((await call({ variables: { city: 'X' } })).status, 400)
})

test('module.yml已提交但切片发布持续失败时仍确认已保存及新版本，不触发二次恢复', async () => {
  const h = harness()
  const initial = await h.call()
  const originalRename = fs.renameSync
  const rename = mock.method(fs, 'renameSync', (from, to) => {
    if (String(to).endsWith('_settings.yml')) throw new Error('SETTINGS_PUBLICATION_FAILED')
    return originalRename(from, to)
  })
  syncBuiltinESMExports()
  try {
    const result = await h.call({ edits: createEdits(rules), expectedRevisions: initial.value.revisions })
    assert.equal(result.ok, true, result.message)
    assert.equal(result.value.persisted, true)
    assert.match(result.value.publicationError, /已保存.*SETTINGS_PUBLICATION_FAILED/)
    assert.deepEqual(result.value.rules, rules)
    assert.notEqual(result.value.revisions.settings, initial.value.revisions.settings)
    assert.equal(h.rebuilds, 0)
    assert.deepEqual(parse(readFileSync(h.file, 'utf8')).rules, rules)
  } finally { rename.mock.restore(); syncBuiltinESMExports() }
})

test('能力候选提交前外部定义改变时拒绝写入，不用旧快照回滚用户改动', async () => {
  const h = harness()
  await h.call()
  const external = h.original + 'external: PRESERVE USER EDIT\n'
  const originalWrite = fs.writeFileSync
  let changed = false
  const write = mock.method(fs, 'writeFileSync', (file, ...args) => {
    const result = originalWrite(file, ...args)
    if (!changed && String(file).includes('.module.yml.tmp-')) {
      changed = true
      originalWrite(h.file, external)
    }
    return result
  })
  syncBuiltinESMExports()
  try {
    const rejected = await h.call({ action: 'create', capabilityId: 'tool-git-bash' }, {}, 'module-capability')
    assert.equal(changed, true, '探针必须到达完整定义提交前')
    assert.equal(rejected.ok, false)
    assert.equal(readFileSync(h.file, 'utf8'), external)
  } finally { write.mock.restore(); syncBuiltinESMExports() }
})

test('规则编辑器发布失败后只刷新重试，保留在途输入且不重放新增', async () => {
  let fail = true
  const h = harness({ rebuildFails: () => fail })
  const draft = getRulesDraft(createWorkspaceDrafts(), h.id)
  const editor = createRuleEditor(h.id, draft, { request: body => h.call(body), enqueue: async (_id, task) => task(), isCurrent: () => true, changed: () => {} })
  await editor.load()
  const key = editor.add(rules[0])
  assert.equal(await editor.submit(), false)
  assert.equal(draft.publicationPending, true)
  assert.equal(rulesDirty(draft), false)
  assert.equal(h.rebuilds, 1)
  const committed = readFileSync(h.file, 'utf8')
  await editor.load(true)
  assert.equal(draft.publicationPending, true)
  assert.match(draft.error, /REBUILD_FAILED/)
  assert.equal(h.rebuilds, 1, '读取不宣称再次发布')
  editor.patch(key, { ...draft.entries[0].value, name: '尚未保存的新输入' })
  fail = false
  assert.equal(await editor.retryPublication(), true)
  assert.equal(h.rebuilds, 2)
  assert.equal(draft.publicationPending, false)
  assert.equal(draft.entries[0].value.name, '尚未保存的新输入')
  assert.equal(rulesDirty(draft), true)
  assert.equal(readFileSync(h.file, 'utf8'), committed)
  assert.equal(parse(committed).rules.length, 1)
  assert.equal((await h.call({ refreshOnly: true, edits: [] })).status, 400)
  const locked = harness({ readonly: true })
  assert.equal((await locked.call({ refreshOnly: true })).status, 403)
})

test('变量发布重试仅刷新一次已保存定义，拒绝混合写入与只读目标', async () => {
  let fail = true
  const h = harness({ rebuildFails: () => fail })
  const call = body => h.call(body, {}, 'module-variables')
  const initial = await call({})
  const saved = await call({ variables: { name: 'persisted' }, expectedRevisions: { variables: initial.value.revisions.variables } })
  assert.equal(saved.value.publicationPending, true)
  const committed = readFileSync(h.file, 'utf8')
  fail = false
  const refreshed = await call({ refreshOnly: true })
  assert.equal(refreshed.ok, true, refreshed.message)
  assert.equal(refreshed.value.publicationPending, false)
  assert.equal(h.rebuilds, 2)
  assert.equal(readFileSync(h.file, 'utf8'), committed)
  assert.equal((await call({ refreshOnly: true, variables: { name: 'REPLAY' } })).status, 400)
  const locked = harness({ readonly: true })
  assert.equal((await locked.call({ refreshOnly: true }, {}, 'module-variables')).status, 403)
})
