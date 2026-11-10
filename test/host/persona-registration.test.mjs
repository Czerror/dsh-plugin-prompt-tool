import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { stringify } from 'yaml'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import Storage from '@deepseek-ai/dsh-storage'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { openSessionVariables } from '../../src/host/session-variables.ts'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { bindScopeParent, createScope, scopeOf, scopeTarget } from '@deepseek-ai/dsh-scope'
import { isolatedHome } from '../fixtures/host-harness.mjs'

const { moduleRoot } = isolatedHome('pt-persona-registration-')
const { installPersonaCapture } = await import('../../src/runtime/persona-registration.ts')
const { createAgentAssembly } = await import('../../src/runtime/agent-assembly.ts')
const { installSoulRuntime } = await import('../../src/runtime/soul-runtime.ts')
const { resolveModuleToolTarget } = await import('../../src/host/module-tool-target.ts')
const dependencies = createRequire(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-agent-preset-registry'))
const { default: Loader } = await import(pathToFileURL(dependencies.resolve('@deepseek-ai/cordis-plugin-loader')).href)
const { default: SessionProjections } = await import(pathToFileURL(dependencies.resolve('@deepseek-ai/dsh-session-projection')).href)
const IDENTITY = 'You are an AI agent powered by DeepSeek Harness.'
const OfficialPersona = { name: 'fixture-official-persona', inject: ['systemPrompt'], apply(ctx, config) {
  ctx.systemPrompt.section(Object.freeze({ name: 'deployment:persona-prefix', order: 0, text: config.prefix, complete: config.complete }))
  ctx.systemPrompt.section(Object.freeze({ name: 'deployment:persona-suffix', order: 10200, text: config.suffix ?? '' }))
} }
const persona = (id, action, condition) => ({ id, ...(condition === undefined ? {} : { if: condition }), then: [{ id: 'identity', kind: 'persona', ...action }] })
function writeModule(id, rules, variables) {
  const dir = join(moduleRoot, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'module.yml'), stringify({ id, modules: [], rules, ...(variables === undefined ? {} : { variables }) }))
}
async function personaWorld(t, enabled, pluginConfig) {
  const root = new Context(), handles = []
  const storage = new Storage(root), backend = new JsonStorageBackend(join(moduleRoot, 'persona-storage'))
  storage.backend.register('json', backend)
  const facility = new DomainFacility(root, { backend: 'json' }), sessions = await openSessionVariables(facility)
  t.after(async () => { await sessions.dispose(); await facility.closeAll(); await backend.close() })
  let driver, capture, standing
  await root.plugin(Loader)
  Object.assign(root.loader.builtins, {
    adapter: { name: 'persona-production', apply: ctx => { capture = installPersonaCapture(ctx) } },
    prompt: SystemPrompt, projections: SessionProjections, agents: AgentRegistry,
    driver: { name: 'persona-driver', inject: ['agents', 'systemPrompt'], async apply(ctx) {
      driver = ctx
      standing = createScope(ctx, {})
      await standing.ctx.plugin(OfficialPersona, { prefix: 'OFFICIAL', suffix: 'TAIL', complete: true })
      ctx.effect(() => ctx.agents.setFactory({ async createAgent(_owner, options) {
        const agent = { id: options.sessionId, status: 'idle', options: {}, session: { id: options.sessionId, header: options.meta ?? {}, snapshotEvents: () => [] } }
        const scope = createScope(ctx, agent); agent.ctx = scope.ctx
        bindScopeParent(scopeOf(agent.ctx), scopeOf(standing.ctx))
        try {
          const commit = await options.setup?.(agent.ctx, agent)
          options.signal?.throwIfAborted(); commit?.commit()
          await root.serial(scopeTarget(agent, scopeOf(agent.ctx)), 'agent/created', { agent, source: 'startup' })
        } catch (error) { await scope.dispose(); throw error }
        const handle = { agent, dispose: () => scope.dispose() }; handles.push(handle); return handle
      } }))
    } },
  })
  await root.loader.root.update([{ id: 'prompt', name: 'cordis:prompt' }, { id: 'projections', name: 'cordis:projections' }, { id: 'agents', name: 'cordis:agents' }, { id: 'driver', name: 'cordis:driver' }])
  await root.loader.await()
  const originalImport = root.loader.import.bind(root.loader)
  root.loader.import = (name, ...args) => name === '@deepseek-ai/dsh-persona' ? OfficialPersona : originalImport(name, ...args)
  await root.loader.create({ id: 'adapter', name: 'cordis:adapter' }); await root.loader.await()
  root.provide('tools', {}); root.provide('llm', {})
  root.systemPrompt.context({ name: 'fixture:runtime', order: 0, text: 'CONTEXT' })
  const warnings = []
  let plugin
  const runtime = pluginConfig === undefined ? createAgentAssembly(root, { moduleRoot, enabledModules: enabled, personaCapture: capture, warn: text => warnings.push(text) }) : undefined
  if (pluginConfig !== undefined) {
    const { apply } = await import('../../src/index.ts')
    plugin = root.plugin({ name: 'live-limit-breaker', apply: ctx => apply(ctx, pluginConfig) }); await plugin
  }
  if (runtime !== undefined) {
    const moduleIds = id => runtime.moduleIds(id)
    installSoulRuntime(root, { root: moduleRoot, target: (exec, id) => resolveModuleToolTarget(exec, moduleRoot, moduleIds, id),
      rebuild: id => runtime.refresh(id) }, moduleIds, () => sessions)
  }
  t.after(async () => { await runtime?.dispose(); await plugin?.dispose(); for (const handle of handles.reverse()) await handle.dispose(); await standing.dispose(); await root.fiber.dispose() })
  const assembly = agent => agent.ctx.systemPrompt.assemble({ scope: scopeOf(agent.ctx), agent })
  return { root, standing, runtime, plugin, warnings, assembly, texts: async agent => (await assembly(agent)).sections.map(section => section.text),
    create: async (id, meta = {}, setup) => (await driver.agents.create({ sessionId: id, meta, setup })).agent }
}

test('人设规则：动态条件按序拼接、主子隔离，失配回官方且冲突保旧', async t => {
  const rules = [persona('late', { prefix: 'SECOND', complete: false }, { variable: { key: 'mode', value: 'on' } }),
    persona('early', { prefix: 'FIRST', suffix: '', complete: false, includeRuntimeContext: false, audience: 'main' }, { variable: { key: 'mode', value: 'on' } }),
    persona('child', { prefix: 'CHILD', complete: false, audience: 'subagent' })]
  writeModule('runtime-first', [persona('identity', { prefix: '{{runtime.get::session.id}}', complete: false })])
  const firstWorld = await personaWorld(t, () => ['runtime-first'])
  const firstAgent = await firstWorld.create('runtime-first-agent')
  assert.deepEqual(await firstWorld.texts(firstAgent), [IDENTITY, 'runtime-first-agent', 'TAIL'], '首次无条件人设正文可读真实runtime身份')
  writeModule('dynamic', rules, { mode: 'on' })
  let enabled = ['dynamic']
  const world = await personaWorld(t, () => enabled)
  const main = await world.create('dynamic-main'), child = await world.create('dynamic-child', { delegationDepth: 1 })
  assert.deepEqual(await world.texts(main), [IDENTITY, 'SECOND\n\nFIRST', ''])
  assert.deepEqual(await world.texts(child), [IDENTITY, 'SECOND\n\nCHILD', 'TAIL'])
  assert.deepEqual((await world.assembly(main)).contexts, [])
  writeModule('dynamic', rules, { mode: 'off' })
  assert.deepEqual(await world.texts(main), ['OFFICIAL'])
  assert.deepEqual(await world.texts(child), [IDENTITY, 'CHILD', 'TAIL'])
  writeModule('dynamic', [persona('good', { prefix: 'GOOD', complete: false })])
  assert.deepEqual(await world.texts(main), [IDENTITY, 'GOOD', 'TAIL'])
  writeModule('dynamic', [persona('one', { prefix: 'BAD', complete: true }), persona('two', { complete: false })])
  await assert.rejects(world.runtime.refresh(), /complete|冲突/)
  assert.deepEqual(await world.texts(main), [IDENTITY, 'GOOD', 'TAIL'])
  writeModule('dynamic', [persona('unavailable', { prefix: 'NO', complete: false }, { not: { variable: { scope: 'runtime', key: 'soul.mark', value: 'missing' } } })])
  assert.deepEqual(await world.texts(main), ['OFFICIAL'], '不可用事实不经 not 命中')
  writeModule('dynamic', ['main', 'subagent'].map(audience => persona(`runtime-${audience}`, {
    prefix: '{{runtime.get::session.id}} / {{runtime.get::session.audience}}', complete: false,
  }, { variable: { scope: 'runtime', key: 'session.audience', value: audience } })))
  assert.deepEqual(await world.texts(main), [IDENTITY, 'dynamic-main / main', 'TAIL'], '仅人设规则的启用模块获准读取真实 runtime 条件与正文')
  assert.deepEqual(await world.texts(child), [IDENTITY, 'dynamic-child / subagent', 'TAIL'], '真实 runtime 来源授权与主子会话身份隔离')
  enabled = []; await world.runtime.refresh()
  assert.deepEqual(await world.texts(main), ['OFFICIAL'])
  assert.deepEqual(await world.texts(child), ['OFFICIAL'])
  const probeRules = [persona('identity', { prefix: '{{mode}}', complete: false })]
  writeModule('double-failure-probe', probeRules, { mode: 'OLD' })
  const probe = await personaWorld(t, () => ['double-failure-probe'])
  const agent = await probe.create('double-failure-agent')
  assert.deepEqual(await probe.texts(agent), [IDENTITY, 'OLD', 'TAIL'])
  const section = probe.root.systemPrompt.section
  let failures = 2
  t.mock.method(probe.root.systemPrompt, 'section', function (value) {
    if (scopeOf(this.ctx) === scopeOf(agent.ctx) && failures > 0) { failures--; throw new Error('ASSEMBLE-DOUBLE-FAIL') }
    return section.call(this, value)
  })
  writeModule('double-failure-probe', probeRules, { mode: 'NEW' })
  assert.deepEqual(await probe.texts(agent), ['OFFICIAL'])
  assert.equal(probe.runtime.hasMounted(agent.id), false, '请求前注册及恢复双失败撤回整个配装记录')
  await assert.rejects(agent.ctx.systemPrompt.assemble({ scope: scopeOf(agent.ctx), agent, signal: AbortSignal.abort() }), /abort/i)
})

test('同层人设恢复：失配和卸载恢复原对象，原 owner 撤销后不复活', async t => {
  let enabled = ['captured']
  writeModule('captured', [persona('ours', { prefix: 'OURS', complete: false })])
  const world = await personaWorld(t, () => enabled)
  let off
  const child = await world.create('captured-child', { delegationDepth: 1 }, ctx => {
    off = ctx.systemPrompt.section(Object.freeze({ name: 'deployment:persona-prefix', order: 0, text: 'RAW {{missing}}', interpolate: false }))
  })
  assert.deepEqual(await world.texts(child), [IDENTITY, 'OURS', 'TAIL'])
  enabled = []; await world.runtime.refresh()
  assert.equal(renderPrompt(await world.assembly(child)), `${IDENTITY}\n\nRAW {{missing}}\n\nTAIL`)
  enabled = ['captured']; await world.runtime.refresh()
  await world.runtime.dispose()
  assert.equal(renderPrompt(await world.assembly(child)), `${IDENTITY}\n\nRAW {{missing}}\n\nTAIL`)
  off()
  assert.deepEqual(await world.texts(child), ['OFFICIAL'])
  const second = await personaWorld(t, () => ['captured'])
  let cancel
  const cancelled = await second.create('cancelled-owner', { delegationDepth: 1 }, ctx => {
    cancel = ctx.systemPrompt.section({ name: 'deployment:persona-prefix', order: 0, text: 'DO NOT RESTORE' })
  })
  assert.deepEqual(await second.texts(cancelled), [IDENTITY, 'OURS', 'TAIL'])
  cancel()
  await second.runtime.dispose()
  assert.deepEqual(await second.texts(cancelled), ['OFFICIAL'], '暂撤期间原 owner 取消后不复活')
  const third = await personaWorld(t, () => ['captured'])
  let owner
  const disposed = await third.create('disposed-owner', { delegationDepth: 1 }, async ctx => {
    owner = ctx.plugin({ apply(inner) { inner.systemPrompt.section({ name: 'deployment:persona-prefix', order: 0, text: 'DISPOSED OWNER' }) } })
    await owner
  })
  await owner.dispose()
  await third.runtime.dispose()
  assert.deepEqual(await third.texts(disposed), ['OFFICIAL'], '暂撤期间原插件释放后不复活')
})

test('默认身份规则只去来源身份句，保留混合功能及其他模块，逐闸撤回且不复活 owner', async t => {
  const rules = [persona('purge-4', { stripDefaultIdentity: 'preset' }, { variable: { key: 'mode', value: 'on' } }),
    persona('purge-25', { stripDefaultIdentity: 'harness' }, { variable: { key: 'mode', value: 'on' } })]
  writeModule('limit-test', rules, { mode: 'on' })
  writeModule('peer', [{ id: 'feature', then: [{ id: 'body', kind: 'inject-text', config: { layer: 'system-section', strategy: 'static', text: 'OTHER MODULE' } }] }])
  let enabled = ['limit-test', 'peer']
  const world = await personaWorld(t, () => enabled)
  world.root.systemPrompt.section({ name: 'tool:fixture', order: 500, text: 'TOOL INSTRUCTIONS' })
  world.root.systemPrompt.section({ name: 'environment:fixture', order: 10000, text: 'ENVIRONMENT' })
  const mixed = 'You are a coding agent powered by the {{model}} model.\nKeep every functional sentence.'
  let cancel
  const main = await world.create('strip-main', {}, ctx => {
    cancel = ctx.systemPrompt.section({ name: 'deployment:persona-prefix', order: 0, text: mixed, interpolate: false })
  })
  const child = await world.create('strip-child', { delegationDepth: 1 }, ctx => {
    ctx.systemPrompt.section({ name: 'deployment:persona-prefix', order: 0, text: 'CUSTOM IDENTITY.\nCHILD FUNCTION', interpolate: false })
  })
  const [first, second] = await Promise.all([world.texts(main), world.texts(child)])
  assert.deepEqual(first, ['', '\nKeep every functional sentence.', 'OTHER MODULE', 'TOOL INSTRUCTIONS', 'ENVIRONMENT', 'TAIL'])
  assert.deepEqual(second, ['', 'CUSTOM IDENTITY.\nCHILD FUNCTION', 'OTHER MODULE', 'TOOL INSTRUCTIONS', 'ENVIRONMENT', 'TAIL'])
  assert.deepEqual((await world.assembly(main)).contexts.map(item => item.text), ['CONTEXT'])
  writeModule('limit-test', [{ ...rules[0], enabled: false }, rules[1]], { mode: 'on' })
  assert.deepEqual(await world.texts(main), ['', mixed, 'OTHER MODULE', 'TOOL INSTRUCTIONS', 'ENVIRONMENT', 'TAIL'])
  writeModule('limit-test', [rules[0], { ...rules[1], enabled: false }], { mode: 'on' })
  assert.deepEqual(await world.texts(main), [IDENTITY, '\nKeep every functional sentence.', 'OTHER MODULE', 'TOOL INSTRUCTIONS', 'ENVIRONMENT', 'TAIL'])
  writeModule('limit-test', rules, { mode: 'off' })
  assert.deepEqual(await world.texts(main), [IDENTITY, mixed, 'OTHER MODULE', 'TOOL INSTRUCTIONS', 'ENVIRONMENT', 'TAIL'])
  assert.equal(world.runtime.ruleDiagnostics().records.find(record => record.ruleId === 'purge-25' && record.channel === 'persona:identity:harness').identityOutcome, 'condition-miss')
  writeModule('limit-test', rules, { mode: 'on' })
  enabled = ['peer']; await world.runtime.refresh()
  assert.deepEqual(await world.texts(main), [IDENTITY, mixed, 'OTHER MODULE', 'TOOL INSTRUCTIONS', 'ENVIRONMENT', 'TAIL'])
  enabled = []; await world.runtime.refresh()
  assert.deepEqual(await world.texts(main), [IDENTITY, mixed, 'TOOL INSTRUCTIONS', 'ENVIRONMENT', 'TAIL'])
  enabled = ['limit-test']; await world.runtime.refresh()
  cancel()
  await world.runtime.dispose()
  assert.deepEqual(await world.texts(main), ['OFFICIAL'])
})

test('默认身份接管读取真实动态段，保留自定义与其他人设贡献，目标失配只诊断', async t => {
  writeModule('strip-dynamic', [persona('preset', { stripDefaultIdentity: 'preset' }), persona('harness', { stripDefaultIdentity: 'harness' })])
  const world = await personaWorld(t, () => ['strip-dynamic'])
  let identity = 'CUSTOM HARNESS', prefix = 'You are a coding agent powered by the {{model}} model.\nFUNCTION'
  const offAncestor = world.standing.ctx.systemPrompt.section({ name: 'harness:identity', order: -1000, text: () => identity, interpolate: false })
  const agent = await world.create('dynamic-providers', {}, ctx => {
    ctx.systemPrompt.section({ name: 'deployment:persona-prefix', order: 0, text: () => prefix, interpolate: false })
  })
  assert.deepEqual(await world.texts(agent), ['CUSTOM HARNESS', '\nFUNCTION', 'TAIL'])
  identity = IDENTITY; prefix = 'CUSTOM PERSONA\nFUNCTION'
  assert.deepEqual(await world.texts(agent), ['', prefix, 'TAIL'])
  const diagnostics = world.runtime.ruleDiagnostics().records
  assert.equal(diagnostics.find(record => record.ruleId === 'preset' && record.channel === 'persona:identity:preset').identityOutcome, 'target-mismatch')
  assert.equal(diagnostics.find(record => record.ruleId === 'harness' && record.channel === 'persona:identity:harness').identityOutcome, 'matched')
  assert.equal(diagnostics.filter(record => record.channel.startsWith('persona:identity:')).reduce((sum, record) => sum + record.unavailable, 0), 0, '目标失配不属于条件缺事实')
  const { readModuleRules, editModuleRules } = await import('../../src/host/module-rules.ts')
  const dir = join(moduleRoot, 'strip-dynamic'), current = readModuleRules(dir)
  const oldObservation = diagnostics.find(record => record.ruleId === 'preset' && record.channel === 'persona:identity:preset')
  assert.equal(oldObservation.definitionRevision, current.revisions.rules.preset)
  const changed = { ...current.rules[0], then: [{ ...current.rules[0].then[0], stripDefaultIdentity: 'harness' }] }
  const saved = editModuleRules(dir, { expectedRevisions: current.revisions, edits: [{ previousId: 'preset', rule: changed }] })
  assert.notEqual(saved.revisions.rules.preset, oldObservation.definitionRevision)
  assert.equal(world.runtime.ruleDiagnostics().records.find(record => record.ruleId === 'preset' && record.channel === 'persona:identity:preset').definitionRevision, oldObservation.definitionRevision, '保存不伪造新定义的目标观测')
  await world.texts(agent)
  assert.equal(world.runtime.ruleDiagnostics().records.find(record => record.ruleId === 'preset' && record.channel === 'persona:identity:harness').definitionRevision, saved.revisions.rules.preset)
  offAncestor()
  writeModule('strip-dynamic', [persona('preset', { stripDefaultIdentity: 'preset' }), persona('peer', { prefix: 'You are a coding agent powered by the {{model}} model.\nOTHER PERSONA', complete: false })])
  assert.deepEqual(await world.texts(agent), [IDENTITY, 'You are a coding agent powered by the  model.\nOTHER PERSONA', 'TAIL'])
})

test('P4与仅修改complete的人设组合保留继承功能，重复同语义规则各自观测成功', async t => {
  writeModule('strip-inherited', [persona('first', { stripDefaultIdentity: 'preset' }), persona('second', { stripDefaultIdentity: 'preset' })])
  writeModule('open-complete', [persona('options', { complete: false })])
  const world = await personaWorld(t, () => ['strip-inherited', 'open-complete'])
  const agent = await world.create('inherited-complete', {}, ctx => { ctx.systemPrompt.section({ name: 'deployment:persona-prefix', order: 0, text: 'You are a coding agent powered by the {{model}} model.\nFUNCTION', interpolate: false, complete: true }) })
  assert.deepEqual(await world.texts(agent), [IDENTITY, '\nFUNCTION', 'TAIL'])
  for (const ruleId of ['first', 'second']) assert.equal(world.runtime.ruleDiagnostics().records.find(record => record.ruleId === ruleId && record.channel === 'persona:identity:preset').identityOutcome, 'matched')
})

test('实际插件 modulesEnabled 总闸撤回后续身份贡献且保留模块选择和规则保存', async t => {
  const { ensureModuleSeed } = await import('../../src/host/module-catalog.ts')
  const { readModuleRules, editModuleRules } = await import('../../src/host/module-rules.ts')
  const { setModuleEnabled, readStorageConfig } = await import('../../src/host/config-store.ts')
  ensureModuleSeed(moduleRoot)
  const dir = join(moduleRoot, 'limit-breaker'), current = readModuleRules(dir)
  editModuleRules(dir, { expectedRevisions: current.revisions, edits: current.rules.map(rule => ({ previousId: rule.id, rule: { ...rule, enabled: true }, settingsChanged: true })) })
  setModuleEnabled(moduleRoot, 'limit-breaker', true)
  let modulesEnabled = true
  const world = await personaWorld(t, () => [], { modulesEnabled: { get: () => modulesEnabled } })
  const agent = await world.create('full-plugin-gate', {}, ctx => { ctx.systemPrompt.section({ name: 'deployment:persona-prefix', order: 0, text: 'You are a coding agent powered by the {{model}} model.\nFUNCTION', interpolate: false }) })
  assert.deepEqual(await world.texts(agent), ['', '\nFUNCTION', 'TAIL'])
  modulesEnabled = false; world.root.emit('loader/volatile-update'); await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(await world.texts(agent), [IDENTITY, 'You are a coding agent powered by the {{model}} model.\nFUNCTION', 'TAIL'])
  assert.ok(readStorageConfig(moduleRoot).source.enabled.includes('limit-breaker'))
  assert.ok(readModuleRules(dir).rules.every(rule => rule.enabled === true))
  modulesEnabled = true; world.root.emit('loader/volatile-update'); await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(await world.texts(agent), ['', '\nFUNCTION', 'TAIL'])
})

test('同 Agent 装配串行，其他 Agent 可独立完成且每轮候选固定', async t => {
  const rules = [{ ...persona('ours', { prefix: 'A', complete: false }, { variable: { key: 'mode', value: 'A' } }),
    else: [{ id: 'fallback', kind: 'persona', prefix: 'B', complete: false }] },
    persona('strip', { stripDefaultIdentity: 'harness' }, { variable: { key: 'mode', value: 'A' } })]
  writeModule('concurrent', rules, { mode: 'A' })
  const world = await personaWorld(t, () => ['concurrent'])
  const first = await world.create('serial-first'), other = await world.create('serial-other')
  let enter, release, entered = false
  const started = new Promise(resolve => { enter = resolve })
  const gate = new Promise(resolve => { release = resolve })
  t.after(() => release())
  const off = world.root.on('system-prompt/assemble', async (assembly, context, next) => {
    if (context.agent === first && !entered) { entered = true; enter(); await gate }
    return next()
  })
  t.after(off)
  const a = world.texts(first); await started
  writeModule('concurrent', rules, { mode: 'B' })
  const b = world.texts(first)
  assert.deepEqual(await world.texts(other), [IDENTITY, 'B', 'TAIL'])
  release()
  assert.deepEqual(await a, ['', 'A', 'TAIL'])
  assert.deepEqual(await b, [IDENTITY, 'B', 'TAIL'])
})
