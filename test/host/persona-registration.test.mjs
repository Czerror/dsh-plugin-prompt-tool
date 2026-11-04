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
async function personaWorld(t, enabled) {
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
  const runtime = createAgentAssembly(root, { moduleRoot, enabledModules: enabled, personaCapture: capture, warn: text => warnings.push(text) })
  const moduleIds = id => runtime.moduleIds(id)
  installSoulRuntime(root, { root: moduleRoot, target: (exec, id) => resolveModuleToolTarget(exec, moduleRoot, moduleIds, id),
    rebuild: id => runtime.refresh(id) }, moduleIds, () => sessions)
  t.after(async () => { await runtime.dispose(); for (const handle of handles.reverse()) await handle.dispose(); await standing.dispose(); await root.fiber.dispose() })
  const assembly = agent => agent.ctx.systemPrompt.assemble({ scope: scopeOf(agent.ctx), agent })
  return { root, runtime, warnings, assembly, texts: async agent => (await assembly(agent)).sections.map(section => section.text),
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

test('同 Agent 装配串行，其他 Agent 可独立完成且每轮候选固定', async t => {
  const rules = [{ ...persona('ours', { prefix: 'A', complete: false }, { variable: { key: 'mode', value: 'A' } }),
    else: [{ id: 'fallback', kind: 'persona', prefix: 'B', complete: false }] }]
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
  assert.deepEqual(await a, [IDENTITY, 'A', 'TAIL'])
  assert.deepEqual(await b, [IDENTITY, 'B', 'TAIL'])
})
