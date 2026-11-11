import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { createScope } from '@deepseek-ai/dsh-scope'
import { createRequire } from 'node:module'
import { compileRules } from '../../engine/rule-spec.mjs'
import { createRuleRuntime } from '../../engine/rule-runtime.mjs'

const require = createRequire(import.meta.url)
const { ToolResultPruner } = require('@deepseek-ai/dsh-compaction-tool-result-pruner')
const repeatOwner = require('@deepseek-ai/dsh-repeat-tool-reminder')
const original = { seq: 1, type: 'tool/result', data: { message: { role: 'tool', source: { callId: 'c1' }, content: [{ type: 'text', text: '0123456789'.repeat(10) }] } } }

async function deadline(promise) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('official owner test timed out')), 5000) })]) }
  finally { clearTimeout(timer) }
}

test('compiled repeat rule preserves other decisions, cancellation and later native reminders', async t => {
  const root = new Context()
  let scope, runtime
  t.after(async () => { runtime?.dispose(); await scope?.dispose(); await root.fiber.dispose() })
  await root.plugin(SystemPrompt)
  const agent = { id: 'repeat-waterfall', session: { id: 'repeat-waterfall', header: {}, snapshotEvents: () => [] } }
  scope = createScope(root, agent); agent.ctx = scope.ctx
  const makeRules = enabled => compileRules([{ id: 'repeat', enabled, then: [{ id: 'gate', kind: 'host-control', capability: 'repeat-tool-reminder', value: true }] }])
  await root.plugin({ name: 'repeat-runtime', apply: () => {
    runtime = createRuleRuntime(scope.ctx, { agent, externalAssembly: true })
    runtime.replace([{ moduleId: 'repeat', rules: makeRules(false) }])
    return () => runtime.dispose()
  } })
  await agent.ctx.plugin(repeatOwner, { thresholds: [3, 6, 9, 12], include: [], exclude: [], argumentsPreviewChars: 50 })
  const exec = { agent, name: 'echo', arguments: { value: 1 }, signal: new AbortController().signal }, other = { source: { kind: 'other' } }
  runtime.prepareAssembly({ agent })
  const next = () => ({ kind: 'stop', additionalContexts: [other] })
  const call = () => root.waterfall('tools/post-execute', exec, {}, next)
  for (let i = 0; i < 2; i++) assert.deepEqual((await call()).additionalContexts, [other])
  assert.equal((await call()).additionalContexts[0].source.kind, 'repeat-tool-reminder')
  runtime.replace([{ moduleId: 'repeat', rules: makeRules(true) }]); runtime.prepareAssembly({ agent })
  await call(); await call(); const enabled = await call()
  assert.equal(enabled.kind, 'stop')
  assert.deepEqual(enabled.additionalContexts, [other])
  await call(); await call()
  const controller = new AbortController()
  let enteredResolve, release
  const entered = new Promise(resolve => { enteredResolve = resolve })
  const pending = root.waterfall('tools/post-execute', { ...exec, signal: controller.signal }, {}, () => {
    const terminal = new Promise(resolve => { release = resolve })
    enteredResolve()
    return terminal
  })
  await deadline(entered)
  controller.abort()
  release(next())
  const cancelled = await deadline(pending)
  assert.equal(cancelled.kind, 'stop')
  assert.deepEqual(cancelled.additionalContexts.map(value => value.source.kind), ['repeat-tool-reminder', 'other'])
  runtime.replace([{ moduleId: 'repeat', rules: makeRules(false) }]); runtime.prepareAssembly({ agent })
  await call(); await call(); const restored = await call()
  assert.equal(restored.additionalContexts[0].source.kind, 'repeat-tool-reminder')
  assert.deepEqual(restored.additionalContexts.slice(1), [other])
  assert.equal(restored.kind, 'stop')
})

test('compiled pruner policy handles conditions, late owners and disposal', async t => {
  const root = new Context()
  let runtime
  t.after(async () => { runtime?.dispose(); await root.fiber.dispose() })
  root.provide('tokenMeter', { estimateMessage: () => 1 })
  const plugin = await root.plugin({ name: 'official-pruner-fixture', apply: ctx => { new ToolResultPruner(ctx, { thresholdChars: 50, headChars: 5, tailChars: 5 }); return () => {} } })
  const owner = root.get('toolResultPruner')
  const session = { id: 'runtime-session', header: {}, surface: { nodes: [1] }, eventAt: () => original,
    deriveEventMessage: event => event.data.message, append: () => ({ seq: 2 }) }
  const agent = { id: 'runtime-agent', session }
  const rules = compileRules([{ id: 'pruner', enabled: true, if: { scope: { audience: 'subagent' } }, then: [{ id: 'gate', kind: 'host-control', capability: 'compaction-tool-result-pruner', value: true }] }])
  const runtimePlugin = await root.plugin({ name: 'runtime-fixture', apply: ctx => {
    runtime = createRuleRuntime(ctx, { agent, externalAssembly: true })
    runtime.replace([{ moduleId: 'runtime', rules }])
    return () => runtime.dispose()
  } })
  runtime.prepareAssembly({ agent })
  assert.equal(owner.pruneSession(session).pruned.length, 1, 'false audience condition keeps native pruning')
  runtime.replace([{ moduleId: 'runtime', rules: compileRules([{ id: 'pruner', enabled: true, then: [{ id: 'gate', kind: 'host-control', capability: 'compaction-tool-result-pruner', value: true }] }]) }])
  runtime.prepareAssembly({ agent })
  assert.deepEqual(owner.pruneSession(session), { pruned: [], charsRemoved: 0 })
  runtime.dispose()
  await runtimePlugin.dispose()
  await plugin.dispose()
  let lateRuntime
  const latePlugin = await root.plugin({ name: 'late-runtime', apply: ctx => {
    lateRuntime = createRuleRuntime(ctx, { agent, externalAssembly: true })
    lateRuntime.replace([{ moduleId: 'runtime', rules: compileRules([{ id: 'pruner', then: [{ id: 'gate', kind: 'host-control', capability: 'compaction-tool-result-pruner', value: true }] }]) }])
    return () => lateRuntime.dispose()
  } })
  lateRuntime.prepareAssembly({ agent })
  assert.equal(root.get('toolResultPruner'), undefined)
  const lateOfficial = await root.plugin({ name: 'late-official', apply: ctx => { new ToolResultPruner(ctx, { thresholdChars: 50, headChars: 5, tailChars: 5 }); return () => {} } })
  lateRuntime.prepareAssembly({ agent })
  assert.deepEqual(root.get('toolResultPruner').pruneSession(session), { pruned: [], charsRemoved: 0 })
  await lateOfficial.dispose()
  lateRuntime.prepareAssembly({ agent })
  assert.equal(root.get('toolResultPruner'), undefined)
  const restoredOfficial = await root.plugin({ name: 'restored-official', apply: ctx => { new ToolResultPruner(ctx, { thresholdChars: 50, headChars: 5, tailChars: 5 }); return () => {} } })
  lateRuntime.prepareAssembly({ agent })
  assert.deepEqual(root.get('toolResultPruner').pruneSession(session), { pruned: [], charsRemoved: 0 })
  lateRuntime.dispose()
  assert.equal(root.get('toolResultPruner').pruneSession(session).pruned.length, 1)
  await restoredOfficial.dispose(); await latePlugin.dispose()
})

test('one shared official pruner isolates two production runtimes by session', async t => {
  const root = new Context(); root.provide('tokenMeter', { estimateMessage: () => 1 })
  t.after(async () => { await root.fiber.dispose() })
  const plugin = await root.plugin({ name: 'official-pruner-fixture', apply: ctx => { new ToolResultPruner(ctx, { thresholdChars: 50, headChars: 5, tailChars: 5 }); return () => {} } })
  const owner = root.get('toolResultPruner')
  const make = id => ({ id, header: {}, surface: { nodes: [1] }, eventAt: () => original, deriveEventMessage: event => event.data.message, append: () => ({ seq: 2 }) })
  const a = make('a'), b = make('b'), agentA = { id: 'a', session: a }, agentB = { id: 'b', session: b }
  const rules = compileRules([{ id: 'p', enabled: true, then: [{ id: 'g', kind: 'host-control', capability: 'compaction-tool-result-pruner', value: true }] }])
  const scopeA = createScope(root, agentA), scopeB = createScope(root, agentB); agentA.ctx = scopeA.ctx; agentB.ctx = scopeB.ctx
  let runtimeA, runtimeB
  const runtimes = await root.plugin({ name: 'runtime-pair-fixture', apply: () => {
    runtimeA = createRuleRuntime(scopeA.ctx, { agent: agentA, externalAssembly: true }); runtimeB = createRuleRuntime(scopeB.ctx, { agent: agentB, externalAssembly: true })
    runtimeA.replace([{ moduleId: 'a', rules }]); runtimeB.replace([{ moduleId: 'b', rules: compileRules([{ id: 'p', enabled: false, then: [{ id: 'g', kind: 'host-control', capability: 'compaction-tool-result-pruner', value: true }] }]) }])
    return () => { runtimeA.dispose(); runtimeB.dispose() }
  } })
  runtimeA.prepareAssembly({ agent: agentA }); runtimeB.prepareAssembly({ agent: agentB })
  assert.deepEqual(owner.pruneSession(a), { pruned: [], charsRemoved: 0 })
  assert.equal(owner.pruneSession(b).pruned.length, 1)
  runtimeA.dispose(); assert.equal(owner.pruneSession(b).pruned.length, 1)
  await runtimes.dispose(); await scopeA.dispose(); await scopeB.dispose(); await plugin.dispose(); await root.fiber.dispose()
})

test('real assembly suppresses dependent body until the official repeat owner is mounted', async t => {
  const root = new Context()
  await root.plugin(SystemPrompt)
  t.after(async () => { await root.fiber.dispose() })
  const agent = { id: 'repeat-assembly-agent', session: { id: 'repeat-assembly-session', header: {}, snapshotEvents: () => [] } }
  const scope = createScope(root, agent); agent.ctx = scope.ctx
  const diagnostics = []
  const runtime = createRuleRuntime(scope.ctx, { agent, externalAssembly: true, onOutcome: value => diagnostics.push(value) })
  const dependent = 'TARGET-ONLY BODY', independent = 'OTHER BODY'
  const rules = compileRules([{ id: 'nested', then: [{ if: { scope: { audience: 'main' } }, then: [
    { id: 'guard', kind: 'host-control', capability: 'repeat-tool-reminder', value: true },
    { id: 'dependent', kind: 'inject-text', config: { layer: 'system-section', text: dependent } },
  ] }, { id: 'independent', kind: 'inject-text', config: { layer: 'system-section', text: independent } }] }])
  const render = () => root.systemPrompt.assemble({ agent, scope: agent })
  const has = (assembly, text) => assembly.sections.some(section => section.text?.includes(text))
  const runtimePlugin = await root.plugin({ name: 'runtime-assembly-fixture', apply: () => { runtime.replace([{ moduleId: 'repeat-assembly', rules }]); return () => runtime.dispose() } })
  assert.equal(has(await render(), dependent), false)
  assert.equal(has(await render(), independent), true)
  const repeatPlugin = await agent.ctx.plugin(repeatOwner, { thresholds: [3], include: [], exclude: [], argumentsPreviewChars: 50 })
  runtime.prepareAssembly({ agent })
  assert.equal(has(await render(), dependent), true)
  await repeatPlugin.dispose()
  runtime.prepareAssembly({ agent })
  assert.equal(has(await render(), dependent), false)
  await runtimePlugin.dispose(); runtime.dispose(); await scope.dispose()
})
