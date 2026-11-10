import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
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
import * as OfficialInstructions from '../fixtures/official-instructions.mjs'

const { moduleRoot } = isolatedHome('pt-persona-registration-')
const hostBase = dirname(dirname(moduleRoot)), originalEntry = process.argv[1]
const instructionsPackage = join(hostBase, 'node_modules', '@deepseek-ai', 'dsh-agent-instructions')
mkdirSync(instructionsPackage, { recursive: true })
writeFileSync(join(instructionsPackage, 'package.json'), JSON.stringify({ type: 'module', main: 'index.mjs' }))
writeFileSync(join(instructionsPackage, 'index.mjs'), `export * from ${JSON.stringify(new URL('../fixtures/official-instructions.mjs', import.meta.url).href)}`)
process.argv[1] = join(hostBase, 'entry.mjs')
after(() => { process.argv[1] = originalEntry })
const { installPersonaCapture } = await import('../../src/runtime/persona-registration.ts')
const { createAgentAssembly } = await import('../../src/runtime/agent-assembly.ts')
const { installSoulRuntime } = await import('../../src/runtime/soul-runtime.ts')
const { resolveModuleToolTarget } = await import('../../src/host/module-tool-target.ts')
const dependencies = createRequire(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-agent-preset-registry'))
const { default: Loader } = await import(pathToFileURL(dependencies.resolve('@deepseek-ai/cordis-plugin-loader')).href)
const { default: SessionProjections } = await import(pathToFileURL(dependencies.resolve('@deepseek-ai/dsh-session-projection')).href)
const IDENTITY = 'You are an AI agent powered by DeepSeek Harness.'
const instructionDeliveries = OfficialInstructions.deliveries
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
  root.loader.import = (name, ...args) => name === '@deepseek-ai/dsh-persona' ? OfficialPersona
    : name === '@deepseek-ai/dsh-agent-instructions' ? OfficialInstructions : originalImport(name, ...args)
  await root.loader.create({ id: 'adapter', name: 'cordis:adapter' }); await root.loader.await()
  root.provide('tools', {}); root.provide('llm', {}); root.provide('workingDirectory', {}); root.provide('fs', {})
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

test('通用预设去身份覆盖来源的 helpful engineer 句且保留模式纪律和工具', async t => {
  writeModule('strip-engineer', [persona('identity', { stripDefaultIdentity: 'preset' })])
  const world = await personaWorld(t, () => ['strip-engineer'])
  world.root.systemPrompt.section({ name: 'tool:engineer', order: 500, text: 'KEEP TOOLS' })
  const agent = await world.create('strip-engineer-agent', {}, ctx => {
    ctx.systemPrompt.section({ name: 'deployment:persona-prefix', order: 0,
      text: 'You are a helpful software engineer assistant.\n\n- Thinking Disruption:\nKEEP DISCIPLINE', interpolate: false })
  })
  assert.deepEqual(await world.texts(agent), [IDENTITY, '\n\n- Thinking Disruption:\nKEEP DISCIPLINE', 'KEEP TOOLS', 'TAIL'])
  assert.equal(world.runtime.ruleDiagnostics().records.find(record => record.ruleId === 'identity' && record.channel === 'persona:identity:preset').identityOutcome, 'matched')
})

test('来源规则由普通预设事实决定，主子切换及缺事实撤回，不按名称分叉引擎', async t => {
  const { readFileSync } = await import('node:fs')
  const { parse } = await import('yaml')
  const builtin = parse(readFileSync(new URL('../../modules/limit-breaker/module.yml', import.meta.url), 'utf8'))
  const rules = builtin.rules.filter(rule => ['purge-43', 'purge-71', 'purge-76'].includes(rule.id)).map(rule => ({ ...rule, enabled: true }))
  writeModule('preset-identities', rules)
  const world = await personaWorld(t, () => ['preset-identities'])
  const selections = new WeakMap()
  world.root.provide('agentPresets', { composedPreset: ctx => selections.get(ctx) })
  const mixed = 'You are a helpful software engineer assistant.\nKEEP DISCIPLINE'
  const setup = ctx => { ctx.systemPrompt.section({ name: 'deployment:persona-prefix', order: 0, text: mixed, interpolate: false }) }
  const main = await world.create('preset-identity-main', { agentPreset: 'unrestricted' }, setup)
  const child = await world.create('preset-identity-child', { delegationDepth: 1, agentPreset: 'standard' }, setup)
  for (const preset of ['standard', 'ptc', 'cordis', 'minimal', 'liangshen', 'unrestricted']) {
    selections.set(main.ctx, preset)
    selections.set(child.ctx, 'custom')
    const [mainText, childText] = await Promise.all([world.texts(main), world.texts(child)])
    assert.deepEqual(mainText, [IDENTITY, '\nKEEP DISCIPLINE', 'TAIL'], preset)
    assert.deepEqual(childText, [IDENTITY, mixed, 'TAIL'], '真实当前预设优先于出生header，子代理不串用主事实')
  }
  selections.delete(main.ctx)
  assert.deepEqual(await world.texts(main), [IDENTITY, mixed, 'TAIL'])
  assert.equal(world.runtime.ruleDiagnostics().records.find(record => record.ruleId === 'purge-76' && record.channel === 'persona:identity:preset').identityOutcome, 'condition-unavailable')
  selections.set(main.ctx, 'unrestricted')
  writeModule('preset-identities', rules.map(rule => ({ ...rule, enabled: false })))
  assert.deepEqual(await world.texts(main), [IDENTITY, mixed, 'TAIL'])
})

test('所选完整正文随complete配置首次装配一次，追加冲突拒绝保旧，关闭恢复', async t => {
  const { readFileSync } = await import('node:fs')
  const { createHash } = await import('node:crypto')
  const { parse } = await import('yaml')
  const builtin = parse(readFileSync(new URL('../../modules/limit-breaker/module.yml', import.meta.url), 'utf8'))
  const open = { ...builtin.rules.find(rule => rule.id === 'purge-40'), enabled: true }
  const exact = JSON.parse(readFileSync(new URL('../../modules/limit-breaker/assets/prompts/default-prompt-inject.json', import.meta.url), 'utf8')).text
  assert.equal(Buffer.byteLength(exact), 25128)
  assert.equal(createHash('sha256').update(exact).digest('hex'), '1757f1774457b448323ba036ec177c3c638d2a6dc97c9aa8ca2a1cc3e07528bc')
  const inject = { id: 'selected-body', if: { variable: { key: 'selected', value: 'yes' } }, then: [
    { id: 'body', kind: 'inject-text', config: { layer: 'system-section', strategy: 'static', text: exact } },
  ] }
  writeModule('complete-source', [open, inject], { selected: 'yes' })
  const world = await personaWorld(t, () => ['complete-source'])
  const main = await world.create('complete-source-main'), child = await world.create('complete-source-child', { delegationDepth: 1 })
  for (const agent of [main, child]) {
    const text = renderPrompt(await world.assembly(agent))
    assert.equal(text.split(exact).length - 1, 1, '首次实际官方装配保留所选精确正文一次')
    assert.ok(text.includes('OFFICIAL'))
  }
  writeModule('complete-source', [open, inject, persona('exclusive', { prefix: 'REJECT', complete: true })], { selected: 'yes' })
  await assert.rejects(world.runtime.refresh(), /conflict|冲突/)
  assert.equal(renderPrompt(await world.assembly(main)).split(exact).length - 1, 1, '非法完整候选保旧')
  writeModule('complete-source', [persona('exclusive', { prefix: 'UNIQUE', complete: true }), { id: 'append', then: [
    { id: 'append', kind: 'assembly', target: { sections: { append: [{ name: 'deployment:persona-prefix', text: 'REJECT APPEND' }] } } },
  ] }], { selected: 'yes' })
  await assert.rejects(world.runtime.refresh(), /append|追加|冲突/)
  assert.equal(renderPrompt(await world.assembly(main)).split(exact).length - 1, 1)
  writeModule('complete-source', [open, inject], { selected: 'no' })
  assert.ok(!renderPrompt(await world.assembly(main)).includes(exact), '所选正文条件失配撤回')
  writeModule('complete-source', [{ ...open, enabled: false }, inject], { selected: 'yes' })
  assert.deepEqual(await world.texts(main), ['OFFICIAL'], '关闭P40恢复官方complete，普通系统段按原生规则裁掉')
})

test('通用官方指令预算在首次请求前挂载，复用原owner，冲突保旧且主子关闭独立', async t => {
  const rules = [persona('instructions', { instructionMaxBytes: 65536, complete: false }, { variable: { key: 'selected', value: 'yes' } })]
  writeModule('official-instructions', rules, { selected: 'yes' })
  const world = await personaWorld(t, () => ['official-instructions'])
  const main = await world.create('instructions-main'), child = await world.create('instructions-child', { delegationDepth: 1 })
  const step = async agent => {
    await world.assembly(agent)
    return world.root.waterfall(scopeTarget(agent, scopeOf(agent.ctx)), 'agent/pre-step', { agent, messages: [], step: 1, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [] }))
  }
  assert.equal((await step(main)).messages.length, 1)
  assert.deepEqual(instructionDeliveries.get(main), [65536])
  assert.equal((await step(child)).messages.length, 1)
  writeModule('official-instructions', [persona('instructions', { instructionMaxBytes: 32768, complete: false })], { selected: 'yes' })
  assert.equal((await step(main)).messages.length, 1, '预算替换不让新旧owner重复投递')
  assert.equal(instructionDeliveries.get(main).at(-1), 32768)
  writeModule('official-instructions', rules, { selected: 'yes' })
  writeModule('official-instructions', [...rules, persona('conflict', { instructionMaxBytes: 32 })], { selected: 'yes' })
  await assert.rejects(world.runtime.refresh(), /instructionMaxBytes|冲突/)
  assert.equal((await step(main)).messages.length, 1)
  assert.deepEqual(instructionDeliveries.get(main), [65536, 32768, 32768], '冲突保留上次预算与整份贡献')
  writeModule('official-instructions', rules, { selected: 'yes' })
  const original = world.standing.ctx.plugin(OfficialInstructions, { maxBytes: 1234 }); await original
  assert.equal((await step(main)).messages.length, 1, '晚到原owner优先，不重复投递或改用户预算')
  assert.equal(instructionDeliveries.get(main).at(-1), 1234)
  writeModule('official-instructions', rules, { selected: 'no' })
  assert.equal((await step(main)).messages.length, 1, '关闭只撤本来源，原owner仍投递')
  assert.equal(instructionDeliveries.get(main).at(-1), 1234)
  await original.dispose()
  assert.equal((await step(main)).messages.length, 0, '释放原owner后关闭态不复活')
  assert.equal((await step(child)).messages.length, 0)
  writeModule('official-instructions', rules, { selected: 'yes' })
  const sameScope = await main.ctx.plugin(OfficialInstructions, { maxBytes: 2468 })
  assert.equal((await step(main)).messages.length, 1)
  assert.equal(instructionDeliveries.get(main).at(-1), 2468, '同scope原owner优先')
  await sameScope.dispose()
  assert.equal((await step(main)).messages.length, 1, '释放原owner后仍命中才创建本来源owner')
  assert.equal(instructionDeliveries.get(main).at(-1), 65536)
  await world.runtime.dispose()
  assert.equal((await world.root.waterfall(scopeTarget(main, scopeOf(main.ctx)), 'agent/pre-step', { agent: main }, async () => ({ kind: 'enter', messages: [] }))).messages.length, 0)
})

test('官方指令服务晚到继续沿inject挂载，关闭等待中的owner不复活', async t => {
  let offFs
  const lateRoot = new Context()
  t.after(() => lateRoot.fiber.dispose())
  lateRoot.provide('agents', {}); lateRoot.provide('workingDirectory', {})
  const { createPersonaInstructions } = await import('../../src/runtime/persona-instructions.ts')
  const diagnostics = [], adapter = createPersonaInstructions(lateRoot, value => diagnostics.push(value))
  const agent = { id: 'late-budget-agent', session: {} }; agent.ctx = createScope(lateRoot, agent).ctx
  t.after(() => adapter.dispose())
  await (await adapter.prepare(agent, 65536))?.commit()
  assert.match(diagnostics.at(-1), /等待/)
  offFs = lateRoot.plugin({ apply(ctx) { ctx.provide('fs', {}) } }); await offFs
  await new Promise(resolve => setImmediate(resolve))
  await (await adapter.prepare(agent, 65536))?.commit()
  const deliver = () => lateRoot.waterfall(scopeTarget(agent, scopeOf(agent.ctx)), 'agent/pre-step', { agent }, async () => ({ kind: 'enter', messages: [] }))
  assert.equal((await deliver()).messages.length, 1)
  await offFs.dispose()
  await (await adapter.prepare(agent, undefined))?.commit()
  await lateRoot.plugin({ apply(ctx) { ctx.provide('fs', {}) } })
  assert.equal((await deliver()).messages.length, 0, '等待中的已关闭owner不因服务恢复复活')
})

test('人设注册失败回滚新指令owner，既有完整贡献继续生效', async t => {
  writeModule('atomic-instructions', [persona('body', { prefix: 'OLD', complete: false })])
  const world = await personaWorld(t, () => ['atomic-instructions'])
  const agent = await world.create('atomic-instruction-agent')
  assert.ok((await world.texts(agent)).includes('OLD'))
  const original = world.root.systemPrompt.section
  t.mock.method(world.root.systemPrompt, 'section', function (section) {
    if (section.text === 'FAIL') throw new Error('PERSONA REGISTER FAILURE')
    return original.call(this, section)
  })
  writeModule('atomic-instructions', [persona('body', { prefix: 'FAIL', instructionMaxBytes: 65536, complete: false })])
  await world.runtime.refresh()
  assert.ok((await world.texts(agent)).includes('OLD'))
  assert.ok(world.warnings.some(text => text.includes('PERSONA REGISTER FAILURE')))
  const result = await world.root.waterfall(scopeTarget(agent, scopeOf(agent.ctx)), 'agent/pre-step', { agent }, async () => ({ kind: 'enter', messages: [] }))
  assert.equal(result.messages.length, 0, '被拒候选不能留指令owner')
})

test('官方指令晚到初始化失败撤候选，原预算owner恢复且关闭不复活', async t => {
  const root = new Context(); root.provide('agents', {}); root.provide('workingDirectory', {})
  let fs = root.plugin({ apply(ctx) { ctx.provide('fs', {}) } }); await fs
  const { createPersonaInstructions } = await import('../../src/runtime/persona-instructions.ts')
  const diagnostics = [], adapter = createPersonaInstructions(root, text => diagnostics.push(text))
  const agent = { id: 'late-failure', session: {} }; agent.ctx = createScope(root, agent).ctx
  t.after(async () => { OfficialInstructions.failingBudgets.clear(); await adapter.dispose(); await root.fiber.dispose() })
  await (await adapter.prepare(agent, 65536))?.commit()
  await fs.dispose()
  OfficialInstructions.failingBudgets.add(32768)
  const waiting = await adapter.prepare(agent, 32768); await waiting?.commit()
  fs = root.plugin({ apply(ctx) { ctx.provide('fs', {}) } }); await fs
  await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve))
  const deliver = () => root.waterfall(scopeTarget(agent, scopeOf(agent.ctx)), 'agent/pre-step', { agent }, async () => ({ kind: 'enter', messages: [] }))
  const actual = await deliver()
  assert.equal(actual.messages.length, 1, '晚到失败不屏蔽已接受的旧owner')
  assert.equal(instructionDeliveries.get(agent).at(-1), 65536)
  assert.ok(diagnostics.some(text => text.includes('LATE OFFICIAL INIT FAILURE')))
  await (await adapter.prepare(agent, undefined))?.commit()
  await fs.dispose(); await root.plugin({ apply(ctx) { ctx.provide('fs', {}) } })
  assert.equal((await deliver()).messages.length, 0)
})

test('等待官方指令的NEW人设不提前生效，晚到抛错后仍保持OLD', async t => {
  const root = new Context(); await root.plugin(SystemPrompt)
  root.provide('agents', {}); root.provide('workingDirectory', {})
  const agent = { id: 'joint-late', session: { id: 'joint-late', header: {}, snapshotEvents: () => [] } }; agent.ctx = createScope(root, agent).ctx
  const { createPersonaInstructions } = await import('../../src/runtime/persona-instructions.ts')
  const { createRuleRuntime } = await import('../../engine/rule-runtime.mjs'), { compileRules } = await import('../../engine/rule-spec.mjs')
  const errors = [], adapter = createPersonaInstructions(root, text => errors.push(text)), runtime = createRuleRuntime(agent.ctx, { agent, externalAssembly: true })
  t.after(async () => { OfficialInstructions.failingBudgets.clear(); runtime.dispose(); await adapter.dispose(); await root.fiber.dispose() })
  const source = (prefix, budget) => [{ moduleId: 'source', rules: compileRules([persona('identity', { prefix, complete: false, ...(budget === undefined ? {} : { instructionMaxBytes: budget }) })]) }]
  const context = { agent, scope: scopeOf(agent.ctx) }, text = async () => (await agent.ctx.get('systemPrompt').assemble(context)).sections.find(section => section.name === 'deployment:persona-prefix').text
  runtime.replace(source('OLD')); runtime.prepareAssembly(context)
  runtime.replace(source('NEW', 32768)); OfficialInstructions.failingBudgets.add(32768)
  await runtime.prepareAssembly(context, value => adapter.prepare(agent, value))
  assert.equal(await text(), 'OLD', 'PENDING不能提前接受NEW')
  await root.plugin({ apply(ctx) { ctx.provide('fs', {}) } })
  await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve))
  assert.ok(errors.some(value => value.includes('LATE OFFICIAL INIT FAILURE')))
  assert.equal(await text(), 'OLD', '晚到失败未发布任何NEW片段')
  await assert.rejects(runtime.prepareAssembly(context, value => adapter.prepare(agent, value)), /LATE OFFICIAL INIT FAILURE/)
  assert.equal(await text(), 'OLD')
})

test('普通phase事实重判人设与首阶段注入，成功压缩重置而失败压缩不重置', async t => {
  writeModule('phase-persona', [persona('phase', { prefix: 'PHASE ONE', complete: false }, { phase: { promoted: false, includeSubagents: true, subscribe: false } })])
  const world = await personaWorld(t, () => ['phase-persona'])
  const agent = await world.create('ordinary-phase-agent'), events = []
  agent.session.snapshotEvents = () => events
  assert.ok((await world.texts(agent)).includes('PHASE ONE'))
  events.push({ type: 'assistant/message', seq: 0, data: { content: [] } })
  assert.deepEqual(await world.texts(agent), ['OFFICIAL'])
  events.push({ type: 'compaction/end', seq: 1, data: { error: 'FAILED' } })
  assert.deepEqual(await world.texts(agent), ['OFFICIAL'])
  events.push({ type: 'compaction/end', seq: 2, data: {} })
  assert.ok((await world.texts(agent)).includes('PHASE ONE'))
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
  const identityRules = rules => rules.filter(rule => ['purge-4', 'purge-25'].includes(rule.id))
  editModuleRules(dir, { expectedRevisions: current.revisions, edits: identityRules(current.rules).map(rule => ({ previousId: rule.id, rule: { ...rule, enabled: true }, settingsChanged: true })) })
  setModuleEnabled(moduleRoot, 'limit-breaker', true)
  let modulesEnabled = true
  const world = await personaWorld(t, () => [], { modulesEnabled: { get: () => modulesEnabled } })
  const agent = await world.create('full-plugin-gate', {}, ctx => { ctx.systemPrompt.section({ name: 'deployment:persona-prefix', order: 0, text: 'You are a coding agent powered by the {{model}} model.\nFUNCTION', interpolate: false }) })
  assert.deepEqual(await world.texts(agent), ['', '\nFUNCTION', 'TAIL'])
  modulesEnabled = false; world.root.emit('loader/volatile-update'); await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(await world.texts(agent), [IDENTITY, 'You are a coding agent powered by the {{model}} model.\nFUNCTION', 'TAIL'])
  assert.ok(readStorageConfig(moduleRoot).source.enabled.includes('limit-breaker'))
  const saved = readModuleRules(dir).rules
  assert.ok(identityRules(saved).every(rule => rule.enabled === true))
  assert.ok(saved.filter(rule => !['purge-4', 'purge-25'].includes(rule.id)).every(rule => rule.enabled === false))
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
