import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import fs, { mkdirSync, readFileSync, writeFileSync, existsSync, symlinkSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { parse } from 'yaml'
import { isolatedHome, fakeReq, fakeRes, makeHostContext, readBridge } from '../fixtures/host-harness.mjs'

const { home, moduleRoot } = isolatedHome('pt-module-merge-')
const { previewModuleMerge, applyModuleMerge, readModuleMergeSources } = await import('../../src/host/module-merge.ts')
const { loadModuleDefinition } = await import('../../src/host/module-slices.ts')
const rule = (id, text) => ({ id, enabled: true, if: { scope: { audience: 'main' } }, then: [{ id: 'inject', kind: 'inject-text', config: { text } }] })
function fixture(id, extra = {}) {
  const dir = join(moduleRoot, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'module.yml'), '# USER COMMENT\n' + JSON.stringify({ id, modules: [], rules: [], ...extra }))
  return dir
}
function apply(targetId, sourceId, action = 'merge') {
  const request = { expectedModuleId: targetId, sourceId, action }
  const preview = previewModuleMerge(moduleRoot, targetId, request)
  return applyModuleMerge(moduleRoot, targetId, { ...request, expectedRevision: preview.revision })
}

test('显式并入预览只读，确认后完整定义、有效资产及来源关系可读，移除保留目标原有内容', () => {
  const target = fixture('merge-target', { rules: [rule('original', 'TARGET')], variables: { original: 'KEEP' }, unknown: { keep: true } })
  const source = fixture('merge-source', { rules: [rule('incoming', 'SOURCE')], variables: { incoming: '' }, configOrder: { incoming: 90 } })
  mkdirSync(join(source, 'assets'))
  writeFileSync(join(source, 'assets', 'empty.txt'), '')
  const before = readFileSync(join(target, 'module.yml'), 'utf8')
  const sourceBefore = readFileSync(join(source, 'module.yml'), 'utf8')
  const preview = previewModuleMerge(moduleRoot, 'merge-target', { expectedModuleId: 'merge-target', sourceId: 'merge-source', action: 'merge' })
  assert.deepEqual(preview.rules, ['incoming'])
  assert.deepEqual(preview.files, ['assets/empty.txt'])
  assert.equal(readFileSync(join(target, 'module.yml'), 'utf8'), before)
  applyModuleMerge(moduleRoot, 'merge-target', { expectedModuleId: 'merge-target', sourceId: 'merge-source', action: 'merge', expectedRevision: preview.revision })
  assert.deepEqual(loadModuleDefinition(target).rules.map(item => item.id), ['original', 'incoming'])
  assert.deepEqual(loadModuleDefinition(target).variables, { original: 'KEEP', incoming: '' })
  assert.equal(readFileSync(join(target, 'assets', 'empty.txt'), 'utf8'), '')
  assert.deepEqual(readModuleMergeSources(moduleRoot, 'merge-target').sources, ['merge-source'])
  assert.equal(apply('merge-target', 'merge-source').changed, false)
  assert.equal(readFileSync(join(source, 'module.yml'), 'utf8'), sourceBefore)
  apply('merge-target', 'merge-source', 'remove')
  assert.deepEqual(loadModuleDefinition(target).rules.map(item => item.id), ['original'])
  assert.deepEqual(loadModuleDefinition(target).variables, { original: 'KEEP' })
  assert.deepEqual(parse(readFileSync(join(target, 'module.yml'), 'utf8')).unknown, { keep: true })
  assert.equal(existsSync(join(target, 'assets', 'empty.txt')), false)
  assert.match(readFileSync(join(target, 'module.yml'), 'utf8'), /USER COMMENT/)
  assert.equal(apply('merge-target', 'merge-source', 'remove').changed, false)
})

test('预览与确认拒绝身份/版本/引用冲突和非法完整候选，不写目标；修改后的贡献不可静默移除', () => {
  const target = fixture('guard-target', { rules: [rule('keep', 'KEEP')] })
  const source = fixture('guard-source', { rules: [rule('new-rule', 'NEW')] })
  const request = { expectedModuleId: 'guard-target', sourceId: 'guard-source', action: 'merge' }
  const before = readFileSync(join(target, 'module.yml'), 'utf8')
  const preview = previewModuleMerge(moduleRoot, 'guard-target', request)
  writeFileSync(join(source, 'module.yml'), JSON.stringify({ id: 'guard-source', modules: [], rules: [rule('new-rule', 'CHANGED')] }))
  assert.throws(() => applyModuleMerge(moduleRoot, 'guard-target', { ...request, expectedRevision: preview.revision }), /过期/)
  assert.equal(readFileSync(join(target, 'module.yml'), 'utf8'), before)
  assert.throws(() => previewModuleMerge(moduleRoot, 'guard-target', { ...request, expectedModuleId: 'other' }), /主语/)
  assert.throws(() => previewModuleMerge(moduleRoot, 'guard-target', { ...request, sourceId: '../escape' }), /非法模块/)
  fixture('collision-source', { rules: [rule('keep', 'COLLISION')] })
  assert.throws(() => previewModuleMerge(moduleRoot, 'guard-target', { ...request, sourceId: 'collision-source' }), /身份冲突/)
  fixture('order-target', { configOrder: { 'new-rule': 70 } })
  assert.throws(() => previewModuleMerge(moduleRoot, 'order-target', { ...request, expectedModuleId: 'order-target' }), /顺序.*冲突/)
  fixture('invalid-candidate', { customTools: [{ id: 'bad' }] })
  assert.throws(() => previewModuleMerge(moduleRoot, 'guard-target', { ...request, sourceId: 'invalid-candidate' }), /customTools|description/)
  const tool = id => ({ id, name: 'same_name', description: 'TOOL', output: { schema: { type: 'object', additionalProperties: true } }, execute: { kind: 'ask-user', question: 'Continue?' } })
  fixture('tool-target', { customTools: [tool('one')] })
  fixture('tool-source', { customTools: [tool('two')] })
  assert.throws(() => previewModuleMerge(moduleRoot, 'tool-target', { expectedModuleId: 'tool-target', sourceId: 'tool-source', action: 'merge' }), /重复|conflict/)
  fixture('variables-target', { variables: { original: 'KEEP' } })
  fixture('variables-source', { variables: { incoming: 'OFF' }, variablesEnabled: false })
  assert.throws(() => previewModuleMerge(moduleRoot, 'variables-target', { expectedModuleId: 'variables-target', sourceId: 'variables-source', action: 'merge' }), /变量.*开关|variablesEnabled/)
  const missing = rule('missing', '')
  missing.then[0].config = { templateFile: './assets/missing.txt' }
  fixture('missing-source', { rules: [missing] })
  assert.throws(() => previewModuleMerge(moduleRoot, 'guard-target', { ...request, sourceId: 'missing-source' }), /缺失|不存在|ENOENT/)
  const linked = fixture('linked-source')
  symlinkSync(source, join(linked, 'linked-assets'), 'junction')
  assert.throws(() => previewModuleMerge(moduleRoot, 'guard-target', { ...request, sourceId: 'linked-source' }), /链接/)
  const unreadable = fixture('unreadable-source')
  mkdirSync(join(unreadable, 'assets'))
  const denied = join(unreadable, 'assets', 'denied.txt')
  writeFileSync(denied, 'CANNOT READ')
  const originalRead = fs.readFileSync
  mock.method(fs, 'readFileSync', (path, ...args) => {
    if (String(path) === denied) throw Object.assign(new Error('EACCES SOURCE ASSET'), { code: 'EACCES' })
    return originalRead(path, ...args)
  })
  syncBuiltinESMExports()
  try { assert.throws(() => previewModuleMerge(moduleRoot, 'guard-target', { ...request, sourceId: 'unreadable-source' }), /EACCES/) }
  finally { mock.restoreAll(); syncBuiltinESMExports() }
  const targetPreview = previewModuleMerge(moduleRoot, 'guard-target', request)
  writeFileSync(join(target, 'keep.txt'), 'USER FILE')
  assert.throws(() => applyModuleMerge(moduleRoot, 'guard-target', { ...request, expectedRevision: targetPreview.revision }), /过期/)
  assert.equal(readFileSync(join(target, 'module.yml'), 'utf8'), before)
  const stagePreview = previewModuleMerge(moduleRoot, 'guard-target', request)
  const originalWrite = fs.writeFileSync
  mock.method(fs, 'writeFileSync', (path, ...args) => {
    if (String(path).includes('.install-') && String(path).endsWith('module.yml')) throw new Error('CANDIDATE DISK FAILURE')
    return originalWrite(path, ...args)
  })
  syncBuiltinESMExports()
  try { assert.throws(() => applyModuleMerge(moduleRoot, 'guard-target', { ...request, expectedRevision: stagePreview.revision }), /CANDIDATE DISK FAILURE/) }
  finally { mock.restoreAll(); syncBuiltinESMExports() }
  assert.equal(readFileSync(join(target, 'module.yml'), 'utf8'), before)
  apply('guard-target', 'guard-source')
  const changed = parse(readFileSync(join(target, 'module.yml'), 'utf8'))
  changed.rules.find(item => item.id === 'new-rule').then[0].config.text = 'USER EDIT'
  writeFileSync(join(target, 'module.yml'), JSON.stringify(changed))
  assert.throws(() => apply('guard-target', 'guard-source', 'remove'), /已被修改/)
  assert.equal(loadModuleDefinition(target).rules.find(item => item.id === 'new-rule').then[0].config.text, 'USER EDIT')
  fixture('asset-target')
  const assetSource = fixture('asset-source')
  mkdirSync(join(assetSource, 'assets'))
  writeFileSync(join(assetSource, 'assets', 'owned.txt'), 'SOURCE ASSET')
  apply('asset-target', 'asset-source')
  writeFileSync(join(moduleRoot, 'asset-target', 'assets', 'owned.txt'), 'USER ASSET EDIT')
  assert.throws(() => apply('asset-target', 'asset-source', 'remove'), /资产已修改/)
  assert.equal(readFileSync(join(moduleRoot, 'asset-target', 'assets', 'owned.txt'), 'utf8'), 'USER ASSET EDIT')
})

test('多个来源共享资产和变量，先移除所有者仍保留另一来源；导出导入后仍可撤回', async () => {
  const { moduleImportPreview, installModulePackage, exportModulePackage, expandModuleSource } = await import('../../src/host/module-package.ts')
  const target = fixture('shared-target')
  for (const [id, ruleId] of [['first-source', 'first'], ['second-source', 'second']]) {
    const dir = fixture(id, { rules: [rule(ruleId, 'SOURCE')], variables: { shared: 'SAME' } })
    mkdirSync(join(dir, 'assets'))
    writeFileSync(join(dir, 'assets', 'common.txt'), 'SAME')
    apply('shared-target', id)
  }
  apply('shared-target', 'first-source', 'remove')
  assert.deepEqual(loadModuleDefinition(target).rules.map(item => item.id), ['second'])
  assert.deepEqual(loadModuleDefinition(target).variables, { shared: 'SAME' })
  assert.equal(readFileSync(join(target, 'assets', 'common.txt'), 'utf8'), 'SAME')
  const exported = await exportModulePackage(moduleRoot, { id: 'shared-target', mode: 'zip' })
  const files = await expandModuleSource([{ path: 'module.zip', content: exported.content, encoding: 'base64' }])
  const preview = moduleImportPreview(moduleRoot, files, { targetId: 'roundtrip-target' })
  await installModulePackage(moduleRoot, files, { targetId: 'roundtrip-target', expectedSourceDigest: preview.sourceDigest, expectedPreviewRevision: preview.previewRevision })
  assert.deepEqual(readModuleMergeSources(moduleRoot, 'roundtrip-target').sources, ['second-source'])
  apply('roundtrip-target', 'second-source', 'remove')
  assert.deepEqual(loadModuleDefinition(join(moduleRoot, 'roundtrip-target')).rules, [])
  assert.equal(existsSync(join(moduleRoot, 'roundtrip-target', 'assets', 'common.txt')), false)
})

test('公共bridge核对主语与预览版本；保存和发布分离，显式重试不重放并入', async () => {
  const { registerSettingsBridge } = await import('../../src/runtime/settings-bridge.ts')
  const target = fixture('bridge-target')
  fixture('bridge-source', { rules: [rule('bridge-rule', 'BRIDGE')] })
  const readonly = join(home, 'system', 'readonly-target')
  mkdirSync(readonly, { recursive: true })
  writeFileSync(join(readonly, 'module.yml'), 'id: readonly-target\nmodules: []\nrules: []\n')
  let fail = true
  const disposers = []
  const warnings = []
  const { ctx, handlers } = makeHostContext({ effect: fn => { const dispose = fn(); if (dispose) disposers.push(dispose) } })
  registerSettingsBridge(ctx, { ns: 'prompt-tool', models: () => ({}), moduleDirectory: id => id === 'bridge-target' ? target : id === 'readonly-target' ? readonly : '', overridesChanged: async () => { if (fail) throw new Error('PUBLICATION FAILED') }, warn: message => warnings.push(message) })
  const handler = handlers.get('/api/prompt-tool/settings/module-merge')
  assert.equal(typeof handler, 'function')
  const call = async (body, headers = { 'x-module-id': 'bridge-target' }) => {
    const res = fakeRes()
    await handler(fakeReq({ body, headers }), res)
    return readBridge(res)
  }
  try {
    assert.equal((await call({}, {})).status, 400)
    assert.equal((await call({ expectedModuleId: 'readonly-target', action: 'merge', sourceId: 'bridge-source', preview: true }, { 'x-module-id': 'readonly-target' })).status, 403)
    assert.equal((await call({ action: 'merge', sourceId: 'bridge-source', expectedModuleId: 'wrong', preview: true })).code, 'module-subject-conflict')
    const request = { action: 'merge', sourceId: 'bridge-source', expectedModuleId: 'bridge-target' }
    const preview = await call({ ...request, preview: true })
    assert.equal(preview.ok, true, preview.message)
    assert.equal((await call(request)).status, 409)
    const originalRemove = fs.rmSync
    mock.method(fs, 'rmSync', (path, options) => {
      if (String(path).includes('.bridge-target.install-') && options?.recursive === true) throw new Error('STAGE CLEANUP FAILURE')
      return originalRemove(path, options)
    })
    syncBuiltinESMExports()
    let saved
    try { saved = await call({ ...request, expectedRevision: preview.value.revision }) }
    finally { mock.restoreAll(); syncBuiltinESMExports() }
    assert.equal(saved.ok, true, saved.message)
    assert.equal(saved.value.persisted, true)
    assert.equal(saved.value.publicationPending, true)
    const cleanupWarning = warnings.filter(message => message.includes('暂存目录清理失败'))
    assert.equal(cleanupWarning.length, 1, '换入后清理失败应告警，不能冒充未保存或静默丢失恢复路径')
    assert.equal(existsSync(cleanupWarning[0].split('：').at(-1)), true)
    const before = readFileSync(join(target, 'module.yml'), 'utf8')
    const failed = await call({ expectedModuleId: 'bridge-target', refreshOnly: true })
    assert.equal(failed.value.publicationPending, true)
    assert.match(failed.value.publicationError, /PUBLICATION FAILED/)
    fail = false
    const retry = await call({ expectedModuleId: 'bridge-target', refreshOnly: true })
    assert.equal(retry.ok, true, retry.message)
    assert.equal(retry.value.publicationPending, false)
    assert.equal(readFileSync(join(target, 'module.yml'), 'utf8'), before)
    assert.equal(loadModuleDefinition(target).rules.length, 1)
  } finally { for (const dispose of disposers) dispose() }
})

test('并入后真实装配按主子受众执行模板，未启用来源和规则不被打开，移除仅释放来源贡献', async t => {
  const { Context } = await import('@deepseek-ai/cordis')
  const { default: SystemPrompt } = await import('@deepseek-ai/dsh-system-prompt')
  const { default: Tools } = await import('@deepseek-ai/dsh-tools')
  const Native = await import('@deepseek-ai/dsh-tool-executor-native')
  const { createScope, scopeTarget } = await import('@deepseek-ai/dsh-scope')
  const { createAgentAssembly } = await import('../../src/runtime/agent-assembly.ts')
  const { installPreStepCoordinator } = await import('../../src/runtime/pre-step-coordinator.ts')
  const { enabledModuleIds } = await import('../../src/host/config-store.ts')
  fixture('runtime-target', { modules: ['rule-engine'], rules: [rule('target-rule', 'TARGET')] })
  const incoming = rule('source-rule', '')
  incoming.then[0].config = { templateFile: './assets/body.txt' }
  const child = { ...rule('child-rule', 'CHILD'), if: { scope: { audience: 'subagent' } } }
  const disabled = { ...rule('disabled-rule', 'MUST NOT RUN'), enabled: false }
  const source = fixture('runtime-source', { modules: ['rule-engine'], rules: [incoming, child, disabled], variables: { name: 'MERGED' } })
  mkdirSync(join(source, 'assets'))
  writeFileSync(join(source, 'assets', 'body.txt'), 'SOURCE {{name}}')
  const root = new Context()
  await root.plugin(SystemPrompt); await root.plugin(Tools); await root.plugin(Native)
  root.provide('llm', {})
  const agents = []
  root.provide('agents', { list: () => agents })
  installPreStepCoordinator(root)
  const runtime = createAgentAssembly(root, { moduleRoot, enabledModules: () => ['runtime-target'] })
  t.after(async () => { await runtime.dispose(); await root.fiber.dispose() })
  const makeAgent = async (id, depth) => {
    const agent = { id, options: {}, session: { id, header: { delegationDepth: depth }, snapshotEvents: () => [] } }
    agent.ctx = createScope(root, agent).ctx
    agents.push(agent)
    await root.serial(scopeTarget(agent, agent), 'agent/created', { agent, source: 'startup' })
    return agent
  }
  const main = await makeAgent('merge-main', 0), peer = await makeAgent('merge-peer', 0), subagent = await makeAgent('merge-child', 1)
  const injected = async agent => (await root.waterfall(scopeTarget(agent, agent), 'agent/pre-step', { agent, signal: new AbortController().signal }, async () => ({ kind: 'continue', messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'USER' }] }] }))).messages.flatMap(message => message.content.map(block => block.text))
  assert.deepEqual(await injected(main), ['USER', 'TARGET'])
  const enabledBefore = enabledModuleIds(moduleRoot)
  apply('runtime-target', 'runtime-source')
  await runtime.refresh('runtime-target')
  assert.deepEqual(await injected(main), ['USER', 'TARGET', 'SOURCE MERGED'])
  assert.deepEqual(await injected(peer), ['USER', 'TARGET', 'SOURCE MERGED'])
  assert.deepEqual(await injected(subagent), ['USER', 'CHILD'])
  assert.deepEqual(enabledModuleIds(moduleRoot), enabledBefore)
  apply('runtime-target', 'runtime-source', 'remove')
  await runtime.refresh('runtime-target')
  assert.deepEqual(await injected(main), ['USER', 'TARGET'])
  assert.deepEqual(await injected(peer), ['USER', 'TARGET'])
  assert.deepEqual(await injected(subagent), ['USER'])
})
