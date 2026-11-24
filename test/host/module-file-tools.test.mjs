import SessionProjections from '@deepseek-ai/dsh-session-projection'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tempDir } from '../fixtures/host-harness.mjs'
import { registerModuleFileTools } from '../../src/runtime/module-file-tools.ts'
import { resolveModuleToolTarget } from '../../src/host/module-tool-target.ts'

test('用户升级：完整预览确认、目标变化拒绝、私有资产保留与用户正文冲突', async t => {
  const { Context } = await import('@deepseek-ai/cordis')
  const commands = await import('@deepseek-ai/dsh-commands')
  const storage = await import('@deepseek-ai/dsh-storage')
  const json = await import('@deepseek-ai/dsh-storage-json')
  const domain = await import('@deepseek-ai/dsh-storage-domain')
  const { openSoulKnowledge } = await import('../../src/host/soul-knowledge.ts')
  const { appendSoulLedger } = await import('../../src/host/soul-ledger.ts')
  const { registerTuiCommand } = await import('../../src/runtime/tui.ts')
  const { packageModulesDir, userModulesDir } = await import('../../src/host/module-dirs.ts')
  const { exportModuleDefinitionText, materializeModuleDefinition } = await import('../../src/host/module-slices.ts')
  const { parse, stringify } = await import('yaml')
  const home = tempDir('pt-upgrade-'), original = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(() => { if (original === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = original })
  // 对照当前分发资源构造用户副本；不固定内置正文、模块数量或默认行为。
  const seed = readdirSync(packageModulesDir()).map(id => join(packageModulesDir(), id)).find(dir => {
    const value = parse(readFileSync(join(dir, 'module.yml'), 'utf8'))
    return value.modules?.includes('soul-maintenance')
  })
  assert.ok(seed)
  const id = 'upgrade-fixture', dir = join(userModulesDir(), id)
  mkdirSync(userModulesDir(), { recursive: true }); cpSync(seed, dir, { recursive: true })
  const definition = parse(readFileSync(join(dir, 'module.yml'), 'utf8'))
  definition.id = id
  delete definition.moduleConfigs['soul-maintenance'].assistedInputTarget
  writeFileSync(join(dir, 'module.yml'), stringify(definition))
  materializeModuleDefinition(dir)
  mkdirSync(join(dir, 'data'), { recursive: true })
  writeFileSync(join(dir, 'data', 'SELF.src.md'), 'USER SKELETON')
  writeFileSync(join(dir, 'data', 'private.jsonl'), 'PRIVATE LEDGER')
  writeFileSync(join(dir, 'unknown.bin'), 'UNKNOWN')
  const ctx = new Context(); let refreshes = 0
  await ctx.plugin(storage.default); await ctx.plugin(json, { root: join(home, 'storage') }); await ctx.plugin(domain, { backend: 'json' })
  const events = []
  let bindingTable
  const facility = { open: async spec => { const opened = await ctx.storageDomain.open(spec); if (spec.name === 'prompt_tool_soul_knowledge') bindingTable = opened.table('bindings'); return opened } }
  let owner = await openSoulKnowledge(facility, async sessionId => ({ id: sessionId, snapshotEvents: () => events }))
  await ctx.plugin(commands.default); ctx.provide('settings', {})
  await ctx.plugin({ name: 'upgrade-command-test', inject: ['commands'], apply(scope) {
    registerTuiCommand(scope, 'test', () => ({}), () => ({}), async () => ({}), target => target === id ? dir : '', undefined, async () => { refreshes++ }, () => owner)
  } })
  t.after(async () => { await owner.dispose(); await ctx.fiber.dispose() })
  await new Promise(resolve => setImmediate(resolve))
  const agent = { id: 'user', session: { id: 'upgrade-user', header: {}, snapshotEvents: () => [], append: () => ({}) } }
  const run = async request => (await ctx.commands.execute(agent, '/prompt-tool upgrade ' + JSON.stringify({ moduleId: id, ...request }), [], new AbortController().signal)).result
  const signal = new AbortController().signal, project = join(home, 'project'), root = join(home, 'knowledge')
  mkdirSync(project); mkdirSync(root)
  writeFileSync(join(root, 'old.md'), 'AUTHORIZED SOURCE')
  const binding = { moduleId: id, action: 'preview', root, read: ['old.md'], write: ['general', 'projects'] }
  await owner.confirm(dir, { ...binding, action: 'confirm', expectedRevision: (await owner.preview(dir, binding, signal)).revision }, signal)
  const manage = request => owner.manage(dir, { moduleId: id, ...request, expectedRevision: owner.status(dir).binding.revision }, agent.session.id, signal)
  await manage({ action: 'project', projectDirectory: project }); await manage({ action: 'enable' })
  const selected = { moduleId: id, action: 'source-preview', path: 'old.md', scope: 'project' }
  await owner.manage(dir, { ...selected, action: 'source-confirm', expectedRevision: (await owner.manage(dir, selected, agent.session.id, signal)).expectedRevision }, agent.session.id, signal)
  events.push({ seq: 0, type: 'user/message', time: Date.now() + 1, data: { id: 'human-1', source: { kind: 'user' }, content: [{ type: 'text', text: '今后长期使用中文回答' }] } })
  await owner.observe(dir, agent.session.id, 0)
  const record = await owner.record(dir, agent.session.id, 'record-1', origin => appendSoulLedger(dir, { type: 'fact', text: '长期使用中文回答' }, { sessionId: agent.session.id, signal, origin }), signal)
  assert.equal((await owner.learn(dir, agent.session.id, { text: '长期使用中文回答', layer: 'expression', basis: 'explicit-long-term', ref: record.reference.entryId, expectedRevision: owner.status(dir).learningRevision }, signal)).state, 'adopted')
  const before = owner.status(dir).binding
  const budgetKey = JSON.stringify([dir, before.moduleIdentity, agent.session.id])
  const limits = { inputTarget: 10, outputTokens: 10, timeoutMs: 10, sessionTokens: 100, sessionMs: 100, backlogTurns: 2 }
  assert.equal((await owner.assisted.reserve(budgetKey, 'human-1', 10, limits)).state, 'reserved')
  const preview = JSON.parse((await run({ action: 'preview' })).text)
  assert.equal(preview.status, 'ready')
  assert.ok(preview.changes.some(change => change.id.endsWith('.assistedInputTarget')))
  assert.equal(refreshes, 0)
  const credentials = { expectedRevision: preview.expectedRevision, expectedSourceDigest: preview.expectedSourceDigest, expectedPreviewRevision: preview.expectedPreviewRevision }
  writeFileSync(join(dir, 'unknown.bin'), 'CHANGED')
  assert.equal((await run({ action: 'confirm', ...credentials })).kind, 'error')
  const changed = JSON.parse((await run({ action: 'preview' })).text)
  await manage({ action: 'disable' })
  assert.equal((await run({ action: 'confirm', expectedRevision: changed.expectedRevision, expectedSourceDigest: changed.expectedSourceDigest, expectedPreviewRevision: changed.expectedPreviewRevision })).kind, 'error', '预览后关闭不能沿旧授权交接')
  await manage({ action: 'enable' })
  const preserved = owner.status(dir).binding, oldDefinition = exportModuleDefinitionText(dir)
  const fresh = JSON.parse((await run({ action: 'preview' })).text)
  const failure = t.mock.method(bindingTable, 'put', async () => { throw new Error('STORAGE WRITE FAILED') })
  assert.equal((await run({ action: 'confirm', expectedRevision: fresh.expectedRevision, expectedSourceDigest: fresh.expectedSourceDigest, expectedPreviewRevision: fresh.expectedPreviewRevision })).kind, 'error')
  failure.mock.restore()
  assert.deepEqual(owner.status(dir).binding, preserved, '持久失败恢复原目录身份和完整绑定')
  assert.equal(exportModuleDefinitionText(dir), oldDefinition)
  assert.equal((await run({ action: 'confirm', expectedRevision: fresh.expectedRevision, expectedSourceDigest: fresh.expectedSourceDigest, expectedPreviewRevision: fresh.expectedPreviewRevision })).kind, 'success')
  assert.equal(refreshes, 1)
  assert.equal(owner.status(dir).state, 'bound', '用户确认升级必须保留知识库绑定')
  const after = owner.status(dir).binding
  for (const key of ['root', 'identity', 'read', 'write', 'generation', 'sources', 'projects', 'histories', 'continuity', 'participants', 'records', 'publications', 'learning']) assert.deepEqual(after[key], preserved[key], key)
  assert.equal((await owner.withEvidence([{ directory: dir, sessionId: agent.session.id }], undefined, () => owner.learning(dir, agent.session.id)))[0].state, 'adopted')
  assert.equal((await owner.withEvidence([{ directory: dir, sessionId: agent.session.id }], undefined, () => owner.sources(dir, agent.session.id))).documents[0].content, 'AUTHORIZED SOURCE')
  const upgradedBudgetKey = JSON.stringify([dir, after.assistedIdentity ?? after.moduleIdentity, agent.session.id])
  assert.equal(upgradedBudgetKey, budgetKey)
  assert.equal((await owner.assisted.reserve(upgradedBudgetKey, 'human-1', 10, limits)).state, 'deferred', '升级不能重获已消费回合额度')
  await owner.dispose()
  owner = await openSoulKnowledge(ctx.storageDomain, async sessionId => ({ id: sessionId, snapshotEvents: () => events }))
  assert.equal(owner.status(dir).state, 'bound', '重新打开持久域仍保持绑定')
  assert.equal((await owner.assisted.reserve(upgradedBudgetKey, 'human-1', 10, limits)).state, 'deferred')
  assert.equal(readFileSync(join(dir, 'data', 'SELF.src.md'), 'utf8'), 'USER SKELETON')
  assert.equal(readFileSync(join(dir, 'data', 'private.jsonl'), 'utf8'), 'PRIVATE LEDGER')
  assert.equal(readFileSync(join(dir, 'unknown.bin'), 'utf8'), 'CHANGED')
  writeFileSync(join(dir, 'data', 'old.md'), 'INTERNAL SOURCE')
  const internal = { moduleId: id, action: 'preview', read: ['old.md'], write: ['general', 'projects'] }
  await owner.confirm(dir, { ...internal, action: 'confirm', expectedRevision: (await owner.preview(dir, internal, signal)).revision }, signal)
  await manage({ action: 'project', projectDirectory: project }); await manage({ action: 'enable' })
  await owner.manage(dir, { ...selected, action: 'source-confirm', expectedRevision: (await owner.manage(dir, selected, agent.session.id, signal)).expectedRevision }, agent.session.id, signal)
  events.push({ seq: 1, type: 'user/message', time: Date.now() + 1, data: { id: 'human-2', source: { kind: 'user' }, content: [{ type: 'text', text: '今后长期先给结论' }] } })
  await owner.observe(dir, agent.session.id, 1)
  const internalRecord = await owner.record(dir, agent.session.id, 'record-2', origin => appendSoulLedger(dir, { type: 'fact', text: '先给结论' }, { sessionId: agent.session.id, signal, origin }), signal)
  assert.equal((await owner.learn(dir, agent.session.id, { text: '先给结论', layer: 'expression', basis: 'explicit-long-term', ref: internalRecord.reference.entryId, expectedRevision: owner.status(dir).learningRevision }, signal)).state, 'adopted')
  const internalBefore = owner.status(dir).binding
  const internalPreview = JSON.parse((await run({ action: 'preview' })).text)
  assert.equal((await run({ action: 'confirm', expectedRevision: internalPreview.expectedRevision, expectedSourceDigest: internalPreview.expectedSourceDigest, expectedPreviewRevision: internalPreview.expectedPreviewRevision })).kind, 'success')
  const internalAfter = owner.status(dir).binding
  assert.notEqual(internalAfter.identity, internalBefore.identity, '模块内根身份随受控目录交换')
  for (const key of ['root', 'read', 'write', 'generation', 'sources', 'projects', 'histories', 'continuity', 'participants', 'records', 'learning']) assert.deepEqual(internalAfter[key], internalBefore[key], key)
  assert.equal((await owner.withEvidence([{ directory: dir, sessionId: agent.session.id }], undefined, () => owner.sources(dir, agent.session.id))).documents[0].content, 'INTERNAL SOURCE')
  await owner.dispose()
  owner = await openSoulKnowledge(ctx.storageDomain, async sessionId => ({ id: sessionId, snapshotEvents: () => events }))
  assert.equal(owner.status(dir).state, 'bound')
  assert.equal((await owner.withEvidence([{ directory: dir, sessionId: agent.session.id }], undefined, () => owner.learning(dir, agent.session.id)))[0].state, 'adopted')
  writeFileSync(join(dir, 'assets', 'tools.md'), 'USER CUSTOM TOOLS')
  const conflict = JSON.parse((await run({ action: 'preview' })).text)
  assert.equal(conflict.status, 'conflict')
  assert.equal(readFileSync(join(dir, 'assets', 'tools.md'), 'utf8'), 'USER CUSTOM TOOLS')
  const learningId = (await owner.withEvidence([{ directory: dir, sessionId: agent.session.id }], undefined, () => owner.learning(dir, agent.session.id)))[0].id
  renameSync(project, project + '-missing')
  await assert.rejects(owner.manage(dir, { moduleId: id, action: 'learning-forget', sourceId: learningId, expectedRevision: owner.status(dir).binding.revision }, 'unrelated-session', signal), /无权/, '减权不能跨会话项目归属')
  const forgotten = await Promise.allSettled([manage({ action: 'learning-forget', sourceId: learningId })])
  const withdrawn = await Promise.allSettled([manage({ action: 'learning-withdraw', sourceId: learningId })])
  const disabled = await Promise.allSettled([manage({ action: 'disable' })])
  assert.deepEqual([...forgotten, ...withdrawn, ...disabled].map(row => row.status), ['fulfilled', 'fulfilled', 'fulfilled'], '项目丢失仍允许遗忘、撤回和停用')
  assert.equal(owner.status(dir).binding.continuity.enabled, false)
  renameSync(dir, dir + '-original'); cpSync(dir + '-original', dir, { recursive: true })
  assert.equal(owner.status(dir).state, 'unavailable', '普通目录替换不能沿用受控升级的身份交接')
})

test('知识库接入：用户预览确认、部分授权和旧预览拒绝，不改旧资料', async t => {
  const { Context } = await import('@deepseek-ai/cordis')
  const storage = await import('@deepseek-ai/dsh-storage')
  const json = await import('@deepseek-ai/dsh-storage-json')
  const domain = await import('@deepseek-ai/dsh-storage-domain')
  const commands = await import('@deepseek-ai/dsh-commands')
  const { openSoulKnowledge } = await import('../../src/host/soul-knowledge.ts')
  const { materializeModuleDefinition } = await import('../../src/host/module-slices.ts')
  const { registerTuiCommand } = await import('../../src/runtime/tui.ts')
  const { createModuleRetrievalProvider } = await import('../../src/runtime/module-retrieval-tools.ts')
  const { createScope } = await import('@deepseek-ai/dsh-scope')
  const ToolRuntime = await import('@deepseek-ai/dsh-tools')
  const SystemPrompt = await import('@deepseek-ai/dsh-system-prompt')
  const NativeExecutor = await import('@deepseek-ai/dsh-tool-executor-native')
  const f = fixture(t), ctx = new Context()
  materializeModuleDefinition(f.dir)
  await ctx.plugin(storage.default)
  await ctx.plugin(json, { root: join(f.root, 'storage') })
  await ctx.plugin(domain, { backend: 'json' })
  const events = [{ seq: 1, type: 'user/message', data: { text: 'HISTORY ONE' } }, { seq: 2, type: 'user/message', data: { text: 'HISTORY TWO' } }]
  let onLoad = async () => {}
  const owner = await openSoulKnowledge(ctx.storageDomain, async id => { await onLoad(id); return { id, snapshotEvents: () => events } })
  t.after(async () => { await owner.dispose(); await ctx.fiber.dispose() })
  await ctx.plugin(commands.default)
  ctx.provide('settings', {})
  await ctx.plugin({ name: 'knowledge-command-test', inject: ['commands'], apply(scope) {
    registerTuiCommand(scope, 'test', () => ({}), () => ({}), async () => ({}), id => id === 'alice' ? f.dir : '', undefined, undefined, () => owner)
  } })
  await new Promise(resolve => setImmediate(resolve))
  await ctx.plugin(SessionProjections)
  await ctx.plugin(SystemPrompt.default)
  await ctx.plugin(ToolRuntime.default)
  await ctx.plugin(NativeExecutor)
  const agent = { id: 'user', session: { id: 'session-a', header: {}, snapshotEvents: () => [], append: () => ({}) } }
  agent.ctx = createScope(ctx, agent).ctx
  assert.ok(ctx.commands.find(agent, 'prompt-tool'), '用户命令必须正式注册')
  const upgrade = (await ctx.commands.execute(agent, '/prompt-tool upgrade ' + JSON.stringify({ moduleId: 'missing', action: 'preview' }), [], new AbortController().signal)).result
  assert.match(upgrade.text, /升级.*模块|模块.*升级/, '升级命令必须走用户专用入口并校验目标')
  const run = async request => (await ctx.commands.execute(agent, '/prompt-tool knowledge ' + JSON.stringify(request), [], new AbortController().signal)).result
  const beta = join(f.root, 'modules', 'beta')
  mkdirSync(beta)
  writeFileSync(join(beta, 'module.yml'), 'id: beta\nmodules: []\nrules: []\n')
  // 在大小写不敏感的文件系统上，用同一目录的另一种拼写确认预览。
  const alias = join(f.root, 'modules', 'BETA')
  const root = join(existsSync(alias) ? alias : beta, 'data')
  mkdirSync(root)
  writeFileSync(join(root, 'old.md'), 'PRIVATE')
  writeFileSync(join(root, 'SELF.src.md'), 'MY SELF')
  writeFileSync(join(root, '02-soul.jsonl'), 'OLD LEDGER')
  const request = { moduleId: 'alice', action: 'preview', root, read: ['old.md'], write: ['general', 'projects'] }
  assert.equal(owner.status(f.dir).state, 'unbound')
  const preview = JSON.parse((await run(request)).text)
  assert.equal(preview.state, 'preview')
  assert.equal(owner.status(f.dir).state, 'unbound')
  writeFileSync(join(root, 'old.md'), 'CHANGED')
  assert.equal((await run({ ...request, action: 'confirm', expectedRevision: preview.revision })).kind, 'error')
  assert.equal(owner.status(f.dir).state, 'unbound')
  assert.deepEqual(readdirSync(root).sort(), ['02-soul.jsonl', 'SELF.src.md', 'old.md'])
  const fresh = JSON.parse((await run(request)).text)
  assert.equal((await run({ ...request, action: 'confirm', expectedRevision: fresh.revision })).kind, 'success')
  assert.equal(owner.status(f.dir).state, 'bound')
  assert.equal((await owner.withEvidence([{ directory: f.dir, sessionId: 'session-a' }], undefined, () => owner.sources(f.dir, 'session-a'))).state, 'pending-classification')
  const host = { target: (exec, id) => resolveModuleToolTarget(exec, join(f.root, 'modules'), () => ['alice', 'beta'], id) }
  registerModuleFileTools(agent.ctx, host, () => owner)
  const { registerSoulLedgerTools } = await import('../../src/runtime/soul-ledger-tools.ts')
  registerSoulLedgerTools(agent.ctx, host, () => owner)
  const retrieval = createModuleRetrievalProvider(host, async id => { await onLoad(id); return { id, snapshotEvents: () => events } }, () => owner)
  const offRetrieval = retrieval.mount(agent.ctx, { paths: [], sessions: ['old'] }, { agent, sourceModuleId: 'alice', sourceModuleDir: f.dir })
  t.after(offRetrieval)
  await new Promise(resolve => setImmediate(resolve))
  let calls = 0
  const call = async (name, args) => (await ctx.tools.execute({ calls: [{ type: 'tool-call', id: 'knowledge-' + ++calls, name, arguments: JSON.stringify({ moduleId: 'alice', ...args }) }], agent, signal: new AbortController().signal })).results[0].result
  const ok = async (name, args) => { const result = await call(name, args); assert.equal(result.isError, false, JSON.stringify(result)); return result.value }
  mkdirSync(join(f.dir, 'data', '.soul'), { recursive: true })
  writeFileSync(join(f.dir, 'data', '02-soul.jsonl'), 'EXTERNAL ROOT OLD PRIVATE')
  writeFileSync(join(f.dir, 'data', '.soul', 'SELF.md'), 'OLD DERIVED PRIVATE')
  assert.equal((await call('module_file_read', { path: 'data/02-soul.jsonl' })).isError, true, '外部根不能使原账本退回普通文件')
  assert.equal((await call('module_file_read', { path: 'data/.soul/SELF.md' })).isError, true, '旧SELF快照同受控')
  const { registerSoulStateTools } = await import('../../src/runtime/soul-state-tools.ts')
  let upgradeRead = false
  registerSoulStateTools(agent.ctx, host, { status: () => ({}), check: () => { upgradeRead = true; return { upgrade: { files: [{ content: 'PRIVATE UPGRADE' }] } } } }, () => undefined, () => owner)
  assert.equal((await call('soul_state', { action: 'check', includeUpgrade: true })).isError, true, '模型升级预览不能泄露已绑定资料正文')
  assert.equal(upgradeRead, false, '必须在生成含正文升级候选之前拒绝')
  assert.equal((await call('soul_ledger', { action: 'list' })).isError, true, '绑定后旧账本未归类不能绕过检索')
  assert.equal((await call('module_file_read', { moduleId: 'beta', path: 'data/old.md' })).isError, true, '未绑定模块也不能绕过其他模块登记的根')
  assert.equal((await call('module_file_append', { moduleId: 'beta', path: 'data/old.md', content: 'LEAK' })).isError, true)
  assert.deepEqual((await ok('module_search', { query: 'CHANGED' })).hits, [])
  const projectDirectory = join(f.root, 'project')
  mkdirSync(projectDirectory)
  const currentRevision = () => owner.status(f.dir).binding.revision
  assert.equal((await run({ moduleId: 'alice', action: 'project', projectDirectory, expectedRevision: currentRevision() })).kind, 'success')
  assert.equal((await run({ moduleId: 'alice', action: 'enable', expectedRevision: currentRevision() })).kind, 'success')
  assert.equal(owner.status(f.dir).binding.continuity.enabled, true)
  const assertProjectControl = owner.control(f.dir)
  renameSync(projectDirectory, projectDirectory + '-original')
  mkdirSync(projectDirectory)
  assert.throws(() => owner.sources(f.dir, 'session-a'), /身份|准备/)
  assert.throws(assertProjectControl, /变化/, '项目身份替换立即使控制凭据失效')
  renameSync(projectDirectory, projectDirectory + '-replacement')
  renameSync(projectDirectory + '-original', projectDirectory)
  await owner.withEvidence([{ directory: f.dir, sessionId: 'session-a' }], undefined, () => {})
  assert.throws(assertProjectControl, /变化/, '恢复原目录也不能恢复旧控制凭据')
  const unrelatedProject = join(f.root, 'unrelated-project')
  mkdirSync(unrelatedProject)
  await owner.manage(f.dir, { moduleId: 'alice', action: 'project', projectDirectory: unrelatedProject, expectedRevision: currentRevision() }, 'unrelated-session', new AbortController().signal)
  renameSync(unrelatedProject, unrelatedProject + '-moved')
  await owner.withEvidence([{ directory: f.dir, sessionId: 'session-a' }], undefined, () => {})
  owner.control(f.dir, 'session-a')()
  assert.equal((await owner.withEvidence([{ directory: f.dir, sessionId: 'session-a' }], undefined, () => owner.sources(f.dir, 'session-a'))).state, 'ready', '其他会话项目丢失不阻止当前合法项目')
  assert.equal((await call('module_file_read', { path: 'memory.md' })).isError, false, '文件工具按真实会话准备，不受其他项目丢失影响')
  renameSync(unrelatedProject + '-moved', unrelatedProject)
  const select = async selection => {
    const request = { moduleId: 'alice', action: 'source-preview', scope: 'project', ...selection }
    const preview = JSON.parse((await run(request)).text)
    assert.equal(preview.state, 'source-preview')
    assert.equal((await run({ ...request, action: 'source-confirm', expectedRevision: preview.expectedRevision })).kind, 'success')
    return preview.source.id
  }
  const selected = await select({ path: 'old.md' })
  const hit = (await ok('module_search', { query: 'CHANGED' })).hits[0]
  assert.equal(hit.reference.kind, 'knowledge')
  assert.equal((await ok('module_open', { reference: hit.reference })).content, 'CHANGED')
  assert.deepEqual((await owner.withEvidence([{ directory: f.dir, sessionId: 'other-session' }], undefined, () => owner.sources(f.dir, 'other-session'))).documents, [], '未绑定其他项目不获得项目资料')
  agent.session.header.cwd = join(f.root, 'other-cwd')
  assert.equal((await ok('module_open', { reference: hit.reference })).content, 'CHANGED', 'cwd变化不改持久项目')
  const oldSource = await select({ sessionId: 'old', seqs: [1] })
  const historyHit = (await ok('module_search', { query: 'HISTORY ONE' })).hits[0]
  assert.equal(historyHit.reference.kind, 'session')
  assert.deepEqual((await ok('module_search', { query: 'HISTORY TWO' })).hits, [], '未选择历史事件不扫描')
  await select({ sessionId: 'old', seqs: [2] })
  await select({ sessionId: 'later', seqs: [1] })
  let laterLoads = 0
  onLoad = async id => {
    if (id === 'later' && ++laterLoads === 2) {
      onLoad = async () => {}
      assert.equal((await run({ moduleId: 'alice', action: 'revoke', sourceId: oldSource, expectedRevision: currentRevision() })).kind, 'success')
    }
  }
  assert.equal((await call('module_search', { query: 'HISTORY ONE', limit: 50 })).isError, true, '异步期间撤销seq1，seq2仍可读也不能返回旧seq1')
  assert.equal((await call('module_open', { reference: historyHit.reference })).isError, true)
  const { renderSoulSelf } = await import('../../src/host/soul-self.ts')
  writeFileSync(join(f.dir, 'data', 'SELF.src.md'), 'USER SKELETON')
  const self = renderSoulSelf(f.dir, agent, undefined, 12288, undefined, [], undefined, false)
  assert.match(self, /USER SKELETON/)
  assert.match(self, /待归类/)
  assert.doesNotMatch(self, /OLD LEDGER/)
  assert.equal((await run({ moduleId: 'alice', action: 'revoke', sourceId: selected, expectedRevision: currentRevision() })).kind, 'success')
  assert.equal((await call('module_open', { reference: hit.reference })).isError, true, '旧引用撤权后立即拒绝')
  assert.deepEqual((await ok('module_search', { query: 'CHANGED' })).hits, [])
  assert.equal(readFileSync(join(root, 'old.md'), 'utf8'), 'CHANGED')
  await select({ path: 'old.md' })
  const beforeRebind = (await ok('module_search', { query: 'CHANGED' })).hits[0].reference
  const rebound = JSON.parse((await run(request)).text)
  assert.equal((await run({ ...request, action: 'confirm', expectedRevision: rebound.revision })).kind, 'success')
  assert.equal((await run({ moduleId: 'alice', action: 'project', projectDirectory, expectedRevision: currentRevision() })).kind, 'success')
  await select({ path: 'old.md' })
  assert.equal((await call('module_open', { reference: beforeRebind })).isError, true, '同根重绑并重新授权也不复活上一绑定引用')
  mkdirSync(join(f.root, 'other'))
  assert.equal(owner.status(join(f.root, 'other')).state, 'unbound')
  assert.equal(readFileSync(join(root, 'old.md'), 'utf8'), 'CHANGED')
  assert.equal(readFileSync(join(root, 'SELF.src.md'), 'utf8'), 'MY SELF')
  assert.equal(readFileSync(join(root, '02-soul.jsonl'), 'utf8'), 'OLD LEDGER')
  renameSync(join(root, 'old.md'), join(root, 'old-original.md'))
  mkdirSync(join(root, 'old.md'))
  assert.equal(owner.status(f.dir).state, 'unavailable', '授权文件变成目录必须停用')
  renameSync(join(root, 'old.md'), join(root, 'old-directory'))
  renameSync(join(root, 'old-original.md'), join(root, 'old.md'))
  renameSync(join(root, 'general'), join(root, 'general-original'))
  writeFileSync(join(root, 'general'), 'NOT DIRECTORY')
  assert.equal(owner.status(f.dir).state, 'unavailable', '写入目录变成文件必须停用')
  renameSync(join(root, 'general'), join(root, 'general-file'))
  renameSync(join(root, 'general-original'), join(root, 'general'))
  mkdirSync(join(root, '.runtime'))
  writeFileSync(join(root, '.runtime', 'snapshot.json'), '{}')
  assert.equal((await run({ ...request, root: join(root, '.RUNTIME'), read: ['snapshot.json'] })).kind, 'error', '保护目录不能通过大小写或新根绕过白名单')
  assert.equal((await run({ ...request, read: ['SELF.src.md'] })).kind, 'error')
  renameSync(root, root + '-moved')
  mkdirSync(root)
  assert.equal(owner.status(f.dir).state, 'unavailable')
})

function fixture(t) {
  const root = tempDir('pt-module-file-')
  const moduleRoot = join(root, 'modules')
  const dir = join(moduleRoot, 'alice')
  mkdirSync(join(dir, 'assets'), { recursive: true })
  writeFileSync(join(dir, 'assets', 'knowledge.md'), 'KNOWLEDGE')
  writeFileSync(join(dir, 'module.yml'), 'id: alice\nname: Alice\nmodules: []\nrules: []\n')
  const tools = new Map()
  let rebuilds = 0
  const dispose = registerModuleFileTools({
    inject: (_deps, callback) => ({ dispose: callback({ tools: { register: tool => {
      tools.set(tool.name, tool)
      return () => tools.delete(tool.name)
    } } }) }),
  }, { root: moduleRoot, target: (exec, moduleId) => resolveModuleToolTarget(exec, moduleRoot, () => ['alice'], moduleId), rebuild: async () => { rebuilds += 1 } })
  t.after(() => { dispose(); assert.equal(tools.size, 0) })
  return { root, dir, tools, rebuilds: () => rebuilds }
}

test('模块文件工具：读三处根、缺失为空、追加文本与 JSON 行', async t => {
  const f = fixture(t)
  const read = f.tools.get('module_file_read')
  const append = f.tools.get('module_file_append')
  assert.ok(read, '必须注册文件读取工具')
  assert.ok(append, '必须注册文件追加工具')

  await assert.rejects(read.execute({ path: 'memory.md' }, {}), /没有声明模块目标/, '不声明模块就不挑一个')
  assert.deepEqual(await read.execute({ moduleId: 'alice', path: 'memory.md' }, {}), { path: 'memory.md', content: '', bytes: 0 })
  assert.deepEqual(await read.execute({ moduleId: 'alice', path: 'assets/knowledge.md' }, {}),
    { path: 'assets/knowledge.md', content: 'KNOWLEDGE', bytes: 9 })
  assert.deepEqual(await read.execute({ moduleId: 'alice', path: 'data/AGENTS.md' }, {}),
    { path: 'data/AGENTS.md', content: '', bytes: 0 }, 'data/ 尚未装配时缺失为空')

  await append.execute({ moduleId: 'alice', path: 'memory.md', content: 'PRIVATE NOTE' }, {})
  assert.equal(readFileSync(join(f.dir, 'memory.md'), 'utf8'), 'PRIVATE NOTE\n')
  writeFileSync(join(f.dir, 'memory.md'), 'UPDATED MEMORY')
  assert.deepEqual(await read.execute({ moduleId: 'alice', path: 'memory.md' }, {}),
    { path: 'memory.md', content: 'UPDATED MEMORY', bytes: 14 }, '每次读最新内容')

  await append.execute({ moduleId: 'alice', path: 'data/events.jsonl', entry: { type: 'fact', text: 'a' } }, {})
  await append.execute({ moduleId: 'alice', path: 'data/events.jsonl', entry: { type: 'gain', text: 'b' } }, {})
  const lines = readFileSync(join(f.dir, 'data', 'events.jsonl'), 'utf8').trim().split('\n')
  assert.equal(lines.length, 2, 'entry 一次一行')
  assert.deepEqual(JSON.parse(lines[0]), { type: 'fact', text: 'a' })
  assert.deepEqual(JSON.parse(lines[1]), { type: 'gain', text: 'b' })
  assert.deepEqual(await read.execute({ moduleId: 'alice', path: 'data/events.jsonl' }, {}),
    { path: 'data/events.jsonl', content: '{"type":"fact","text":"a"}\n{"type":"gain","text":"b"}\n', bytes: Buffer.byteLength('{"type":"fact","text":"a"}\n{"type":"gain","text":"b"}\n') })

  assert.deepEqual(await append.execute({ moduleId: 'alice', path: 'memory.md', content: '   ' }, {}), { appended: false, path: 'memory.md' })
  assert.equal(readFileSync(join(f.dir, 'memory.md'), 'utf8'), 'UPDATED MEMORY', '空白不写')
  assert.equal(f.rebuilds(), 0, '文件操作不触发重新装配')
})

test('模块文件工具：越界、链接与非法请求拒绝，零写盘', async t => {
  const f = fixture(t)
  const read = f.tools.get('module_file_read')
  const append = f.tools.get('module_file_append')

  for (const path of ['../module.yml', '/etc/passwd', 'configs/x.md', 'assets\\x.md', 'assets/../module.yml', '']) {
    await assert.rejects(read.execute({ moduleId: 'alice', path }, {}), /非法资源路径|只能位于|非空/, path)
  }
  await assert.rejects(read.execute({ moduleId: 'alice', path: 'data/../module.yml' }, {}), /非法资源路径/)
  await assert.rejects(append.execute({ moduleId: 'alice', path: 'assets/knowledge.md', content: 'x' }, {}), /只能追加到/)
  await assert.rejects(append.execute({ moduleId: 'alice', path: 'data/x.jsonl' }, {}), /之一/)
  await assert.rejects(append.execute({ moduleId: 'alice', path: 'data/x.jsonl', content: 'x', entry: {} }, {}), /之一/)
  await assert.rejects(append.execute({ moduleId: 'alice', path: 'data/x.jsonl', entry: [] }, {}), /JSON 对象|must be an object/)
  await assert.rejects(append.execute({ moduleId: 'alice', path: 'data/x.jsonl', entry: {}, extra: 1 }, {}), /未知字段/)
  await assert.rejects(read.execute({ moduleId: 'alice', path: 'data/x.jsonl', extra: 1 }, {}), /未知字段/)

  const outside = join(f.root, 'outside')
  mkdirSync(outside)
  writeFileSync(join(outside, 'x.md'), 'OUTSIDE')
  symlinkSync(outside, join(f.dir, 'data'), 'junction')
  await assert.rejects(read.execute({ moduleId: 'alice', path: 'data/x.md' }, {}), /链接|link/)
  await assert.rejects(append.execute({ moduleId: 'alice', path: 'data/x.jsonl', content: 'BAD' }, {}), /链接|link/)
  assert.equal(readFileSync(join(outside, 'x.md'), 'utf8'), 'OUTSIDE', '链接目标不被改写')
})

test('模块文件工具：大小、编码与目录边界', async t => {
  const f = fixture(t)
  const read = f.tools.get('module_file_read')
  const append = f.tools.get('module_file_append')

  writeFileSync(join(f.dir, 'assets', 'big.md'), Buffer.alloc(1024 * 1024 + 1, 0x61))
  await assert.rejects(read.execute({ moduleId: 'alice', path: 'assets/big.md' }, {}), /1 MiB/)
  writeFileSync(join(f.dir, 'assets', 'bad.md'), Buffer.from([0xff, 0xfe, 0x00]))
  await assert.rejects(read.execute({ moduleId: 'alice', path: 'assets/bad.md' }, {}), /UTF-8|utf-8|encoded/i)

  mkdirSync(join(f.dir, 'data', 'nested'), { recursive: true })
  await assert.rejects(read.execute({ moduleId: 'alice', path: 'data/nested' }, {}), /不是普通文件/)

  await assert.rejects(append.execute({ moduleId: 'alice', path: 'data/x.jsonl', content: 'a'.repeat(1024 * 1024 + 1) }, {}), /1 MiB/)
  writeFileSync(join(f.dir, 'memory.md'), 'a'.repeat(1024 * 1024))
  await assert.rejects(append.execute({ moduleId: 'alice', path: 'memory.md', content: 'x' }, {}), /1 MiB/, '写侧不制造读不出来的文件')
  writeFileSync(join(f.dir, 'data', 'ledger-big.jsonl'), Buffer.alloc(1024 * 1024 + 1, 0x0a))
  const big = await read.execute({ moduleId: 'alice', path: 'data/ledger-big.jsonl' }, {})
  assert.ok(big.bytes > 1024 * 1024, 'data 读上限与 8 MiB 写上限对齐')
  writeFileSync(join(f.dir, 'data', 'full.jsonl'), Buffer.alloc(8 * 1024 * 1024, 0x0a))
  await assert.rejects(append.execute({ moduleId: 'alice', path: 'data/full.jsonl', content: 'x' }, {}), /8 MiB/)
})
