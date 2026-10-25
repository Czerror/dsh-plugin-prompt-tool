import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import fs, { mkdirSync, readFileSync, writeFileSync, existsSync, symlinkSync, unlinkSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { parse } from 'yaml'
import { isolatedHome, fakeReq, fakeRes, makeHostContext, readBridge } from '../fixtures/host-harness.mjs'
import { createWorkspaceDrafts } from '../../src/client/data/workspace-drafts.ts'
import { createRuleEditor, getRulesDraft, rulesDirty } from '../../src/client/data/rule-drafts.ts'

const { home, moduleRoot } = isolatedHome('pt-rules-bridge-')
const { registerSettingsBridge } = await import('../../src/runtime/settings-bridge.ts')
const { writeModule } = await import('../../src/host/write-module.ts')
const { compileRules } = await import('../../engine/rule-spec.mjs')
const { ACTION_KINDS } = await import('../../engine/actions/catalog.mjs')
const { setModuleEnabled } = await import('../../src/host/config-store.ts')
let sequence = 0

function harness({ readonly = false, rebuildFails = false, afterRebuild, onResolveTarget, declareRules = true } = {}) {
  const id = `rules-${++sequence}`
  const directory = join(readonly ? join(home, 'system') : moduleRoot, id)
  mkdirSync(directory, { recursive: true })
  const file = join(directory, 'module.yml')
  // 声明面：这个夹具建模的是「有规则、有变量的模块」，所以顶层 `rules` 与 `variables` 必须声明
  // （键整个不存在＝没声明，端点会被 400 `module-not-declared` 拒）。人设按用例各自追加声明。
  const original = `# 用户注释\nid: ${id}\nmodules: []\n${declareRules ? 'rules: []\n' : ''}variables: {}\nunknown: keep # 未知字段注释\n`
  writeFileSync(file, original)
  let activeDirectory = directory
  let rebuilds = 0
  const disposers = []
  // 差异项：本文件的 effect 收集 disposer；其余走 harness 默认值。
  const { ctx, handlers } = makeHostContext({
    describe: () => [],
    effect: fn => { const dispose = fn(); if (dispose) disposers.push(dispose) },
  })
  registerSettingsBridge(ctx, {
    ns: 'prompt-tool',
    models: () => ({}),
    skills: () => ({}),
    moduleDirectory: () => { onResolveTarget?.(); return activeDirectory },
    overridesChanged: async () => {
      rebuilds++
      if (typeof rebuildFails === 'function' ? rebuildFails() : rebuildFails) throw new Error('REBUILD_FAILED')
      writeModule({ modulesRoot: moduleRoot, moduleId: id, targetModuleId: id })
      await afterRebuild?.(file)
    },
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
  // 动作种类数从 catalog 派生：新增一类动作（如 tool-narrow）不该让这条契约测试红，
  // 但没有下发动作元数据才是真的坏了。
  assert.equal(initial.value.meta.actions.length, Object.keys(ACTION_KINDS).length)
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
    { edits: createEdits(rules), expectedRevision: '0'.repeat(64) },
    { edits: createEdits(rules), expectedModuleId: undefined },
  ]) {
    const result = await h.call({ expectedRevisions: revisions, ...payload })
    assert.equal(result.ok, false, JSON.stringify(payload))
    assert.equal(result.status, 400)
    assert.equal(readFileSync(h.file, 'utf8'), h.original)
  }
  const unknown = await h.call({ expectedRevisions: revisions, edits: createEdits(rules), unknown: true })
  assert.equal(unknown.status, 400)
  assert.equal(unknown.code, 'bridge-request-invalid', '顶层未知字段统一由字段表拒绝')
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

test('请求处理期间编辑目标被换掉时按当次解析拒绝，不写另一模块', async () => {
  let other
  let resolved = 0
  // 目标在「handler 取到 dir」之后、「身份重检」之前被换掉：只有每次重新解析才能发现。
  const h = harness({ onResolveTarget: () => { if (++resolved === 2) h.switchTo(other.directory) } })
  other = harness()
  const rejected = await h.call()
  assert.equal(rejected.status, 409)
  assert.equal(rejected.code, 'module-changed')
  assert.equal(readFileSync(h.file, 'utf8'), h.original)
  assert.equal(readFileSync(other.file, 'utf8'), other.original)
})

test('缺少 rules 的模块拒绝读回，只允许显式首写且陈旧首写冲突', async () => {
  const h = harness({ declareRules: false })
  const before = readFileSync(h.file)
  const read = await h.call()
  assert.equal(read.status, 400)
  assert.equal(read.code, 'module-not-declared')
  assert.ok(readFileSync(h.file).equals(before))

  const body = { expectedRulesAbsent: true, createRule: rules[0] }
  const saved = await h.call(body)
  assert.equal(saved.ok, true, saved.message)
  assert.equal(saved.value.createdRuleId, 'budget')
  assert.deepEqual(saved.value.rules, rules)
  assert.deepEqual(parse(readFileSync(h.file, 'utf8')).rules, rules)
  assert.equal(saved.value.rules[0].enabled, undefined, '首写不自动启用规则')

  const stale = await h.call(body)
  assert.equal(stale.status, 409)
  assert.equal(stale.code, 'rules-conflict')
  assert.deepEqual(parse(readFileSync(h.file, 'utf8')).rules, rules, '陈旧首写不覆盖已提交规则')
  assert.equal(h.rebuilds, 1)

  const declared = harness()
  const declaredBefore = readFileSync(declared.file)
  const wrongPrecondition = await declared.call(body)
  assert.equal(wrongPrecondition.status, 409)
  assert.equal(wrongPrecondition.code, 'rules-conflict')
  assert.ok(readFileSync(declared.file).equals(declaredBefore))
})

test('共享引用：规则编辑连带改到无关键时过桥返回 400 shared-alias 且零写盘', async () => {
  const h = harness()
  // 嵌套标量与无关键共享锚点：局部编辑会写到同一个节点，候选比对与序列化都必须判为共享引用。
  const aliased = `id: ${h.id}\nmodules: []\nvariables: {}\nrules:\n  - id: budget\n    name: &shared Before\n    then:\n      - { id: request, kind: request-params, patch: { maxTokens: 512 } }\nunknown: *shared\n`
  writeFileSync(h.file, aliased)
  const read = await h.call()
  assert.equal(read.status, 200, JSON.stringify(read))
  const edited = await h.call({
    expectedRevisions: read.value.revisions,
    edits: [{ previousId: 'budget', rule: { ...read.value.rules[0], name: 'After' } }],
  })
  assert.equal(edited.ok, false)
  assert.equal(edited.status, 400)
  assert.equal(edited.code, 'shared-alias', '不变量有自己的错误码，客户端可按码分支')
  assert.match(edited.message, /YAML.*引用/)
  assert.equal(readFileSync(h.file, 'utf8'), aliased, '拒绝时定义逐字节不变')
})

test('缺少 rules 的非法显式首写拒绝时不物化规则切片', async () => {
  const h = harness({ declareRules: false })
  const before = readFileSync(h.file)
  const rejected = await h.call({
    expectedRulesAbsent: true,
    createRule: { ...rules[0], then: [{ id: 'bad', kind: 'missing' }] },
  })
  assert.equal(rejected.ok, false)
  assert.equal(rejected.status, 400)
  assert.equal(rejected.code, 'rules-invalid')
  assert.deepEqual(readFileSync(h.file), before)
  assert.equal(existsSync(join(h.directory, 'rules')), false)
})

test('显式首写仍执行三位身份校验、只读拒绝及已保存发布重试', async () => {
  const h = harness({ declareRules: false })
  const initial = readFileSync(h.file)
  const body = { expectedRulesAbsent: true, createRule: rules[0] }
  const conflict = await h.call(body, { headers: { 'x-module-id': 'other-module' } })
  assert.equal(conflict.status, 400)
  assert.equal(conflict.code, 'module-subject-conflict')
  assert.ok(readFileSync(h.file).equals(initial))

  const switched = harness({ declareRules: false })
  const switchedBefore = readFileSync(switched.file)
  h.switchTo(switched.directory)
  const changed = await h.call(body)
  assert.equal(changed.status, 409)
  assert.equal(changed.code, 'module-changed')
  assert.ok(readFileSync(switched.file).equals(switchedBefore))

  const locked = harness({ readonly: true, declareRules: false })
  const readonly = await locked.call({ expectedRulesAbsent: true, createRule: rules[0] })
  assert.equal(readonly.status, 403)
  assert.equal(readonly.code, 'module-readonly')

  const brokenIdentity = harness({ declareRules: false })
  const mismatched = `id: another-module\nmodules: []\nvariables: {}\n`
  writeFileSync(brokenIdentity.file, mismatched)
  const refused = await brokenIdentity.call({ expectedRulesAbsent: true, createRule: rules[0] })
  assert.equal(refused.ok, false)
  assert.equal(refused.status, 400)
  assert.equal(refused.code, 'rules-invalid')
  assert.equal(readFileSync(brokenIdentity.file, 'utf8'), mismatched)
  assert.equal(existsSync(join(brokenIdentity.directory, 'rules')), false, '身份拒绝不创建规则切片')

  let fail = true
  const pending = harness({ declareRules: false, rebuildFails: () => fail })
  const persisted = await pending.call({ expectedRulesAbsent: true, createRule: rules[0] })
  assert.equal(persisted.ok, true, persisted.message)
  assert.equal(persisted.value.createdRuleId, 'budget')
  assert.equal(persisted.value.persisted, true)
  assert.equal(persisted.value.publicationPending, true)
  const committed = readFileSync(pending.file, 'utf8')
  fail = false
  const refreshed = await pending.call({ refreshOnly: true })
  assert.equal(refreshed.ok, true, refreshed.message)
  assert.equal(refreshed.value.publicationPending, false)
  assert.equal(readFileSync(pending.file, 'utf8'), committed)
  assert.deepEqual(parse(committed).rules, rules, '刷新重试不重放首写')
  assert.equal(pending.rebuilds, 2)
})

test('createRule 由服务端按目标模块分配规则 id，不依赖规则读回或客户端版本', async () => {
  const h = harness()
  const first = await h.call({ createRule: rules[0] })
  assert.equal(first.ok, true, first.message)
  assert.equal(first.value.createdRuleId, 'budget')
  const second = await h.call({ createRule: rules[0] })
  assert.equal(second.ok, true, second.message)
  assert.equal(second.value.createdRuleId, 'budget-2')
  const third = await h.call({ createRule: { ...rules[0], id: 'BUDGET' } })
  assert.equal(third.ok, true, third.message)
  assert.equal(third.value.createdRuleId, 'BUDGET-3')
  assert.deepEqual(parse(readFileSync(h.file, 'utf8')).rules.map(rule => rule.id), ['budget', 'budget-2', 'BUDGET-3'])

  const template = { id: 'confirm-flow', then: [
    { id: 'seed', kind: 'inject-text', config: { layer: 'pre-step', strategy: 'static', text: 'SEED', mergeMode: 'separate', dedupe: 'session' } },
    { if: { anchor: { subject: 'assistantReasoning', keys: ['READY'], after: { action: 'seed' } } },
      then: [{ id: 'body', kind: 'inject-text', config: { layer: 'pre-step', strategy: 'static', text: 'BODY', dedupe: 'session' } }] },
  ] }
  for (const id of ['confirm-flow', 'confirm-flow-2']) {
    const created = await h.call({ createRule: template })
    assert.equal(created.ok, true, created.message)
    assert.equal(created.value.createdRuleId, id)
    const expected = { ...template, id }
    assert.deepEqual((await h.call()).value.rules.find(rule => rule.id === id), expected, '模板自动分配规则 ID 不改变同规则动作引用')
    assert.deepEqual(parse(readFileSync(join(h.directory, 'rules', `${id}.yml`), 'utf8')), expected, '物化切片保留相对引用')
  }
  const snapshot = (await h.call()).value
  const copied = snapshot.rules.find(rule => rule.id === 'confirm-flow-2')
  const edited = { ...copied, name: 'Edited flow' }
  const saved = await h.call({ expectedRevisions: snapshot.revisions, edits: [{ previousId: copied.id, rule: edited }] })
  assert.equal(saved.ok, true, saved.message)
  assert.deepEqual((await h.call()).value.rules.find(rule => rule.id === copied.id), edited, '完整规则事务写盘/读回仍保留 after.action')
  assert.deepEqual(parse(readFileSync(h.file, 'utf8')).rules.find(rule => rule.id === copied.id), edited)
  const beforeInvalid = readFileSync(h.file, 'utf8')
  const beforeSlice = readFileSync(join(h.directory, 'rules', `${copied.id}.yml`), 'utf8')
  const beforeRebuilds = h.rebuilds
  const invalid = structuredClone(edited)
  invalid.then[1].if.anchor.after.action = 'missing'
  const refused = await h.call({ expectedRevisions: saved.value.revisions, edits: [{ previousId: copied.id, rule: invalid }] })
  assert.equal(refused.status, 400)
  assert.equal(readFileSync(h.file, 'utf8'), beforeInvalid, '非法目标拒绝保持完整定义原字节')
  assert.equal(readFileSync(join(h.directory, 'rules', `${copied.id}.yml`), 'utf8'), beforeSlice, '非法目标不发布规则切片')
  assert.equal(h.rebuilds, beforeRebuilds, '非法引用不触发重建')
  assert.match(beforeInvalid, /用户注释/)
  assert.match(beforeInvalid, /未知字段注释/)
  assert.equal(parse(beforeInvalid).unknown, 'keep')

  const blank = harness({ declareRules: false })
  const absent = await blank.call({ createRule: rules[0], expectedRulesAbsent: true })
  assert.equal(absent.ok, true, absent.message)
  assert.equal(absent.value.createdRuleId, 'budget')
  const staleAbsent = await blank.call({ createRule: rules[0], expectedRulesAbsent: true })
  assert.equal(staleAbsent.status, 409)
  assert.equal(staleAbsent.code, 'rules-conflict')

  const missingPrecondition = harness({ declareRules: false })
  const rejected = await missingPrecondition.call({ createRule: rules[0] })
  assert.equal(rejected.status, 409)
  assert.equal(rejected.code, 'rules-conflict')
  assert.deepEqual(parse(readFileSync(missingPrecondition.file, 'utf8')).rules, undefined)
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
  // 真值源：用户看到的那一整句——写盘层说一次「已保存」，下游刷新失败不再自称已保存。
  assert.equal(result.value.publicationError, '规则已保存，但运行刷新失败：Error: REBUILD_FAILED')
  assert.deepEqual(parse(readFileSync(h.file, 'utf8')).rules, rules)
})

test('链接定义及非模块组合不得写入规则', async () => {
  const h = harness()
  const { revisions } = (await h.call()).value
  // 声明面：非模块组合也要先声明 `rules`，读得回来才能测「组合定义不接受规则写入」这条判据本身。
  const composition = `id: ${h.id}\ncomposition: |\n  []\nrules: []\n`
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
  const call = body => h.call({ scope: 'module', ...body }, {}, 'module-variables')
  const initial = await call({})
  assert.equal(initial.ok, true)
  const saved = await call({ variables: { city: 'A', blank: '' }, expectedRevisions: { module: initial.value.revisions.module } })
  assert.equal(saved.ok, true)
  assert.equal(saved.value.persisted, true)
  assert.equal(saved.value.publicationPending, false)
  assert.equal(h.rebuilds, 0, '变量内容更新不重挂 Agent')
  assert.deepEqual(saved.value.module, { city: 'A', blank: '' })
  const global = await call({ scope: 'global', variables: { city: 'GLOBAL', shared: '' }, expectedRevisions: { global: saved.value.revisions.global } })
  assert.equal(global.ok, true, global.message)
  assert.deepEqual(global.value.effective, { city: 'A', blank: '', shared: '' })
  const stale = await call({ variables: { city: 'STALE' }, expectedRevisions: { module: initial.value.revisions.module } })
  assert.equal(stale.status, 409)
  assert.deepEqual(parse(readFileSync(h.file, 'utf8')).variables, { city: 'A', blank: '' })
  const toggled = await call({ enabled: false, expectedRevisions: { settings: initial.value.revisions.settings } })
  assert.equal(toggled.ok, true, toggled.message)
  assert.equal(toggled.value.enabled, false)
  assert.deepEqual(toggled.value.module, { city: 'A', blank: '' })
  assert.equal(toggled.value.publicationPending, true)
  assert.match(toggled.value.publicationError, /已保存/)
  assert.equal(h.rebuilds, 1, '仅模块开关变化需要重新配装')
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
  const call = body => h.call({ scope: 'module', ...body }, {}, 'module-variables')
  const initial = await call({})
  const saved = await call({ variables: { name: 'persisted' }, enabled: false, expectedRevisions: { module: initial.value.revisions.module, settings: initial.value.revisions.settings } })
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
  assert.equal((await locked.call({ scope: 'module', refreshOnly: true }, {}, 'module-variables')).status, 403)
})

test('变量端点拒绝越权/非法范围/过期域；切片发布失败后的值重试不重挂或重放', async () => {
  const h = harness()
  const call = body => h.call({ scope: 'module', ...body }, {}, 'module-variables')
  const initial = await call({})
  const before = readFileSync(h.file, 'utf8')
  for (const body of [
    { scope: 'session' }, { scope: 'global', enabled: false, expectedRevisions: initial.value.revisions },
    { variables: { keep: null }, expectedRevisions: initial.value.revisions },
    { variables: { keep: 'NO' }, expectedModuleId: 'elsewhere', expectedRevisions: initial.value.revisions },
    { variables: { keep: 'NO' }, expectedRevisions: { module: '0'.repeat(64) } },
    { variables: {}, expectedRevisions: initial.value.revisions, path: 'outside' },
  ]) {
    assert.equal((await call(body)).ok, false)
    assert.equal(readFileSync(h.file, 'utf8'), before)
  }
  const locked = harness({ readonly: true })
  assert.equal((await locked.call({ scope: 'global', variables: {}, expectedRevisions: initial.value.revisions }, {}, 'module-variables')).status, 403)
  const originalRename = fs.renameSync
  const rename = mock.method(fs, 'renameSync', (from, to) => {
    if (String(to).endsWith('_settings.yml')) throw new Error('VARIABLE_PUBLICATION_FAILED')
    return originalRename(from, to)
  })
  syncBuiltinESMExports()
  let saved
  try { saved = await call({ variables: { keep: 'SAVED', placeholder: '' }, expectedRevisions: initial.value.revisions }) }
  finally { rename.mock.restore(); syncBuiltinESMExports() }
  assert.equal(saved.ok, true, saved.message)
  assert.equal(saved.value.persisted, true)
  assert.equal(saved.value.publicationPending, true)
  const committed = readFileSync(h.file, 'utf8')
  const refreshed = await call({ refreshOnly: true })
  assert.equal(refreshed.ok, true, refreshed.message)
  assert.deepEqual(refreshed.value.module, { keep: 'SAVED', placeholder: '' })
  assert.equal(refreshed.value.publicationPending, false)
  assert.equal(h.rebuilds, 0)
  assert.equal(readFileSync(h.file, 'utf8'), committed)
})

test('人设 bridge 保留主子三态与定义版本；删除覆盖恢复继承且不改变规则排序', async () => {
  const h = harness()
  // 声明 `persona` 才可用该端点；初始值非空，故下面不再断言「未声明人设读成 null」
  // （那条在新语义下不可能成立，由 T10 的 `module-not-declared` 用例覆盖）。
  writeFileSync(h.file, h.original + 'persona:\n  main:\n    prefix: INITIAL\n')
  const before = await h.call({}, {}, 'persona')
  assert.equal(before.ok, true)
  assert.deepEqual(before.value.persona, { main: { prefix: 'INITIAL' } })
  assert.match(before.value.revision, /^[a-f0-9]{64}$/)
  const persona = { main: { prefix: '', complete: false }, subagent: { suffix: 'CHILD' } }
  const saved = await h.call({ persona, expectedRevision: before.value.revision }, {}, 'persona')
  assert.equal(saved.ok, true, saved.message)
  assert.deepEqual(saved.value.persona, persona)
  assert.deepEqual((await h.call({}, {}, 'persona')).value.persona, persona)
  assert.equal(parse(readFileSync(h.file, 'utf8')).configOrder, undefined)
  const removed = await h.call({ persona: null, expectedRevision: saved.value.revision }, {}, 'persona')
  assert.equal(removed.ok, true, removed.message)
  assert.equal(removed.value.persona, null)
})

test('人设 bridge 保存未选中模块不与其他定义冲突，陈旧版本和非法输入零写入', async t => {
  const h = harness(), peer = harness()
  writeFileSync(h.file, h.original + 'persona:\n  main:\n    prefix: INITIAL\n')
  writeFileSync(peer.file, peer.original + 'persona:\n  main:\n    prefix: PEER\n')
  for (const id of [h.id, peer.id]) setModuleEnabled(moduleRoot, id, true)
  t.after(() => { for (const id of [h.id, peer.id]) setModuleEnabled(moduleRoot, id, false) })
  const before = await h.call({}, {}, 'persona')
  const peerBytes = readFileSync(peer.file)
  const saved = await h.call({ persona: { main: { prefix: 'OWN' } }, expectedRevision: before.value.revision }, {}, 'persona')
  assert.equal(saved.ok, true, saved.message)
  assert.deepEqual(saved.value.persona, { main: { prefix: 'OWN' } })
  assert.deepEqual(readFileSync(peer.file), peerBytes)
  const bytes = readFileSync(h.file, 'utf8')
  for (const body of [
    { persona: { main: { prefix: false } }, expectedRevision: saved.value.revision },
    { persona: null, expectedRevision: before.value.revision },
    { persona: null, expectedRevision: saved.value.revision, path: 'outside' },
    { persona: null, expectedRevision: saved.value.revision, expectedModuleId: peer.id },
  ]) {
    assert.equal((await h.call(body, {}, 'persona')).ok, false)
    assert.equal(readFileSync(h.file, 'utf8'), bytes)
  }
  writeFileSync(h.file, 'id: [broken\n')
  assert.equal((await h.call({}, {}, 'persona')).ok, false)
  assert.equal(readFileSync(h.file, 'utf8'), 'id: [broken\n')
})

test('人设 bridge 发布失败返回已提交值与版本，仅发布重试不重放写入', async () => {
  let fail = true
  const h = harness({ rebuildFails: () => fail })
  writeFileSync(h.file, h.original + 'persona:\n  main:\n    prefix: INITIAL\n')
  const before = await h.call({}, {}, 'persona')
  const persona = { main: { suffix: '', complete: false } }
  const saved = await h.call({ persona, expectedRevision: before.value.revision }, {}, 'persona')
  assert.equal(saved.ok, true, saved.message)
  assert.equal(saved.value.persisted, true)
  assert.equal(saved.value.publicationPending, true)
  assert.deepEqual(saved.value.persona, persona)
  const committed = readFileSync(h.file, 'utf8')
  fail = false
  const refreshed = await h.call({ refreshOnly: true }, {}, 'persona')
  assert.equal(refreshed.ok, true, refreshed.message)
  assert.equal(refreshed.value.publicationPending, false)
  assert.equal(readFileSync(h.file, 'utf8'), committed)
})
