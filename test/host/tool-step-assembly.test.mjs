import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createScope, scopeTarget } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import * as native from '@deepseek-ai/dsh-tool-executor-native'
import * as ptc from '@deepseek-ai/dsh-tool-executor-ptc'
import { apply as applyCustomTools } from '../../engine/tool-config-engine.mjs'
import { sdkToolNames } from '../../engine/sdk-strip.mjs'
import { compileRules } from '../../engine/rule-spec.mjs'
import { mountRuleSources } from '../../engine/rule-runtime.mjs'
import { createDiscoveryRegistry } from '../../engine/discovery.mjs'
import { isolatedHome } from '../fixtures/host-harness.mjs'

const { moduleRoot } = isolatedHome('pt-tool-step-')
const { createAgentAssembly } = await import('../../src/runtime/agent-assembly.ts')

async function harness(t, rules = [{ id: 'narrow', then: [{ id: 'allow', kind: 'tool-visibility', allow: ['keep'] }] }], modules = ['rule-engine']) {
  const root = new Context()
  await root.plugin(SystemPrompt)
  await root.plugin(Tools)
  await root.plugin(native)
  const rawTools = root.get('tools')
  root.provide('llm', {})
  root.provide('promptToolDiscovery', createDiscoveryRegistry())
  const agents = []
  root.provide('agents', { list: () => agents })
  const id = 'step-surface'
  mkdirSync(join(moduleRoot, id), { recursive: true })
  const write = (rows = modules) => writeFileSync(join(moduleRoot, id, 'module.yml'), JSON.stringify({ id, name: id, modules: rows, rules }))
  write()
  const warnings = []
  const runtime = createAgentAssembly(root, { moduleRoot, enabledModules: () => [id], warn: error => warnings.push(String(error)) })
  t.after(async () => { await runtime.dispose(); await root.fiber.dispose() })
  const agent = { id: 'step-agent', options: { model: 'next' }, model: { current: () => ({ model: 'next' }) },
    session: { id: 'step-agent', header: {}, snapshotEvents: () => [], append() {} } }
  agent.ctx = createScope(root, agent).ctx
  agents.push(agent)
  await root.serial(scopeTarget(agent, agent), 'agent/created', { agent, source: 'startup' })
  let calls = 0, conditions = 0
  const registrations = new Map()
  for (const name of ['keep', 'hidden', 'unavailable']) registrations.set(name, root.tools.register({ name, description: name,
    parameters: { type: 'object', properties: {} }, output: { schema: { type: 'object' }, render: () => [] },
    execute: () => { calls++; return { name } },
  }, { when: () => { conditions++; return name !== 'unavailable' } }))
  let services
  await agent.ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(ctx) { services = { tools: ctx.tools, prompt: ctx.systemPrompt } } })
  const signal = new AbortController().signal
  const context = { agent, scope: agent, signal, modelSelection: { model: 'deepseek-pro' } }
  const execute = (toolSet, name = 'keep', tools = services.tools) => tools.execute({ agent, signal, toolSet,
    calls: [{ type: 'tool-call', id: 'call', name, arguments: '{}' }],
  })
  return { root, rawTools, runtime, agent, services, context, execute, write, warnings, registrations, counts: () => ({ calls, conditions }) }
}

test('公开 resolve/assemble 后置收窄最终声明与实际执行，官方 when 只算一次', async t => {
  const h = await harness(t)
  h.root.provide('pt-module-rule-tools', { mount: ctx => ctx.tools.register({ name: 'fresh', description: 'fresh',
    parameters: { type: 'object', properties: {} }, output: { schema: { type: 'object' }, render: () => [] }, execute: () => ({}),
  }) })
  h.write(['rule-engine', 'module-rule-tools'])
  h.runtime.schedule('step-surface')
  const toolSet = await h.services.tools.resolve(h.context)
  assert.equal(toolSet.view(h.agent).has('fresh'), true, `ensureFresh 在原 resolve 前挂载新增定义: ${h.warnings}`)
  const result = await h.services.prompt.assemble({ ...h.context, toolSet })
  assert.deepEqual(result.tools.map(tool => tool.name), ['keep'])
  assert.deepEqual((await h.execute(toolSet)).results[0].result.value, { name: 'keep' })
  assert.equal((await h.execute(toolSet, 'hidden')).results[0].result.isError, true)
  assert.equal((await h.execute(toolSet, 'unavailable')).results[0].result.isError, true)
  assert.deepEqual(h.counts(), { calls: 1, conditions: 3 })
  const off = h.root.tools.register({ name: 'replacement', description: 'replacement', parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'object' }, render: () => [] }, execute: () => ({}),
  })
  assert.equal(toolSet.view(h.agent).has('replacement'), false, '封存不添加新注册')
  off()
  h.registrations.get('keep')()
  assert.equal(toolSet.view(h.agent).has('keep'), false, '原集合移除始终是封存准入的上限')
  assert.equal((await h.execute(toolSet)).results[0].result.isError, true)
  assert.equal(h.counts().calls, 1)
  toolSet.dispose()
})

test('运行上下文替句保留官方refresh和已接受步骤，热更新及关闭只影响后续步骤', async t => {
  const rules = [{ id: 'policy', then: [{ id: 'policy', kind: 'assembly', target: { contexts: { replace: [
    { name: 'approval:policy', match: 'ORIGINAL POLICY', text: 'FIRST POLICY' },
  ] } } }] }]
  const h = await harness(t, rules)
  let suffix = 'ONE'
  h.root.systemPrompt.context({ name: 'approval:policy', order: 20, required: true, text: () => `BEFORE ORIGINAL POLICY ${suffix}` })
  const render = async () => {
    const set = await h.services.tools.resolve(h.context)
    return { set, assembly: await h.services.prompt.assemble({ ...h.context, toolSet: set }) }
  }
  const text = assembly => assembly.contexts.find(entry => entry.name === 'approval:policy').text
  const first = await render()
  assert.equal(text(first.assembly), 'BEFORE FIRST POLICY ONE')
  suffix = 'TWO'
  assert.equal(text(h.services.prompt.refreshContext(first.assembly, h.context)), 'BEFORE FIRST POLICY TWO', '仍调用官方动态provider，只保留本步接受的替句配置')
  rules[0].then[0].target.contexts.replace[0].text = 'SECOND POLICY'
  h.write(); await h.runtime.refresh()
  const second = await render()
  assert.equal(text(second.assembly), 'BEFORE SECOND POLICY TWO')
  assert.equal(text(h.services.prompt.refreshContext(first.assembly, h.context)), 'BEFORE FIRST POLICY TWO')
  rules[0].enabled = false
  h.write(); await h.runtime.refresh()
  const disabled = await render()
  assert.equal(text(disabled.assembly), 'BEFORE ORIGINAL POLICY TWO')
  assert.equal(text(h.services.prompt.refreshContext(second.assembly, h.context)), 'BEFORE SECOND POLICY TWO')
  const other = { id: 'policy-child', session: { id: 'policy-child', header: { delegationDepth: 1 } } }
  assert.throws(() => h.services.prompt.refreshContext(first.assembly, { ...h.context, agent: other }), { code: 'TOOL_STEP_UNAVAILABLE' })
  assert.equal(text(await h.root.systemPrompt.assemble({ agent: other, scope: other })), 'BEFORE ORIGINAL POLICY TWO', '其他Agent不继承此Agent的关闭前快照')
  assert.throws(() => compileRules([{ id: 'invalid', then: [{ id: 'invalid', kind: 'assembly', target: { contexts: {
    clear: true, replace: [{ name: 'approval:policy', match: 'OLD', text: 'NEW' }],
  } } }] }]), /clear cannot combine/)
  for (const entry of [first, second, disabled]) entry.set.dispose()
})

test('工具说明只投影原步骤的描述，native与PTC目录、参数及原调用保持一致', async t => {
  const rules = [{ id: 'descriptions', then: [{ id: 'description', kind: 'assembly', target: { toolDescriptions: [
    { name: 'described', match: 'ORIGINAL NOTICE', text: 'EDITED NOTICE' },
    { name: 'described', parameter: 'sandbox_permissions', match: 'USER APPROVAL', text: 'OPTIONAL ACCESS' },
  ] } }] }]
  const h = await harness(t, rules)
  const parameters = { type: 'object', required: ['command'], additionalProperties: false, properties: {
    command: { type: 'string', description: 'Command unchanged' },
    sandbox_permissions: { type: 'string', enum: ['workspace-write', 'danger-full-access'], description: 'USER APPROVAL' },
  } }
  const definition = { name: 'described', description: 'BEFORE ORIGINAL NOTICE AFTER', parameters,
    output: { schema: { type: 'string' }, render: () => [] }, execute: args => args.command }
  h.root.tools.register(definition)
  const original = h.root.tools.get('described', h.agent)
  const render = async () => {
    const set = await h.services.tools.resolve(h.context)
    return { set, assembly: await h.services.prompt.assemble({ ...h.context, toolSet: set }) }
  }
  const first = await render()
  const actual = first.assembly.tools.find(tool => tool.name === 'described')
  assert.equal(actual.description, 'BEFORE EDITED NOTICE AFTER')
  assert.deepEqual(actual.parameters, { ...parameters, properties: { ...parameters.properties,
    sandbox_permissions: { ...parameters.properties.sandbox_permissions, description: 'OPTIONAL ACCESS' } } })
  assert.equal(first.set.view(h.agent).get('described').execute, original.execute)
  assert.equal(h.root.tools.get('described', h.agent).description, 'BEFORE ORIGINAL NOTICE AFTER', '原registry与其它Agent不被修改')
  const execute = async set => (await h.services.tools.execute({ ...h.context, toolSet: set,
    calls: [{ type: 'tool-call', id: 'description', name: 'described', arguments: '{"command":"LOCAL RESULT"}' }],
  })).results[0].result
  assert.equal((await execute(first.set)).value, 'LOCAL RESULT')
  h.root.provide('workingDirectory', { ensure: async () => process.cwd() })
  h.root.provide('ptcRuntime', { language: 'typescript', resolve: spec => spec, release() {},
    run: async spec => ({ logs: [], value: await spec.bindings[0].functions.described({ command: 'LOCAL RESULT' }) }) })
  await h.agent.ctx.plugin(ptc)
  const program = await render()
  const sdk = program.assembly.sections.find(section => section.name === 'tools:sdk').text
  assert.match(sdk, /BEFORE EDITED NOTICE AFTER/)
  assert.match(sdk, /OPTIONAL ACCESS/)
  assert.doesNotMatch(sdk, /ORIGINAL NOTICE|USER APPROVAL/)
  assert.equal(program.set.view(h.agent).get('described').execute, original.execute)
  rules[0].then[0].target.toolDescriptions[0].text = 'SECOND NOTICE'; h.write(); await h.runtime.refresh()
  const updated = await render()
  assert.equal(updated.set.view(h.agent).get('described').description, 'BEFORE SECOND NOTICE AFTER')
  assert.equal(program.set.view(h.agent).get('described').description, 'BEFORE EDITED NOTICE AFTER', '热更不混入已接受步骤')
  rules[0].enabled = false; h.write(); await h.runtime.refresh()
  const disabled = await render()
  assert.equal(disabled.set.view(h.agent).get('described').description, 'BEFORE ORIGINAL NOTICE AFTER')
  assert.equal(first.set.view(h.agent).get('described').description, 'BEFORE EDITED NOTICE AFTER', '关闭只影响后续步骤')
  const nested = (await h.services.tools.execute({ ...h.context, toolSet: program.set,
    calls: [{ type: 'tool-call', id: 'program', name: 'run_code', arguments: '{"code":"described","description":"Controlled original tool call"}' }],
  })).results[0].result
  assert.deepEqual(nested.value, { logs: [], result: 'LOCAL RESULT' })
  for (const entry of [first, program, updated, disabled]) entry.set.dispose()
})

test('工具说明拒绝不明目标和混合正文，诊断失败且下一步骤正常恢复', async t => {
  const entries = [
    { name: 'missing', match: 'KNOWN SENTENCE', text: 'READY' },
    { name: 'keep', parameter: 'missing', match: 'KNOWN SENTENCE', text: 'EDITED' },
    { name: 'hidden', match: '\n* KNOWN SENTENCE', text: '' },
  ]
  const rules = [{ id: 'descriptions', then: [{ id: 'description', kind: 'assembly', target: { toolDescriptions: entries } }] }]
  const h = await harness(t, rules)
  h.registrations.get('hidden')()
  h.root.tools.register({ name: 'hidden', description: 'User mentions KNOWN SENTENCE inside mixed prose.',
    parameters: { type: 'object', properties: {} }, output: { schema: { type: 'object' }, render: () => [] }, execute: () => ({}),
  })
  const render = async () => { const set = await h.services.tools.resolve(h.context); return { set, assembly: await h.services.prompt.assemble({ ...h.context, toolSet: set }) } }
  const missing = await render()
  assert.equal(missing.assembly.tools.find(tool => tool.name === 'hidden').description, 'User mentions KNOWN SENTENCE inside mixed prose.')
  assert.equal(missing.set.view(h.agent).has('missing'), false, '说明不自动注册缺失工具')
  assert.equal(Object.hasOwn(missing.set.view(h.agent).get('keep').parameters.properties, 'missing'), false, '说明不补造参数')
  const diagnostic = () => h.runtime.ruleDiagnostics().records.find(record => record.channel === 'tool:descriptions')
  assert.equal(diagnostic()?.identityOutcome, 'target-mismatch')
  assert.match(diagnostic().reason, /missing/)
  h.root.tools.register({ name: 'missing', description: 'KNOWN SENTENCE', parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'object' }, render: () => [] }, execute: () => ({}) })
  const arrived = await render()
  assert.equal(arrived.set.view(h.agent).get('missing').description, 'READY', '缺目标恢复只在下一个正常步骤应用')
  assert.equal(missing.set.view(h.agent).has('missing'), false, '晚到注册不进入原冻结集合')
  entries.splice(0, entries.length, { name: 'hidden', match: 'User mentions KNOWN SENTENCE inside mixed prose.', text: 'EXPLICIT WHOLE DESCRIPTION' })
  h.write(); await h.runtime.refresh()
  const recovered = await render()
  assert.equal(recovered.assembly.tools.find(tool => tool.name === 'hidden').description, 'EXPLICIT WHOLE DESCRIPTION')
  assert.equal(diagnostic()?.identityOutcome, 'matched')
  rules[0].if = { scope: { audience: 'subagent' } }; h.write(); await h.runtime.refresh()
  const miss = await render()
  assert.equal(miss.set.view(h.agent).get('hidden').description, 'User mentions KNOWN SENTENCE inside mixed prose.')
  for (const entry of [missing, arrived, recovered, miss]) entry.set.dispose()
  for (const entry of [null, { name: 'keep', match: '', text: '' }, { name: 'keep', parameter: '', match: 'keep', text: '' },
    { name: 'keep', match: 'keep', text: null }, { name: 'keep', match: 'keep', text: '', type: 'number' }]) {
    assert.throws(() => compileRules([{ id: 'invalid', then: [{ id: 'description', kind: 'assembly', target: { toolDescriptions: [entry] } }] }]), /toolDescriptions/)
  }
})

test('相同工具说明贡献幂等，晚到目标与原集合释放不复活旧定义', async t => {
  const action = { id: 'description', kind: 'assembly', target: { toolDescriptions: [{ name: 'keep', match: 'keep', text: 'EDITED' }] } }
  const h = await harness(t, [{ id: 'first', then: [action] }, { id: 'second', then: [structuredClone(action)] }])
  const set = await h.services.tools.resolve(h.context)
  const assembly = await h.services.prompt.assemble({ ...h.context, toolSet: set })
  assert.equal(assembly.tools.find(tool => tool.name === 'keep').description, 'EDITED')
  const records = h.runtime.ruleDiagnostics().records.filter(record => record.channel === 'tool:descriptions')
  assert.equal(records.length, 2)
  assert.ok(records.every(record => record.identityOutcome === 'matched'), JSON.stringify(records))
  h.registrations.get('keep')()
  assert.equal(set.view(h.agent).has('keep'), false, '说明不复活原集合已移除的工具')
  await h.runtime.dispose()
  assert.equal(set.view(h.agent).size, 0, 'owner释放关闭该步骤')
  assert.equal((await h.rawTools.execute({ ...h.context, toolSet: set,
    calls: [{ type: 'tool-call', id: 'closed-description', name: 'keep', arguments: '{}' }],
  })).results[0].result.isError, true)
})

test('普通委派参数使用已接受步骤快照，数值冲突拒绝且关闭恢复原owner', async t => {
  const rules = [{ id: 'depth', then: [{ id: 'depth', kind: 'subagent-params', provider: 'spawn', tool: 'subagent', maxDepth: 1 }] }]
  const h = await harness(t, rules)
  h.root.systemPrompt.context({ name: 'tool:subagent:depth', order: 20, text: 'ORIGINAL DEPTH' })
  const service = { getProvider: () => ({ capabilities: { depthLimit: true } }), startActivation: async spec => ({ maxDepth: spec.request.maxDepth }) }
  h.root.provide('subagents', service)
  await h.agent.ctx.plugin({ inject: ['tools', 'subagents'], apply(ctx) {
    for (const name of ['subagent', 'subagent_fork']) ctx.tools.register({ name, description: name, parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'object' }, render: () => [] }, execute: (_args, run) => ctx.subagents.startActivation({ provider: name === 'subagent' ? 'spawn' : 'fork', request: { parent: run.agent, maxDepth: 9 } }) })
  } })
  const resolve = async () => { const set = await h.services.tools.resolve(h.context); const assembly = await h.services.prompt.assemble({ ...h.context, toolSet: set }); return { set, assembly } }
  const value = async (set, name = 'subagent') => (await h.execute(set, name)).results[0].result.value.maxDepth
  const first = await resolve()
  assert.equal(await value(first.set), 1)
  assert.equal(first.assembly.contexts.some(context => context.name === 'tool:subagent:depth'), false, '当前深度0低于接受上限1，撤掉原配置的错误说明')
  assert.equal(await value(first.set, 'subagent_fork'), 9)
  rules[0].then[0].maxDepth = 2; h.write(); await h.runtime.refresh()
  const second = await resolve()
  assert.equal(await value(second.set), 2)
  assert.equal(await value(first.set), 1, '旧工具集合保留已接受配置，不读取热更后的值')
  rules.push({ id: 'same', then: [{ ...rules[0].then[0] }] }); h.write(); await h.runtime.refresh()
  const same = await resolve(); assert.equal(await value(same.set), 2)
  rules[1].then[0].maxDepth = 3; h.write()
  await assert.rejects(h.runtime.refresh(), /maxDepth.*conflict/)
  const retained = await resolve(); assert.equal(await value(retained.set), 2)
  const events = []
  h.agent.session.snapshotEvents = () => events
  rules[1].if = { session: { type: 'conflict', present: true } }
  rules[1].then.push({ id: 'dependent-body', kind: 'inject-text', config: { layer: 'system-section', text: 'CONFLICTING BODY' } })
  h.write(); await h.runtime.refresh()
  events.push({ type: 'conflict', seq: 1, data: {} })
  const conflict = await resolve()
  assert.equal(await value(conflict.set), 9, '动态异值冲突暂停该参数贡献，透传原owner')
  assert.doesNotMatch(conflict.assembly.sections.map(section => section.text).join('\n'), /CONFLICTING BODY/)
  assert.ok(h.runtime.ruleDiagnostics().records.some(record => /maxDepth conflict/.test(record.reason ?? '')))
  events.length = 0
  const recovered = await resolve(); assert.equal(await value(recovered.set), 2)
  rules.splice(1); rules[0].enabled = false; h.write(); await h.runtime.refresh()
  const disabled = await resolve(); assert.equal(await value(disabled.set), 9)
  assert.equal(await value(first.set), 1, '关闭不改写已发行步骤')
  rules[0].enabled = true; rules[0].then[0].maxDepth = 0; h.write(); await h.runtime.refresh()
  const zero = await resolve()
  assert.equal(await value(zero.set), 0)
  assert.match(zero.assembly.contexts.find(context => context.name === 'tool:subagent:depth').text, /current 0, maximum 0, remaining levels 0/)
  const refreshed = h.services.prompt.refreshContext(zero.assembly, { ...h.context, toolSet: zero.set })
  assert.match(refreshed.contexts.find(context => context.name === 'tool:subagent:depth').text, /current 0, maximum 0, remaining levels 0/)
  assert.equal((await service.startActivation({ provider: 'spawn', request: { parent: h.agent, maxDepth: 7 } })).maxDepth, 7, '直接服务调用不借用模型工具步骤')
  for (const set of [first.set, second.set, same.set, retained.set, conflict.set, recovered.set, disabled.set, zero.set]) set.dispose()
})

test('委派依赖缺失只暂停同分支正文，恢复后正常重判且原关闭意图保留', async t => {
  const rules = [{ id: 'depth', then: [{ id: 'depth', kind: 'subagent-params', provider: 'spawn', tool: 'subagent', maxDepth: 1 },
    { id: 'body', kind: 'inject-text', config: { layer: 'system-section', text: 'DEPTH READY BODY' } },
    { id: 'pre-body', kind: 'inject-text', config: { layer: 'pre-step', position: 'after-all', text: 'DEPENDENT PRESTEP BODY' } }] },
  { id: 'independent', then: [{ id: 'body', kind: 'inject-text', config: { layer: 'system-section', text: 'CONTROL BODY' } },
    { id: 'pre-control', kind: 'inject-text', config: { layer: 'pre-step', position: 'after-all', text: 'CONTROL PRESTEP' } }] }]
  const h = await harness(t, rules)
  let providerReady = false
  h.root.provide('subagents', { getProvider: () => { if (providerReady === 'error') throw new Error('provider lookup failed'); return providerReady ? { capabilities: { depthLimit: true } } : undefined }, startActivation: async () => ({}) })
  const render = async () => {
    const set = await h.services.tools.resolve(h.context)
    try {
      const result = await h.services.prompt.assemble({ ...h.context, toolSet: set })
      const decision = await h.root.waterfall(scopeTarget(h.agent, h.agent), 'agent/pre-step', { ...h.context, toolSet: set, step: 1, turn: 1 }, async () => ({ kind: 'enter', messages: [] }))
      return { sections: result.sections.map(section => section.text).join('\n'), preStep: decision.messages.flatMap(message => message.content.map(block => block.text ?? '')).join('\n') }
    } finally { set.dispose() }
  }
  const missing = await render()
  assert.doesNotMatch(missing.sections, /DEPTH READY BODY/)
  assert.doesNotMatch(missing.preStep, /DEPENDENT PRESTEP BODY/)
  assert.match(missing.sections, /CONTROL BODY/)
  assert.match(missing.preStep, /CONTROL PRESTEP/)
  h.root.tools.register({ name: 'subagent', description: 'delegate', parameters: { type: 'object', properties: {} }, output: { schema: { type: 'object' }, render: () => [] }, execute: async () => ({}) })
  providerReady = true
  const restored = await render()
  assert.match(restored.sections, /DEPTH READY BODY/)
  assert.match(restored.preStep, /DEPENDENT PRESTEP BODY/)
  assert.match(restored.preStep, /CONTROL PRESTEP/)
  providerReady = false
  const paused = await render()
  assert.doesNotMatch(paused.sections, /DEPTH READY BODY/)
  assert.doesNotMatch(paused.preStep, /DEPENDENT PRESTEP BODY/)
  providerReady = 'error'
  const failed = await render()
  assert.match(failed.sections, /CONTROL BODY/, '提供者读取失败不能阻断无关规则')
  assert.match(failed.preStep, /CONTROL PRESTEP/)
  rules[0].enabled = false; h.write(); await h.runtime.refresh(); providerReady = true
  const disabled = await render()
  assert.doesNotMatch(disabled.sections, /DEPTH READY BODY/)
  assert.doesNotMatch(disabled.preStep, /DEPENDENT PRESTEP BODY/)
  assert.match(disabled.preStep, /CONTROL PRESTEP/)
})

test('显式工具就绪条件读取执行owner，缺失暂停说明且恢复后下一集合生效', async t => {
  const rules = [{ id: 'dependent', if: { tool: { name: 'late_delegate' } }, then: [{ id: 'body', kind: 'inject-text', config: { layer: 'system-section', text: 'TOOL READY BODY' } }] },
    { id: 'independent', then: [{ id: 'body', kind: 'inject-text', config: { layer: 'system-section', text: 'CONTROL BODY' } }] }]
  const h = await harness(t, rules)
  await h.agent.ctx.plugin({ inject: ['tools'], apply(ctx) { applyCustomTools(ctx, { tools: [{ id: 'late_delegate', name: 'late_delegate', description: 'late delegate', output: { schema: { type: 'object' } }, execute: { kind: 'delegate', tool: 'late_target' } }] }) } })
  let expected = false
  const render = async () => { const set = await h.services.tools.resolve(h.context); assert.equal(set.view(h.agent).has('late_delegate'), expected); const assembly = await h.services.prompt.assemble({ ...h.context, toolSet: set }); set.dispose(); return assembly.sections.map(section => section.text).join('\n') }
  assert.doesNotMatch(await render(), /TOOL READY BODY/)
  assert.match(await render(), /CONTROL BODY/)
  const off = h.root.tools.register({ name: 'late_target', description: 'late', parameters: { type: 'object', properties: {} }, output: { schema: { type: 'object' }, render: () => [] }, execute: async () => ({}) })
  expected = true
  assert.match(await render(), /TOOL READY BODY/)
  off(); expected = false
  assert.doesNotMatch(await render(), /TOOL READY BODY/)
  rules[0].enabled = false; h.write(); await h.runtime.refresh()
  h.root.tools.register({ name: 'late_target', description: 'restored', parameters: { type: 'object', properties: {} }, output: { schema: { type: 'object' }, render: () => [] }, execute: async () => ({}) }); expected = true
  assert.doesNotMatch(await render(), /TOOL READY BODY/, '暂停期间用户关闭后恢复目标不重启说明')
})

test('pending 拒绝公开批次和原服务 guard，失败或取消关闭一次，重试复用封存快照', async t => {
  const h = await harness(t)
  const resolve = h.rawTools.resolve
  let released = 0, original
  t.mock.method(h.rawTools, 'resolve', async function (context) {
    const selected = await resolve.call(this, context)
    original = { view: scope => selected.view(scope), dispose: () => { released++; selected.dispose() } }
    return original
  })
  const toolSet = await h.services.tools.resolve(h.context)
  assert.deepEqual(Object.keys(toolSet).sort(), ['dispose', 'view'])
  assert.deepEqual([...toolSet.view(h.agent).keys()].sort(), ['hidden', 'keep'])
  await assert.rejects(h.execute(toolSet), { code: 'TOOL_STEP_UNAVAILABLE' })
  assert.equal((await h.execute(original, 'keep', h.rawTools)).results[0].result.isError, true)
  assert.equal(h.counts().calls, 0)
  let presentations = 0
  const off = h.root.on('system-prompt/assemble', async (_assembly, _context, next) => { presentations++; return next() })
  const first = await h.services.prompt.assemble({ ...h.context, toolSet })
  h.context.modelSelection.model = 'deepseek-flash'
  assert.equal(await h.services.prompt.assemble({ ...h.context, toolSet: original }), first)
  assert.equal(presentations, 1)
  assert.deepEqual((await h.execute(toolSet)).results[0].result.value, { name: 'keep' })
  const outsider = { id: 'outsider', session: { header: {} } }
  outsider.ctx = createScope(h.root, outsider).ctx
  await assert.rejects(h.services.tools.execute({ agent: outsider, toolSet, signal: h.context.signal,
    calls: [{ type: 'tool-call', id: 'foreign', name: 'keep', arguments: '{}' }],
  }), { code: 'TOOL_STEP_UNAVAILABLE' })
  assert.equal((await h.rawTools.execute({ agent: outsider, toolSet: original, signal: h.context.signal,
    calls: [{ type: 'tool-call', id: 'foreign-raw', name: 'keep', arguments: '{}' }],
  })).results[0].result.isError, true)
  assert.equal(h.counts().calls, 1)
  toolSet.dispose(); toolSet.dispose()
  assert.equal(released, 1)
  await assert.rejects(h.services.prompt.assemble({ ...h.context, toolSet }), { code: 'TOOL_STEP_UNAVAILABLE' })
  off()
  const failed = await h.services.tools.resolve(h.context)
  const fail = h.root.on('system-prompt/assemble', () => { throw new Error('assembly failed') })
  await assert.rejects(h.services.prompt.assemble({ ...h.context, toolSet: failed }), /assembly failed/)
  failed.dispose()
  assert.equal(released, 2)
  assert.equal(failed.view(h.agent).size, 0)
  await assert.rejects(h.execute(failed), { code: 'TOOL_STEP_UNAVAILABLE' })
  fail()
  const cancelled = await h.services.tools.resolve(h.context)
  const abort = new AbortController()
  const cancel = h.root.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembled = await next()
    abort.abort()
    return assembled
  })
  await assert.rejects(h.services.prompt.assemble({ ...h.context, signal: abort.signal, toolSet: cancelled }), { name: 'AbortError' })
  cancelled.dispose()
  assert.equal(released, 3)
  cancel()
  const closing = await h.services.tools.resolve(h.context)
  const closeDuringAssembly = h.root.on('system-prompt/assemble', async (_assembly, _context, next) => {
    closing.dispose()
    return next()
  })
  await assert.rejects(h.services.prompt.assemble({ ...h.context, toolSet: closing }), { code: 'TOOL_STEP_UNAVAILABLE' })
  closing.dispose()
  assert.equal(released, 4)
  closeDuringAssembly()
  const originalResolve = h.rawTools.resolve
  const same = await h.services.tools.resolve(h.context)
  t.mock.method(h.rawTools, 'resolve', async () => same)
  assert.equal(await h.services.tools.resolve(h.context), same, '重复包装保持同一集合身份')
  t.mock.method(h.rawTools, 'resolve', originalResolve)
  same.dispose()
  assert.equal(released, 5)
})

test('PTC 原服务持有原或包装集合时，pending、失败和卸载均不启动程序，重挂恢复', async t => {
  const h = await harness(t)
  let runs = 0, original
  h.root.provide('workingDirectory', { ensure: async () => process.cwd() })
  h.root.provide('ptcRuntime', { language: 'typescript', resolve: spec => spec, release() {}, run: async spec => {
    runs++
    const Program = Object.getPrototypeOf(async function () {}).constructor
    return { logs: [], value: await new Program('tools', spec.program)(spec.bindings[0].functions) }
  } })
  await h.agent.ctx.plugin(ptc)
  const resolve = h.rawTools.resolve
  t.mock.method(h.rawTools, 'resolve', async function (context) {
    original = await resolve.call(this, context)
    return original
  })
  const run = async toolSet => (await h.rawTools.execute({ ...h.context, toolSet, calls: [{
    type: 'tool-call', id: 'lifecycle', name: 'run_code', arguments: JSON.stringify({ code: 'return 42', description: 'lifecycle' }),
  }] })).results[0].result
  const rejected = async (toolSet, source, expectedRuns) => {
    const results = [await run(toolSet), await run(source)]
    assert.equal(runs, expectedRuns, `拒绝步骤不能启动 PTC 程序: ${JSON.stringify(results.map(result => result.value))}`)
    assert.deepEqual(results.map(result => result.isError), [true, true])
  }
  const toolSet = await h.services.tools.resolve(h.context)
  const source = original
  await rejected(toolSet, source, 0)
  await h.services.prompt.assemble({ ...h.context, toolSet })
  assert.deepEqual((await run(toolSet)).value, { logs: [], result: 42 })
  assert.equal(runs, 1)
  const failed = await h.services.tools.resolve(h.context)
  const failedSource = original
  const fail = h.root.on('system-prompt/assemble', () => { throw new Error('assembly failed') })
  await assert.rejects(h.services.prompt.assemble({ ...h.context, toolSet: failed }), /assembly failed/)
  fail()
  await rejected(failed, failedSource, 1)
  await h.runtime.dispose()
  await h.runtime.dispose()
  assert.equal(toolSet.view(h.agent).size, 0)
  await rejected(toolSet, source, 1)
  const release = mountRuleSources(h.root, [{ moduleId: 'remount', rules: compileRules([
    { id: 'narrow', then: [{ id: 'allow', kind: 'tool-visibility', allow: ['keep'] }] },
  ]) }])
  let services
  await h.agent.ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(ctx) { services = { tools: ctx.tools, prompt: ctx.systemPrompt } } })
  const restored = await services.tools.resolve(h.context)
  await services.prompt.assemble({ ...h.context, toolSet: restored })
  assert.deepEqual((await run(restored)).value, { logs: [], result: 42 })
  assert.equal(runs, 2)
  release(); release()
  await rejected(restored, original, 2)
  await h.root.fiber.dispose()
  assert.equal(h.rawTools.checkGuards({ ...h.context, toolSet, name: 'run_code' }), undefined, 'root 释放会撤销步骤拒绝闸')
})

test('捕获模型贯穿原与包装集合的真实工具规则，裸装配不猜步骤', async t => {
  const h = await harness(t, [
    { id: 'narrow', then: [{ id: 'allow', kind: 'tool-visibility', allow: ['keep'] }] },
    { id: 'pro-gate', if: { scope: { modelScope: 'pro' } }, then: [{ id: 'deny', kind: 'tool-gate', reason: 'captured pro', decision: 'deny' }] },
  ])
  const toolSet = await h.services.tools.resolve(h.context)
  h.context.modelSelection.model = 'deepseek-flash'
  await h.services.prompt.assemble({ ...h.context, toolSet })
  assert.match((await h.execute(toolSet)).results[0].result.error.message, /captured pro/)
  assert.equal(h.counts().calls, 0)
  assert.deepEqual((await h.services.prompt.assemble({ agent: h.agent, scope: h.agent })).tools.map(tool => tool.name), ['keep'])
  const foreign = { dispose() {}, view() { return new Map() } }
  await assert.rejects(h.services.prompt.assemble({ ...h.context, toolSet: foreign }), /adapted resolve/)
  toolSet.dispose()
})

test('独立规则入口在官方返回后组合多个来源，官方准入始终是工具面的上限', async t => {
  const root = new Context()
  await root.plugin(SystemPrompt)
  await root.plugin(Tools)
  await root.plugin(native)
  root.provide('llm', {})
  t.after(() => root.fiber.dispose())
  const agent = { id: 'standalone', session: { id: 'standalone', header: {}, snapshotEvents: () => [] } }
  const preset = {}
  const presetScope = createScope(root, preset)
  agent.ctx = createScope(root, agent, { parent: preset }).ctx
  const calls = [], conditions = []
  const register = (ctx, name, accepted = true) => ctx.tools.register({ name, description: name,
    parameters: { type: 'object', properties: {} }, output: { schema: { type: 'string' }, render: () => [] },
    execute: () => { calls.push(name); return name },
  }, { when: () => { conditions.push(name); return accepted } })
  register(root, 'ancestor')
  await presetScope.ctx.plugin({ inject: ['tools'], apply(ctx) { register(ctx, 'preset') } })
  await agent.ctx.plugin({ inject: ['tools'], apply(ctx) { register(ctx, 'own'); register(ctx, 'offline', false) } })
  const releases = []
  for (const action of [
    { id: 'allow', kind: 'tool-visibility', allow: ['ancestor', 'preset', 'own', 'offline', 'missing'], requireMatch: true },
    { id: 'deny', kind: 'tool-visibility', deny: ['preset'] },
  ]) releases.push(mountRuleSources(root, [{ moduleId: action.id, rules: compileRules([{ id: action.id, then: [action] }]) }]))
  t.after(() => releases.forEach(release => release()))
  let services
  await agent.ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(ctx) { services = { tools: ctx.tools, prompt: ctx.systemPrompt } } })
  const signal = new AbortController().signal
  const toolSet = await services.tools.resolve({ agent, scope: agent, signal })
  const assembly = await services.prompt.assemble({ agent, scope: agent, signal, toolSet })
  assert.deepEqual(assembly.tools.map(tool => tool.name).sort(), ['ancestor', 'own'])
  assert.deepEqual([...toolSet.view(agent).keys()].sort(), ['ancestor', 'own'])
  assert.deepEqual(services.tools.schemas(agent).map(tool => tool.name).sort(), ['ancestor', 'offline', 'own', 'preset'], '发现候选不受插件 deny restriction 破坏')
  for (const name of ['ancestor', 'own', 'preset', 'offline']) {
    const result = (await services.tools.execute({ agent, signal, toolSet, calls: [{ type: 'tool-call', id: name, name, arguments: '{}' }] })).results[0].result
    assert.equal(result.isError, !['ancestor', 'own'].includes(name), name)
  }
  assert.deepEqual(calls, ['ancestor', 'own'])
  assert.deepEqual(conditions.sort(), ['ancestor', 'offline', 'own', 'preset'])
  releases.splice(0).forEach(release => release())
  assert.equal(toolSet.view(agent).size, 0, '最后一个适配 owner 释放会关闭已封存集合')
  assert.equal((await root.tools.execute({ agent, signal, toolSet, calls: [{ type: 'tool-call', id: 'disposed', name: 'ancestor', arguments: '{}' }] })).results[0].result.isError, true)
  toolSet.dispose()
})

test('同一步骤在官方 PTC 绑定与 delegate 管线按同一多层名单执行，正文不决定权限', async t => {
  const h = await harness(t, [{ id: 'multi', then: [{ id: 'allow', kind: 'tool-visibility',
    allow: ['keep', 'preset', 'own', 'probe'], deny: ['hidden', 'own'], requireMatch: true },
  { id: 'catalog', kind: 'inject-text', config: { layer: 'runtime-context', strategy: 'placeholder', fill: 'tool-catalog', text: '{{RESIDENT_TOOLS}}', params: { action: 'allow' } } }] }])
  const bodies = [], bindings = []
  h.root.provide('workingDirectory', { ensure: async () => process.cwd() })
  h.root.provide('ptcRuntime', { language: 'typescript', resolve: spec => spec, run: async spec => {
    const functions = spec.bindings[0].functions
    bindings.push(Object.keys(functions).sort())
    if (functions[spec.program] === undefined) return { logs: [], error: { kind: 'program', message: `no binding ${spec.program}` } }
    try { return { logs: [], value: await functions[spec.program]({}) } }
    catch (error) { return { logs: [], error: { kind: 'tool', message: String(error.message) } } }
  } })
  await h.agent.ctx.plugin(ptc)
  await h.agent.ctx.plugin({ inject: ['tools'], apply(ctx) {
    ctx.tools.register({ name: 'own', description: 'own', parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'string' }, render: () => [] }, execute: () => { bodies.push('own'); return 'own' } })
    applyCustomTools(ctx, { tools: [{ id: 'probe', name: 'probe', description: 'delegates hidden', parameters: { type: 'object', properties: {} }, output: { schema: { type: 'object' } }, execute: { kind: 'delegate', tool: 'hidden' } }] })
  } })
  const toolSet = await h.services.tools.resolve(h.context)
  const assembly = await h.services.prompt.assemble({ ...h.context, toolSet })
  assert.deepEqual(assembly.tools.map(tool => tool.name), ['run_code'])
  assert.deepEqual(sdkToolNames(assembly.sections.find(section => section.name === 'tools:sdk').text).sort(), ['keep', 'probe'])
  assert.equal(assembly.contexts[0].text, 'keep, probe')
  const bare = await h.services.prompt.assemble({ agent: h.agent, scope: h.agent, signal: h.context.signal })
  assert.equal(bare.contexts[0].text, 'keep, probe', '裸 PTC 装配按最终 SDK 展示信息回填，不据此生成步骤权限')
  assert.equal(h.services.prompt.refreshContext(assembly, { agent: h.agent, scope: h.agent }).contexts[0].text, 'keep, probe')
  assert.deepEqual([...toolSet.view(h.agent).keys()].sort(), ['keep', 'probe'])
  const run = async code => (await h.services.tools.execute({ ...h.context, toolSet, calls: [{ type: 'tool-call', id: code, name: 'run_code', arguments: JSON.stringify({ code, description: code }) }] })).results[0].result
  assert.deepEqual((await run('keep')).value, { logs: [], result: { name: 'keep' } })
  assert.equal((await run('own')).isError, true, '拒绝工具无法建立 PTC 绑定')
  const delegated = await run('probe')
  assert.equal(delegated.value.result.ok, false, '已允许的 delegate 也不能调用被拒工具')
  assert.match(delegated.value.result.error, /outside the sealed step/)
  assert.deepEqual(bindings, [['keep', 'probe'], ['keep', 'probe'], ['keep', 'probe']])
  assert.deepEqual(bodies, [])
  assert.equal(h.counts().calls, 1, '被拒的 hidden body 没执行')
  toolSet.dispose()
})

test('requireMatch 全缺只放宽插件 allow，deny 与官方 when 在实际调用中继续拒绝', async t => {
  const h = await harness(t, [{ id: 'missing', then: [{ id: 'allow', kind: 'tool-visibility',
    allow: ['absent'], deny: ['hidden'], requireMatch: true }] }])
  const toolSet = await h.services.tools.resolve(h.context)
  const final = await h.services.prompt.assemble({ ...h.context, toolSet })
  assert.deepEqual(final.tools.map(tool => tool.name), ['keep'])
  assert.deepEqual([...toolSet.view(h.agent).keys()], ['keep'])
  assert.deepEqual((await h.execute(toolSet)).results[0].result.value, { name: 'keep' })
  for (const name of ['hidden', 'unavailable']) assert.equal((await h.execute(toolSet, name)).results[0].result.isError, true)
  assert.deepEqual(h.counts(), { calls: 1, conditions: 3 })
  toolSet.dispose()
})

test('最终目录指引与发现候选分离，真实搜索解锁仅改变下一集合及其正文', async t => {
  const notice = layer => ({ id: layer, kind: 'inject-text', config: { layer, ...(layer === 'pre-step' ? { position: 'after-all' } : {}), strategy: 'placeholder', fill: 'tool-catalog',
    text: 'resident={{RESIDENT_TOOLS}}; search={{DISCOVERY_TOOL}}', params: { action: 'allow' } } })
  const h = await harness(t, [
    { id: 'resident', then: [{ id: 'allow', kind: 'tool-visibility', allow: ['keep', 'hidden'], discovery: { kind: 'tools' } }, notice('runtime-context'), notice('pre-step')] },
    { id: 'deny', then: [{ id: 'deny', kind: 'tool-visibility', deny: ['hidden'] }] },
  ], ['rule-engine', 'tool-search'])
  const events = []
  h.agent.session.snapshotEvents = () => events
  const off = h.root.tools.register({ name: 'gamma', description: 'locked gamma', parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: () => [] }, execute: () => 'gamma' })
  t.after(off)
  const first = await h.services.tools.resolve(h.context)
  const accepted = await h.services.prompt.assemble({ ...h.context, toolSet: first })
  assert.equal(accepted.contexts[0].text, 'resident=keep; search=tool_search', JSON.stringify({ accepted, warnings: h.warnings }))
  const preStep = await h.root.waterfall(scopeTarget(h.agent, h.agent), 'agent/pre-step', { ...h.context, step: 1, turn: 1 }, async () => ({ kind: 'enter', messages: [] }))
  assert.equal(preStep.messages[0].content[0].text, 'resident=keep; search=tool_search')
  const args = JSON.stringify({ query: 'gamma', toolNames: ['gamma', 'hidden'] })
  const found = (await h.services.tools.execute({ ...h.context, toolSet: first, calls: [{ type: 'tool-call', id: 'search', name: 'tool_search', arguments: args }] })).results[0].result
  assert.equal(found.isError, false)
  assert.match(found.value.text, /gamma \(exact\)/)
  events.push({ type: 'tool/call', seq: 1, data: { name: 'tool_search', arguments: args } })
  assert.equal((await h.execute(first, 'gamma')).results[0].result.isError, true)
  const nextContext = { ...h.context, modelSelection: { model: 'deepseek-flash' } }
  const second = await h.services.tools.resolve(nextContext)
  const next = await h.services.prompt.assemble({ ...nextContext, toolSet: second })
  assert.deepEqual(next.tools.map(tool => tool.name).sort(), ['gamma', 'keep', 'tool_search'])
  assert.equal((await h.execute(second, 'gamma')).results[0].result.value, 'gamma')
  assert.equal((await h.execute(second, 'hidden')).results[0].result.isError, true)
  assert.equal(await h.services.prompt.assemble({ ...h.context, toolSet: first }), accepted)
  assert.equal(h.services.prompt.refreshContext(accepted, h.context).contexts[0].text, 'resident=keep; search=tool_search')
  first.dispose(); second.dispose()
})

test('同 Agent 交错装配及 refresh 按集合隔离正文，pre-step 读取捕获选择且歧义拒绝', async t => {
  const resident = (id, modelScope, tool) => ({ id, if: { scope: { modelScope } }, then: [
    { id: 'allow', kind: 'tool-visibility', allow: [tool] },
    ...['runtime-context', 'pre-step'].map(layer => ({ id: layer, kind: 'inject-text', config: { layer, ...(layer === 'pre-step' ? { position: 'after-all' } : {}), strategy: 'placeholder', fill: 'tool-catalog', text: '{{RESIDENT_TOOLS}}', params: { action: 'allow' } } })),
  ] })
  const rules = [resident('pro', 'pro', 'keep'), resident('flash', 'flash', 'hidden')]
  const h = await harness(t, rules)
  await h.runtime.dispose()
  const release = mountRuleSources(h.root, [{ moduleId: 'concurrent', rules: compileRules(rules) }])
  t.after(release)
  await h.agent.ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(ctx) { h.services = { tools: ctx.tools, prompt: ctx.systemPrompt } } })
  const pro = { ...h.context, modelSelection: { model: 'deepseek-pro' } }
  const flash = { ...h.context, modelSelection: { model: 'deepseek-flash' } }
  const first = await h.services.tools.resolve(pro)
  const second = await h.services.tools.resolve(flash)
  let entered, resume
  const waiting = new Promise(resolve => { entered = resolve })
  const gate = new Promise(resolve => { resume = resolve })
  const off = h.root.on('system-prompt/assemble', async (_assembly, context, next) => {
    const result = await next()
    if (context.toolSet === first) { entered(); await gate }
    return result
  })
  const a = h.services.prompt.assemble({ ...pro, toolSet: first })
  await waiting
  const b = await h.services.prompt.assemble({ ...flash, toolSet: second })
  resume()
  const accepted = await a
  off()
  const text = assembly => assembly.contexts.map(context => context.text).filter(Boolean)
  assert.deepEqual(text(accepted), ['keep'])
  assert.deepEqual(text(b), ['hidden'])
  assert.deepEqual(text(h.services.prompt.refreshContext(accepted, { agent: h.agent, scope: h.agent, signal: h.context.signal })), ['keep'])
  assert.deepEqual(text(h.services.prompt.refreshContext(b, { agent: h.agent, scope: h.agent, signal: h.context.signal })), ['hidden'])
  const child = { id: 'child', session: { id: 'child', header: { delegationDepth: 1 }, snapshotEvents: () => [] } }
  child.ctx = createScope(h.root, child, { parent: h.agent }).ctx
  const childContext = { ...pro, agent: child, scope: child }
  const childSet = await h.services.tools.resolve(childContext)
  const childAssembly = await h.services.prompt.assemble({ ...childContext, toolSet: childSet })
  assert.deepEqual(text(childAssembly), ['keep'])
  assert.equal((await h.services.tools.execute({ ...childContext, toolSet: childSet, calls: [{ type: 'tool-call', id: 'child-denied', name: 'hidden', arguments: '{}' }] })).results[0].result.isError, true)
  assert.throws(() => h.services.prompt.refreshContext(accepted, childContext), { code: 'TOOL_STEP_UNAVAILABLE' })
  pro.modelSelection.model = 'deepseek-flash'
  const step = context => h.root.waterfall(scopeTarget(h.agent, h.agent), 'agent/pre-step', { ...context, step: 1, turn: 1 }, async () => ({ kind: 'enter', messages: [] }))
  assert.equal((await step(pro)).messages[0].content[0].text, 'keep')
  const duplicate = await h.services.tools.resolve(pro)
  assert.deepEqual((await step(pro)).messages, [], '同选择关联多个集合不猜最新一步')
  first.dispose(); second.dispose(); duplicate.dispose(); childSet.dispose()
  assert.throws(() => h.services.prompt.refreshContext(accepted, pro), { code: 'TOOL_STEP_UNAVAILABLE' })
  assert.deepEqual((await step(pro)).messages, [], 'closed/歧义选择不恢复成另一步')
})
