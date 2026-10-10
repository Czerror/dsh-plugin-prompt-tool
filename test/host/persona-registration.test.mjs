import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { parse } from 'yaml'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { bindScopeParent, createScope, scopeOf, scopeTarget } from '@deepseek-ai/dsh-scope'
import { isolatedHome } from '../fixtures/host-harness.mjs'

const { moduleRoot } = isolatedHome('pt-persona-registration-')
const { readModulePersona, saveModulePersona } = await import('../../src/host/manifest.ts')
const { installPersonaRegistration } = await import('../../src/runtime/persona-registration.ts')
const require = createRequire(import.meta.url)
const dependencies = createRequire(require.resolve('@deepseek-ai/dsh-agent-preset-registry'))
const { default: Loader } = await import(pathToFileURL(dependencies.resolve('@deepseek-ai/cordis-plugin-loader')).href)
// 模块解析替身按官方 Persona 配置契约贡献真实声明。
const OfficialPersona = { name: 'fixture-official-persona', inject: ['systemPrompt'], apply(ctx, config) {
  ctx.systemPrompt.section(Object.freeze({ name: 'deployment:persona-prefix', order: 0, text: config.prefix, complete: config.complete }))
  ctx.systemPrompt.section(Object.freeze({ name: 'deployment:persona-suffix', order: 10200, text: config.suffix ?? '' }))
} }

async function personaWorld(t, modules) {
  const root = new Context()
  const handles = []
  let driver
  await root.plugin(Loader)
  const original = Object.freeze({ name: 'deployment:persona-prefix', order: 0, text: 'OFFICIAL', complete: true })
  Object.assign(root.loader.builtins, {
    adapter: new Promise(resolve => setImmediate(() => resolve({ name: 'persona-production', apply: ctx => { installPersonaRegistration(ctx) } }))),
    prompt: SystemPrompt, agents: AgentRegistry,
    driver: { name: 'persona-driver', inject: ['agents', 'systemPrompt'], async apply(ctx) {
      driver = ctx
      const standing = createScope(ctx, {})
      await standing.ctx.plugin(OfficialPersona, { prefix: 'OFFICIAL', suffix: 'TAIL', complete: true })
      ctx.effect(() => ctx.agents.setFactory({ async createAgent(_owner, options) {
        const agent = { id: options.sessionId, status: 'idle', options: {}, session: { id: options.sessionId, header: options.meta ?? {}, snapshotEvents: () => [] } }
        const scope = createScope(ctx, agent)
        agent.ctx = scope.ctx
        bindScopeParent(scopeOf(agent.ctx), scopeOf(standing.ctx))
        try {
          const commit = await options.setup?.(agent.ctx, agent)
          options.signal?.throwIfAborted()
          commit?.commit()
          await root.serial(scopeTarget(agent, scopeOf(agent.ctx)), 'agent/created', { agent, source: 'startup' })
        } catch (error) { await scope.dispose(); throw error }
        const handle = { agent, dispose: () => scope.dispose() }
        handles.push(handle)
        return handle
      } }))
    } },
  })
  await root.loader.root.update([
    { id: 'prompt', name: 'cordis:prompt' },
    { id: 'agents', name: 'cordis:agents' }, { id: 'driver', name: 'cordis:driver' },
  ])
  await root.loader.await()
  const originalImport = root.loader.import.bind(root.loader)
  root.loader.import = (name, ...args) => name === '@deepseek-ai/dsh-persona' ? OfficialPersona : originalImport(name, ...args)
  await root.loader.create({ id: 'adapter', name: 'cordis:adapter' })
  await root.loader.await()
  root.systemPrompt.context({ name: 'fixture:runtime', order: 0, text: 'CONTEXT' })
  const runtime = root.get('promptToolPersona')
  const warnings = []
  const releaseSource = await runtime.configure({ modules: () => modules, warn: text => warnings.push(text), variableStore: {
    read(moduleId) { assert.equal(moduleId, 'first'); return { module: { empty: '' }, global: {}, revisions: { module: 'm', global: null } } },
    commit() { throw new Error('read-only assembly must not commit') }, publish() {},
  } })
  t.after(async () => { await releaseSource(); for (const handle of handles.reverse()) await handle.dispose(); await root.fiber.dispose() })
  const assemble = agent => agent.ctx.systemPrompt.assemble({ scope: scopeOf(agent.ctx), agent })
  const create = async (id, subagent = false, setup) => (await driver.agents.create({ sessionId: id, meta: subagent ? { origin: 'subagent' } : {}, setup })).agent
  return { root, runtime, driver, original, assemble, create, warnings }
}

test('人设保存保留主子字段继承、空串和 false，CAS 拒绝覆盖更新', () => {
  const dir = join(moduleRoot, 'persona-values')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'module.yml')
  writeFileSync(file, '# user comment\nid: persona-values\nmodules: []\nrules: []\nunknown: keep\n')
  const before = readModulePersona(dir)
  assert.equal(before.persona, null)
  writeFileSync(file, [
    '# user comment', 'id: persona-values', 'modules: []', 'rules: []', 'unknown: keep # unknown comment',
    'persona: # persona comment', '  main: # main comment', '    prefix: OLD # prefix comment',
    '    suffix: REMOVE', '    complete: false # complete comment', '  subagent: # child comment',
    '    suffix: "" # child suffix comment', '    complete: true', '    includeRuntimeContext: false', '',
  ].join('\n'))
  const annotated = readModulePersona(dir)
  const persona = { main: { prefix: '', complete: false }, subagent: { suffix: '', complete: true, includeRuntimeContext: false } }
  const saved = saveModulePersona(moduleRoot, 'persona-values', persona, annotated.revision)
  assert.deepEqual(readModulePersona(dir), saved)
  assert.deepEqual(saved.persona, persona)
  assert.equal(parse(readFileSync(file, 'utf8')).unknown, 'keep')
  for (const comment of ['user comment', 'unknown comment', 'persona comment', 'main comment', 'prefix comment', 'complete comment', 'child comment', 'child suffix comment']) {
    assert.ok(readFileSync(file, 'utf8').includes('# ' + comment), `保存保留 ${comment}`)
  }
  const bytes = readFileSync(file)
  assert.throws(() => saveModulePersona(moduleRoot, 'persona-values', null, before.revision), /版本|更新|冲突/)
  assert.deepEqual(readFileSync(file), bytes)
  const cleared = saveModulePersona(moduleRoot, 'persona-values', null, saved.revision)
  assert.equal(cleared.persona, null)
  assert.equal(parse(readFileSync(file, 'utf8')).configOrder, undefined)
  const recreated = saveModulePersona(moduleRoot, 'persona-values', { main: { suffix: '' } }, cleared.revision)
  assert.deepEqual(recreated.persona, { main: { suffix: '' } }, '删除后可重新建立独立人设字段')
})

test('旧扁平人设和非法新字段明确拒绝且不改盘', () => {
  const dir = join(moduleRoot, 'persona-retired')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'module.yml')
  writeFileSync(file, 'id: persona-retired\nmodules: []\nrules: []\npersona:\n  prefix: legacy\n')
  const before = readFileSync(file)
  assert.throws(() => readModulePersona(dir), /退役|转换/)
  assert.deepEqual(readFileSync(file), before)
  writeFileSync(file, 'id: persona-retired\nmodules: []\nrules: []\n')
  const revision = readModulePersona(dir).revision
  assert.throws(() => saveModulePersona(moduleRoot, 'persona-retired', { main: { complete: 'false' } }, revision), /布尔/)
  assert.equal(readModulePersona(dir).persona, null)
  for (const declaration of [
    'persona:\n  main:\n    prefix: &shared BEFORE # keep\nunknown: *shared\n',
    'persona:\n  main: &shared { prefix: BEFORE }\nunknown: *shared\n',
  ]) {
    writeFileSync(file, 'id: persona-retired\nmodules: []\nrules: []\n' + declaration)
    const aliased = readModulePersona(dir)
    const bytes = readFileSync(file)
    for (const next of [{ main: { ...aliased.persona.main, prefix: 'AFTER' } }, null]) {
      assert.throws(() => saveModulePersona(moduleRoot, 'persona-retired', next, aliased.revision), /YAML.*引用/)
      assert.deepEqual(readFileSync(file), bytes, '共享别名拒绝后完整定义保持原字节')
    }
  }
  writeFileSync(file, 'id: persona-retired\nmodules: []\nrules: []\npersona:\n  main:\n    prefix: &inside BEFORE\n    suffix: *inside\n')
  const internal = readModulePersona(dir)
  const updated = saveModulePersona(moduleRoot, 'persona-retired', { main: { prefix: 'AFTER', suffix: 'BEFORE' } }, internal.revision)
  assert.deepEqual(updated.persona, { main: { prefix: 'AFTER', suffix: 'BEFORE' } }, '人设内别名不强迫未改字段跟随修改')
  assert.equal(saveModulePersona(moduleRoot, 'persona-retired', null, updated.revision).persona, null, '没有外部引用时允许明确删除人设')
})

test('会话人设：官方服务先启动，主子首装覆盖，冲突保旧且卸载恢复原声明', async t => {
  const modules = [{ moduleId: 'first', persona: { main: { prefix: '{{empty}}MAIN', complete: false, includeRuntimeContext: false } } }]
  const { root, runtime, original, assemble, create } = await personaWorld(t, modules)
  const main = await create('main')
  const child = await create('child', true)
  assert.deepEqual((await assemble(main)).sections.map(section => section.text), ['You are an AI agent powered by DeepSeek Harness.', 'MAIN', 'TAIL'])
  assert.deepEqual((await assemble(child)).sections.map(section => section.text), ['OFFICIAL'])
  assert.deepEqual((await assemble(main)).contexts, [])
  assert.ok((await assemble(child)).contexts.some(context => context.text === 'CONTEXT'))
  modules.push({ moduleId: 'second', persona: { main: { prefix: 'CONFLICT' } } })
  await assert.rejects(runtime.refresh(), /main\.prefix.*first.*second/)
  assert.ok((await assemble(main)).sections.some(section => section.text === 'MAIN'))
  modules.pop()
  modules[0].persona.subagent = { prefix: '', complete: true }
  const setup = await create('setup-child', true, ctx => { ctx.systemPrompt.section(Object.freeze({ name: 'deployment:persona-prefix', order: 0, text: 'CHILD ORIGINAL' })) })
  assert.deepEqual((await assemble(setup)).sections.map(section => section.text), [''])
  assert.deepEqual(original, { name: 'deployment:persona-prefix', order: 0, text: 'OFFICIAL', complete: true })
  await root.loader.resolve('adapter').fiber.dispose()
  assert.ok(root.get('systemPrompt'))
  assert.deepEqual((await assemble(main)).sections.map(section => section.text), ['OFFICIAL'])
  assert.ok((await assemble(main)).contexts.some(context => context.text === 'CONTEXT'))
  assert.deepEqual((await assemble(setup)).sections.map(section => section.text), ['You are an AI agent powered by DeepSeek Harness.', 'CHILD ORIGINAL', 'TAIL'])
})

test('未知声明保持原状并报告，取消与发布失败清理原 scope', async t => {
  const { driver, runtime, assemble, create, warnings } = await personaWorld(t, [{ moduleId: 'first', persona: { main: { complete: false }, subagent: { prefix: 'CUSTOM', complete: true } } }])
  const bypass = (await driver.get('agents').create({ sessionId: 'bypassed-create' })).agent
  assert.deepEqual((await assemble(bypass)).sections.map(section => section.text), ['OFFICIAL'])
  const change = await runtime.prepare([{ agent: bypass, completeSections: [] }])
  try { await change.commit() } finally { await change.release() }
  assert.ok((await assemble(bypass)).sections.some(section => section.name === 'harness:identity'), '既有继承会话可运行期接管')
  const unknown = await create('bypassed-section', true, ctx => { ctx.get('systemPrompt').section({ name: 'deployment:persona-prefix', order: 0, text: 'BYPASS', complete: true }) })
  assert.deepEqual((await assemble(unknown)).sections.map(section => section.text), ['BYPASS'])
  assert.ok(warnings.some(message => /未观察/.test(message)))
  const abort = new AbortController()
  await assert.rejects(driver.agents.create({ sessionId: 'canceled', signal: abort.signal, meta: { origin: 'subagent' }, setup(ctx) {
    ctx.systemPrompt.section({ name: 'deployment:persona-prefix', order: 0, text: 'CANCELED' })
    abort.abort(new Error('creation canceled'))
  } }), /creation canceled/)
  await assert.rejects(create('commit-failed', true, ctx => {
    ctx.systemPrompt.section({ name: 'deployment:persona-prefix', order: 0, text: 'FAILED' })
    return { commit() { throw new Error('publication rejected') } }
  }), /publication rejected/)
  const agent = await create('after-failures', true)
  assert.deepEqual((await assemble(agent)).sections.map(section => section.text), ['CUSTOM'])
})

test('旧会话官方人设在维护窗口接管：动态值、忙碌拒绝、外部更新保留与卸载恢复', async t => {
  const root = new Context(), scopes = [], actors = []
  await root.plugin(SystemPrompt)
  root.provide('loader', { import: async name => { assert.equal(name, '@deepseek-ai/dsh-persona'); return OfficialPersona }, unwrapExports: value => value })
  root.provide('agents', { list: () => actors })
  const makeOld = async id => {
    const events = Object.freeze([{ type: 'user/message', seq: 1, data: { text: 'EXISTING HISTORY' } }])
    let maintenance = false, cancelCalls = 0, claims = 0
    const agent = { id, status: 'idle', options: {}, session: { id, header: {}, snapshotEvents: () => events },
      cancel() { cancelCalls++ },
      async runMaintenance(job) {
        if (maintenance || agent.status !== 'idle') throw new Error('already has active work')
        maintenance = true; claims++
        try { return await job(new AbortController().signal) } finally { maintenance = false }
      },
    }
    const scope = createScope(root, {}); scopes.push(scope); agent.ctx = scope.ctx
    const fiber = await scope.ctx.plugin(OfficialPersona, { prefix: `${id} ORIGINAL`, suffix: 'TAIL', complete: true })
    actors.push(agent)
    return { agent, fiber, events, stats: () => ({ maintenance, cancelCalls, claims }) }
  }
  const first = await makeOld('first'), second = await makeOld('second')
  let veto
  const blocking = await root.plugin({ name: 'fixture-config-veto', apply(ctx) {
    veto = ctx.on('internal/update', function(_config, _noSave, next) { return this === second.fiber ? undefined : next() }, { global: true })
  } })
  let runtime, value = 'A'
  const owner = await root.plugin({ name: 'late-persona-owner', apply(ctx) { runtime = installPersonaRegistration(ctx) } })
  const modules = []
  const releaseSource = await runtime.configure({ modules: () => modules, variableStore: {
    read() { return { module: { label: value }, global: {}, revisions: { module: 'm', global: null } } },
    commit() { throw new Error('预览不得写模板变量') }, publish() {},
  } })
  t.after(async () => { await releaseSource(); await owner.dispose(); for (const scope of scopes.reverse()) await scope.dispose(); await root.fiber.dispose() })
  const assemble = async actor => (await actor.agent.ctx.get('systemPrompt').assemble({ agent: actor.agent, scope: scopeOf(actor.agent.ctx) })).sections.map(item => item.text)
  const source = { moduleId: 'selected', persona: { main: { prefix: 'CUSTOM {{label}}', complete: false } } }
  assert.deepEqual(await assemble(first), ['first ORIGINAL'])
  assert.deepEqual(await assemble(second), ['second ORIGINAL'])
  modules.push(source)
  const rejected = await runtime.prepare(actors.map(agent => ({ agent, completeSections: [] })))
  try { await assert.rejects(rejected.commit(), /重载被拦截|声明不完整/) } finally { await rejected.release() }
  assert.deepEqual(await assemble(first), ['first ORIGINAL'], '第二个owner拒绝接管时前一个恢复')
  assert.deepEqual(await assemble(second), ['second ORIGINAL'])
  veto()
  await blocking.dispose()
  const change = await runtime.prepare(actors.map(agent => ({ agent, completeSections: [] })))
  assert.equal(first.stats().maintenance, true, '准备到提交整个配装窗口保持维护锁')
  assert.equal(second.stats().maintenance, true)
  try { await change.commit() } finally { await change.release() }
  assert.deepEqual(await assemble(first), ['You are an AI agent powered by DeepSeek Harness.', 'CUSTOM A', 'TAIL'])
  value = 'B'
  assert.ok((await assemble(second)).includes('CUSTOM B'), '接管后模板仍动态读取来源值')
  assert.equal(first.agent.session.snapshotEvents(), first.events)
  assert.equal(first.stats().maintenance, false)
  const firstCtx = first.agent.ctx
  source.persona.main.prefix = 'NEW {{label}}'
  second.agent.status = 'running'
  await assert.rejects(runtime.refresh(), /正在运行|active work/)
  assert.ok((await assemble(first)).includes('CUSTOM B'))
  assert.equal(first.stats().maintenance, false, '后续Agent拒绝时已取得的维护锁释放')
  assert.equal(first.stats().cancelCalls + second.stats().cancelCalls, 0)
  second.agent.status = 'idle'
  await runtime.refresh()
  assert.ok((await assemble(first)).includes('NEW B'))
  const beforeConflict = await runtime.prepare(actors.map(agent => ({ agent, completeSections: [] })), [{ moduleId: 'next', persona: { main: { prefix: 'NO OVERWRITE', complete: false } } }])
  second.fiber.update({ prefix: 'EXTERNAL', suffix: 'NEW TAIL', complete: true }, true)
  await second.fiber.await()
  try { await assert.rejects(beforeConflict.commit(), /配置已变化|注册已变化/) } finally { await beforeConflict.release() }
  assert.ok((await assemble(first)).includes('NEW B'), '整批后续失败恢复前一个Agent')
  assert.deepEqual(await assemble(second), ['EXTERNAL'])
  const pending = await runtime.prepare([{ agent: first.agent, completeSections: [] }], [{ moduleId: 'pending', persona: { main: { prefix: 'AFTER UNLOAD', complete: false } } }])
  await owner.dispose()
  try { await assert.rejects(pending.commit(), /取消|释放/) } finally { await pending.release() }
  assert.deepEqual(await assemble(first), ['first ORIGINAL'])
  assert.deepEqual(await assemble(second), ['EXTERNAL'], '卸载不得把外部改动回写为旧值')
  assert.equal(first.agent.ctx, firstCtx)
  assert.equal(first.agent.session.snapshotEvents(), first.events)
  assert.ok(root.get('systemPrompt'))
})
