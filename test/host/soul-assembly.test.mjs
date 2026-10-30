import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isolatedHome } from '../fixtures/host-harness.mjs'
import { installSoulRuntime } from '../../src/runtime/soul-runtime.ts'
import { registerSoulLedgerTools } from '../../src/runtime/soul-ledger-tools.ts'
import { registerSoulStateTools } from '../../src/runtime/soul-state-tools.ts'
import { resolveModuleToolTarget } from '../../src/host/module-tool-target.ts'
import { compileRules } from '../../engine/rule-spec.mjs'
import { mountRuleSources } from '../../engine/rule-runtime.mjs'
import { SOUL_MAINTENANCE_SERVICE } from '../../engine/service-names.mjs'

const { moduleRoot } = isolatedHome('pt-soul-assembly-')

test('真实Soul装配贯通lead/promise/close与下一步SELF，陈旧快照不覆盖事实且主子隔离', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-31T00:00:00Z') })
  const id = 'assembly-soul', dir = join(moduleRoot, id)
  mkdirSync(join(dir, 'data/.soul'), { recursive: true })
  writeFileSync(join(dir, 'module.yml'), `id: ${id}\nmodules: []\nrules: []\nmoduleConfigs:\n  soul-maintenance:\n    enabled: false\n    pressureThresholds: [0.45, 0.60, 0.80]\n`)
  writeFileSync(join(dir, 'data/SELF.src.md'), '# CURRENT SKELETON')
  writeFileSync(join(dir, 'data/.soul/SELF.md'), 'STALE SNAPSHOT SHOULD NOT BE CURRENT')
  mkdirSync(join(dir, 'assets'))
  writeFileSync(join(dir, 'assets/manifest.yml'), 'dirs: []\nfiles: []\nchecks: []\n')
  const listeners = new Map(), services = new Map(), registrations = [], cleanups = [], tools = new Map()
  const ctx = {
    get: name => services.get(name), provide: (name, value) => services.set(name, value),
    effect: setup => { const off = setup(); if (off) cleanups.push(off); return off },
    inject: (_deps, callback) => ({ dispose: callback(ctx) }),
    on: (name, callback) => { const entries = listeners.get(name) ?? []; entries.push(callback); listeners.set(name, entries); return () => entries.splice(entries.indexOf(callback), 1) },
    tools: { register: tool => { tools.set(tool.name, tool); return () => tools.delete(tool.name) } },
  }
  services.set('tools', ctx.tools)
  services.set('systemPrompt', { variable: () => () => {}, context: entry => { registrations.push(entry); return () => registrations.splice(registrations.indexOf(entry), 1) } })
  const events = []
  const actor = (name, depth) => ({ id: name, ctx, session: { id: name + '-session', header: { delegationDepth: depth }, snapshotEvents: () => events } })
  const main = actor('main', 0), child = actor('child', 1)
  let measured = 44, model = 'model-a', historyReads = 0, modelCalls = 0
  main.session.requestHeader = () => ({ config: { provider: 'provider', model: 'model-a' } })
  main.session.requestContext = () => ({ provider: 'provider', model, contextWindow: 100 })
  services.set('tokenMeter', { measure: session => { assert.equal(session, main.session); return { totalTokens: measured } } })
  services.set('sessionPersistence', { open: () => { historyReads++; throw new Error('NO HISTORY ACCESS') } })
  services.set('llm', { invoke: () => { modelCalls++; throw new Error('NO MODEL CALL') } })
  const host = { root: moduleRoot, target: (exec, moduleId) => resolveModuleToolTarget(exec, moduleRoot, () => [id], moduleId), rebuild: async () => {} }
  const runtime = installSoulRuntime(ctx, host, agentId => ['main', 'child'].includes(agentId) ? [id] : [])
  const offLedger = registerSoulLedgerTools(ctx, host)
  const offState = registerSoulStateTools(ctx, host, runtime)
  const rules = compileRules([{ id: 'self', then: [{ id: 'inject', kind: 'inject-text', config: { strategy: 'placeholder', fill: 'soul-self', layer: 'runtime-context', params: { contextName: 'agent:soul-self' } } }] }], { moduleId: id })
  let offRules = mountRuleSources(ctx, [{ moduleId: id, rules }])
  t.after(() => { offRules(); offState(); offLedger(); for (const off of cleanups.reverse()) off() })
  const assemble = async (agent, signal) => {
    const assembly = { sections: [], contexts: registrations.map(entry => ({ name: entry.name, text: '' })) }
    const handlers = listeners.get('system-prompt/assemble') ?? []
    const invoke = index => index === handlers.length ? assembly : handlers[index](assembly, { agent, signal }, () => invoke(index + 1))
    await invoke(0)
    return assembly.contexts
  }
  const exec = { agent: main, signal: new AbortController().signal }
  const ledger = args => tools.get('soul_ledger').execute({ moduleId: id, ...args }, exec)
  await ledger({ action: 'append', type: 'lead', text: 'LEAD', ref: 'USER APPROVAL' })
  await ledger({ action: 'append', type: 'promise', text: 'PUBLIC PROMISE' })
  const stateTool = args => tools.get('soul_state').execute({ moduleId: id, ...args }, exec)
  await stateTool({ action: 'mark', text: 'CURRENT STATUS', expectedRevision: null })
  const files = ['data/SELF.src.md', 'data/02-soul.jsonl', 'data/.soul-ledger-v2.json', 'module.yml']
  const beforeCheck = files.map(file => readFileSync(join(dir, file), 'utf8'))
  const markedBefore = await stateTool({ action: 'status' })
  const checked = await stateTool({ action: 'check' })
  assert.equal(checked.observation.checks.find(check => check.name === 'manifest').state, 'ready')
  assert.equal(checked.observation.checks.find(check => check.name === 'self-delivered').state, 'not-observed')
  assert.deepEqual(files.map(file => readFileSync(join(dir, file), 'utf8')), beforeCheck)
  assert.deepEqual((await stateTool({ action: 'status' })).mark, markedBefore.mark)
  for (const [tokens, level] of [[44, 'normal'], [45, 'organize'], [60, 'persist'], [80, 'urgent']]) {
    measured = tokens
    assert.equal((await stateTool({ action: 'status' })).observation.pressure.level, level)
    assert.match((await assemble(main))[0].text, new RegExp(`${tokens}\\.0%`))
  }
  model = 'model-b'
  assert.equal((await stateTool({ action: 'status' })).observation.pressure.state, 'unknown')
  assert.match((await assemble(main))[0].text, /上下文水位：未知/)
  model = 'model-a'
  assert.equal(historyReads, 0)
  assert.equal(modelCalls, 0)
  const before = await assemble(main)
  assert.match(before[0].text, /未结 1/)
  assert.match(before[0].text, /main-session/)
  assert.match(before[0].text, /CURRENT SKELETON/)
  assert.doesNotMatch(before[0].text, /STALE SNAPSHOT/)
  const childText = (await assemble(child))[0].text
  assert.match(childText, /child-session/)
  assert.doesNotMatch(childText, /main-session/)
  assert.equal((await runtime.status(exec, id)).deliveredAt, null)
  t.mock.timers.tick(1000)
  await assemble(main)
  const event = { seq: 0, time: 1793404800000, type: 'user/message', data: { message: { source: { kind: 'runtime-context', form: 'snapshot', sections: before } } } }
  events.push(event)
  for (const handler of listeners.get('session/event') ?? []) await handler(main.session, event)
  assert.equal((await runtime.status(exec, id)).deliveredAt, '2026-10-31T00:00:00.000Z')
  const pending = await ledger({ action: 'list', view: 'pending' })
  await ledger({ action: 'close', targetId: pending.entries[0].id, outcome: 'completed', reason: 'KNOWN GOOD EVIDENCE' })
  assert.match((await assemble(main))[0].text, /未结 0/)
  assert.equal(services.get(SOUL_MAINTENANCE_SERVICE).status(id).state, 'disabled')
  assert.equal((await assemble(main, AbortSignal.abort()))[0].text, '')
  offRules()
  assert.deepEqual(await assemble(main), [])
  for (const off of cleanups) off()
  assert.throws(() => runtime.status(exec, id), /未参与/)
})
