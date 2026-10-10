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

async function personaWorld(t, modules) {
  const root = new Context()
  const handles = []
  let driver
  await root.plugin(Loader)
  const original = Object.freeze({ name: 'deployment:persona-prefix', order: 0, text: 'OFFICIAL', complete: true })
  Object.assign(root.loader.builtins, {
    adapter: new Promise(resolve => setImmediate(() => resolve({ name: 'persona-production', apply: ctx => { installPersonaRegistration(ctx) } }))),
    prompt: SystemPrompt, agents: AgentRegistry,
    driver: { name: 'persona-driver', inject: ['agents', 'systemPrompt'], apply(ctx) {
      driver = ctx
      const standing = createScope(ctx, {})
      standing.ctx.systemPrompt.section(original)
      standing.ctx.systemPrompt.section(Object.freeze({ name: 'deployment:persona-suffix', order: 10200, text: 'TAIL' }))
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
    { id: 'adapter', name: 'cordis:adapter' },
    { id: 'prompt', name: 'cordis:prompt', inject: ['loader'], intercept: { loader: { await: true } } },
    { id: 'agents', name: 'cordis:agents' }, { id: 'driver', name: 'cordis:driver' },
  ])
  await root.loader.await()
  root.systemPrompt.context({ name: 'fixture:runtime', order: 0, text: 'CONTEXT' })
  const runtime = root.get('promptToolPersona')
  const releaseSource = runtime.configure({ modules: () => modules, variableStore: {
    read(moduleId) { assert.equal(moduleId, 'first'); return { module: { empty: '' }, global: {}, revisions: { module: 'm', global: null } } },
    commit() { throw new Error('read-only assembly must not commit') }, publish() {},
  } })
  t.after(async () => { releaseSource(); for (const handle of handles.reverse()) await handle.dispose(); await root.fiber.dispose() })
  const assemble = agent => agent.ctx.systemPrompt.assemble({ scope: scopeOf(agent.ctx), agent })
  const create = async (id, subagent = false, setup) => (await driver.agents.create({ sessionId: id, meta: subagent ? { origin: 'subagent' } : {}, setup })).agent
  return { root, runtime, driver, original, assemble, create }
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

test('真实 Loader 的生产适配器首装主子人设，冲突保留原状态，卸载恢复冻结原声明', async t => {
  const modules = [{ moduleId: 'first', persona: { main: { prefix: '{{empty}}MAIN', complete: false, includeRuntimeContext: false } } }]
  const { root, runtime, original, assemble, create } = await personaWorld(t, modules)
  const main = await create('main')
  const child = await create('child', true)
  assert.deepEqual((await assemble(main)).sections.map(section => section.text), ['You are an AI agent powered by DeepSeek Harness.', 'MAIN', 'TAIL'])
  assert.deepEqual((await assemble(child)).sections.map(section => section.text), ['OFFICIAL'])
  assert.deepEqual((await assemble(main)).contexts, [])
  assert.ok((await assemble(child)).contexts.some(context => context.text === 'CONTEXT'))
  modules.push({ moduleId: 'second', persona: { main: { prefix: 'CONFLICT' } } })
  assert.throws(() => runtime.refresh(), /main\.prefix.*first.*second/)
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

test('未知创建/注册路径拒绝，取消与发布失败清理原 scope', async t => {
  const { driver, assemble, create } = await personaWorld(t, [{ moduleId: 'first', persona: { main: { complete: false }, subagent: { prefix: 'CUSTOM', complete: true } } }])
  await assert.rejects(driver.get('agents').create({ sessionId: 'bypassed-create' }), /创建路径未被观察/)
  await assert.rejects(create('bypassed-section', true, ctx => ctx.get('systemPrompt').section({ name: 'deployment:persona-prefix', order: 0, text: 'BYPASS' })), /未观察/)
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
