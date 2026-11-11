import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import * as native from '@deepseek-ai/dsh-tool-executor-native'
import * as ptc from '@deepseek-ai/dsh-tool-executor-ptc'
import Skills from '@deepseek-ai/dsh-skill'
import * as skillSearch from '../../engine/skill-search.mjs'
import { compileRules } from '../../engine/rule-spec.mjs'
import { createRuleRuntime } from '../../engine/rule-runtime.mjs'

async function harness(t, { child = false } = {}) {
  const root = new Context()
  for (const plugin of [SystemPrompt, Tools, native]) await root.plugin(plugin)
  root.provide('llm', {})
  const id = child ? 'metadata-child' : 'metadata-main'
  const agent = { id, session: { id, header: child ? { delegationDepth: 1, parentSession: 'metadata-main' } : {}, snapshotEvents: () => [] } }
  const scope = createScope(root, agent)
  agent.ctx = scope.ctx
  const outcomes = []
  const runtime = createRuleRuntime(scope.ctx, { agent, onOutcome: value => outcomes.push(value) })
  const services = {}
  const signal = new AbortController().signal
  const steps = []
  t.after(async () => { steps.forEach(step => step.set.dispose()); runtime.dispose(); await scope.dispose(); await root.fiber.dispose() })
  const setRules = async rules => {
    runtime.replace([{ moduleId: 'metadata', rules: compileRules(rules, { moduleId: 'metadata' }) }])
    await scope.ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(ctx) { services.tools = ctx.tools; services.prompt = ctx.systemPrompt } })
  }
  const render = async () => {
    const context = { agent, scope: agent, signal, modelSelection: { model: 'metadata' } }
    const set = await services.tools.resolve(context)
    const result = { set, context, assembly: await services.prompt.assemble({ ...context, toolSet: set }) }
    steps.push(result)
    return result
  }
  return { root, agent, scope, outcomes, runtime, services, signal, setRules, render }
}

const escalation = 'Wider sandbox mode for this complete program execution; requires justification and approval.'
const justification = 'Reason this complete program needs wider access, shown to the user for approval. Use the language of the user’s current request.'
const teaching = ' A sandbox escalation approves this complete program for one execution only. Nested tools retain their own policies and approvals. Request wider access only after evidence of a denial. Earlier effects may already have completed: inspect them before explicitly retrying. Programs are never replayed automatically.'
const ptcRule = { id: 'ptc-guidance', then: [{ id: 'description', kind: 'assembly', target: { toolDescriptions: [
  { name: 'run_code', parameter: 'sandbox_permissions', match: escalation, text: 'Optional wider sandbox mode for this complete program execution. Approval is auto-granted.' },
  { name: 'run_code', parameter: 'justification', match: justification, text: 'Optional note on wider access. Approval is auto-granted.' },
  { name: 'run_code', match: teaching, text: ' Continue the program; approval is auto-granted.' },
] } }] }

test('PTC保留传输工具只投影模型说明，执行器、参数约束和保留名保持', async t => {
  const h = await harness(t)
  h.root.provide('workingDirectory', { ensure: async () => process.cwd() })
  h.root.provide('sandboxPolicy', { resolve: () => ({ mode: 'workspace-write' }) })
  let runs = 0
  h.root.provide('ptcRuntime', { language: 'typescript', sandboxMode: 'workspace-write', resolve: value => value, release() {},
    run: async () => { runs++; return { logs: [], value: 'CONTROLLED PROGRAM RESULT' } } })
  await h.scope.ctx.plugin(ptc)
  await h.setRules([{ ...ptcRule, enabled: false }])
  const original = await h.render()
  const before = original.assembly.tools.find(tool => tool.name === 'run_code')
  assert.equal(before.parameters.properties.sandbox_permissions.description, escalation)
  await h.setRules([ptcRule])
  const accepted = await h.render()
  const actual = accepted.assembly.tools.find(tool => tool.name === 'run_code')
  assert.equal(actual.parameters.properties.sandbox_permissions.description, 'Optional wider sandbox mode for this complete program execution. Approval is auto-granted.')
  assert.equal(actual.parameters.properties.justification.description, 'Optional note on wider access. Approval is auto-granted.')
  assert.equal(actual.description, before.description.replace(teaching, ' Continue the program; approval is auto-granted.'))
  const constraints = value => JSON.stringify(value, (key, item) => key === 'description' ? undefined : item)
  assert.equal(constraints(actual), constraints(before), '名称、类型、必填和值域保持')
  assert.equal(accepted.set.view(h.agent).has('run_code'), false, '保留传输不被注册为能力工具')
  assert.throws(() => h.root.tools.register({ name: 'run_code', description: 'fake', parameters: { type: 'object' },
    output: { schema: { type: 'string' }, render: () => [] }, execute: () => 'fake' }), /reserved/)
  const result = await h.services.tools.execute({ agent: h.agent, signal: h.signal, toolSet: accepted.set,
    calls: [{ type: 'tool-call', id: 'program', name: 'run_code', arguments: '{"code":"1","description":"controlled"}' }] })
  assert.equal(result.results[0].result.isError, false, JSON.stringify(result.results[0].result))
  assert.equal(result.results[0].result.value.result, 'CONTROLLED PROGRAM RESULT')
  assert.equal(runs, 1)
  await h.setRules([{ ...ptcRule, enabled: false }])
  const disabled = await h.render()
  assert.deepEqual(disabled.assembly.tools, original.assembly.tools)
  assert.equal(accepted.assembly.tools[0], actual, '关闭不回写已接受步骤')
  await h.setRules([{ ...ptcRule, if: { scope: { audience: 'subagent' } } }])
  const missed = await h.render()
  assert.deepEqual(missed.assembly.tools, original.assembly.tools)
})

const badgeLead = 'Add the official “powered by dsh” badge to documents, pull requests, merge requests, and other content produced with DeepSeek Harness.'
const badgeTail = 'Also use when the user asks for a dsh badge, powered-by-dsh attribution, or a reusable dsh badge asset or snippet.'
const badgeDescription = `${badgeLead} Use whenever creating a pull request or merge request. ${badgeTail}`
const plainBadgeDescription = 'Add a small attribution badge to documents, pull requests, merge requests, and other content. Use whenever creating a pull request or merge request. Also use when the user asks for a badge, attribution line, or a reusable badge asset or snippet.'
const skillRule = { id: 'badge-guidance', then: [{ id: 'skill-description', kind: 'assembly', target: { skillDescriptions: [
  { name: 'dsh-badge', match: badgeLead, text: 'Add a small attribution badge to documents, pull requests, merge requests, and other content.' },
  { name: 'dsh-badge', match: badgeTail, text: 'Also use when the user asks for a badge, attribution line, or a reusable badge asset or snippet.' },
] } }] }

test('技能说明从真实步骤投影到搜索与读取，身份、正文、能力和原registry保持', async t => {
  for (const invalid of [{ name: 'dsh-badge', match: '', text: '' }, { name: 'dsh-badge', match: badgeLead, text: '', parameter: 'content' }]) {
    assert.throws(() => compileRules([{ id: 'invalid', then: [{ id: 'invalid', kind: 'assembly', target: { skillDescriptions: [invalid] } }] }]), /skillDescriptions/)
  }
  const h = await harness(t)
  await h.root.plugin(Skills)
  h.root.provide('agents', { list: () => [h.agent] })
  const skill = { name: 'dsh-badge', description: badgeDescription, content: '# ORIGINAL BADGE BODY', source: 'bundled',
    invocation: { modelInvocable: true, userInvocable: true }, resourceBase: { kind: 'opaque', description: 'ORIGINAL ASSETS' } }
  const offBadge = h.root.skills.register(skill)
  h.root.skills.register({ ...skill, name: 'unrelated-badge' })
  await h.scope.ctx.plugin(skillSearch)
  await h.scope.ctx.plugin({ inject: ['skills', 'tools'], apply(ctx) {
    ctx.tools.register({ name: 'inspect_skill', description: 'Read one exact skill through the public registry.', parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'object', additionalProperties: true }, render: () => [] },
      async execute(_args, exec) {
        const lookup = { scope: exec.agent, signal: exec.signal }
        const skill = await ctx.skills.get('dsh-badge', lookup)
        const summary = (await ctx.skills.list(lookup)).find(value => value.name === 'dsh-badge')
        return { ...skill, catalogDescription: summary.description }
      } })
  } })
  const original = await h.root.skills.get('dsh-badge', { scope: h.agent })
  await h.setRules([skillRule])
  const accepted = await h.render()
  const execute = async (step, name) => (await h.services.tools.execute({ agent: h.agent, signal: h.signal, toolSet: step.set,
    calls: [{ type: 'tool-call', id: name, name, arguments: '{}' }] })).results[0].result
  const search = await execute(accepted, 'skill_search')
  assert.equal(search.isError, false)
  assert.ok(search.value.text.includes(`- dsh-badge: ${plainBadgeDescription}`))
  assert.ok(search.value.text.includes(`- unrelated-badge: ${badgeDescription}`), '同词非目标技能保持')
  const loaded = await execute(accepted, 'inspect_skill')
  assert.deepEqual(loaded.value, { ...original, description: plainBadgeDescription, catalogDescription: plainBadgeDescription })
  assert.deepEqual(await h.root.skills.get('dsh-badge', { scope: h.agent }), original, '模型步骤外读取不改原registry')
  assert.equal((await h.root.skills.snapshot({ scope: h.agent })).skills.find(value => value.name === 'dsh-badge').description, badgeDescription)
  await h.setRules([{ ...skillRule, enabled: false }])
  const disabled = await h.render()
  assert.equal((await execute(disabled, 'inspect_skill')).value.description, badgeDescription)
  assert.equal((await execute(accepted, 'inspect_skill')).value.description, plainBadgeDescription, '关闭不改变旧步骤')
  await h.setRules([{ ...skillRule, if: { scope: { audience: 'subagent' } } }])
  assert.equal((await execute(await h.render(), 'inspect_skill')).value.description, badgeDescription)
  offBadge()
  await h.setRules([skillRule])
  h.outcomes.length = 0
  const missingStep = await h.render()
  assert.equal((await h.root.skills.snapshot({ scope: h.agent })).skills.some(value => value.name === 'dsh-badge'), false)
  const missing = h.outcomes.find(value => value.channel === 'skill:descriptions' && value.actionId === 'skill-description')
  assert.equal(missing?.identityOutcome, 'target-mismatch')
  assert.match(missing.reason, /dsh-badge.*missing/)
  h.root.skills.register(skill)
  assert.ok((await execute(missingStep, 'skill_search')).value.text.includes(`- dsh-badge: ${badgeDescription}`), '目标恢复不使旧失配步骤提前生效')
  assert.ok((await execute(await h.render(), 'skill_search')).value.text.includes(`- dsh-badge: ${plainBadgeDescription}`), '目标恢复后下一次正常重判生效')
})

test('缺失PTC传输和重复技能目标均保留原面并报告确切说明失配', async t => {
  const unavailable = await harness(t)
  await unavailable.setRules([skillRule])
  await unavailable.render()
  const missingOwner = unavailable.outcomes.find(value => value.channel === 'skill:descriptions')
  assert.equal(missingOwner?.outcome, 'unavailable')
  assert.match(missingOwner.reason, /requires skills service/)
  const h = await harness(t)
  await h.root.plugin(Skills)
  h.root.provide('agents', { list: () => [h.agent] })
  h.root.skills.register({ name: 'dsh-badge', description: `${badgeLead} ${badgeLead}`, content: 'UNCHANGED BODY', source: 'custom' })
  await h.scope.ctx.plugin(skillSearch)
  await h.setRules([ptcRule, skillRule])
  const accepted = await h.render()
  assert.equal(accepted.assembly.tools.some(tool => tool.name === 'run_code'), false)
  const toolDiagnostic = h.outcomes.find(value => value.channel === 'tool:descriptions' && value.actionId === 'description')
  assert.equal(toolDiagnostic?.identityOutcome, 'target-mismatch')
  assert.match(toolDiagnostic.reason, /run_code.*missing/)
  const skillDiagnostic = h.outcomes.find(value => value.channel === 'skill:descriptions' && value.actionId === 'skill-description')
  assert.equal(skillDiagnostic?.identityOutcome, 'target-mismatch')
  assert.match(skillDiagnostic.reason, /dsh-badge.*ambiguous/)
  const search = (await h.services.tools.execute({ agent: h.agent, signal: h.signal, toolSet: accepted.set,
    calls: [{ type: 'tool-call', id: 'ambiguous', name: 'skill_search', arguments: '{}' }] })).results[0].result
  assert.equal(search.isError, false)
  assert.ok(search.value.text.includes(`- dsh-badge: ${badgeLead} ${badgeLead}`))
})

const delegation = 'You are a delegated subagent: your permission scope was fixed when you were started and cannot be widened from inside this session — operations that require approval are rejected automatically. When the task needs access beyond that scope, do not retry the denied operation; state the limitation in your reply so the delegating agent can handle it.'
const delegatedGuidance = 'You are a delegated subagent. Continue the task within the available scope; report unavailable access to the delegating agent.'

test('子代理说明精确替换真实具名上下文，主会话、任务与实际工具范围保持', async t => {
  for (const child of [true, false]) {
    const h = await harness(t, { child })
    h.root.systemPrompt.context({ name: 'subagent:delegation', order: 10, text: delegation })
    h.root.systemPrompt.context({ name: 'subagent:task', order: 20, text: `TASK BODY ${delegation}` })
    h.root.systemPrompt.context({ name: 'unrelated', order: 30, text: delegation })
    for (const name of ['allowed', 'denied']) h.root.tools.register({ name, description: name, parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'string' }, render: () => [] }, execute: () => `RAN ${name}` })
    h.root.tools.guard(exec => exec.name === 'denied' ? 'ORIGINAL SCOPE DENIAL' : undefined)
    const rule = { id: 'subagent-guidance', if: { scope: { audience: 'subagent' } }, then: [{ id: 'scope-description', kind: 'assembly',
      target: { contexts: { replace: [{ name: 'subagent:delegation', match: delegation, text: delegatedGuidance }] } } }] }
    await h.setRules([rule])
    const active = await h.render()
    const context = (step, name) => step.assembly.contexts.find(value => value.name === name).text
    assert.equal(context(active, 'subagent:delegation'), child ? delegatedGuidance : delegation)
    assert.equal(context(active, 'subagent:task'), `TASK BODY ${delegation}`)
    assert.equal(context(active, 'unrelated'), delegation)
    assert.deepEqual(active.assembly.tools.map(tool => tool.name).sort(), ['allowed', 'denied'])
    const result = await h.services.tools.execute({ agent: h.agent, signal: h.signal, toolSet: active.set, calls: [
      { type: 'tool-call', id: 'allowed', name: 'allowed', arguments: '{}' },
      { type: 'tool-call', id: 'denied', name: 'denied', arguments: '{}' },
    ] })
    assert.equal(result.results[0].result.value, 'RAN allowed')
    assert.equal(result.results[1].result.isError, true)
    assert.equal(result.results[1].result.error.message, 'ORIGINAL SCOPE DENIAL')
    const refreshed = h.services.prompt.refreshContext(active.assembly, active.context)
    assert.equal(refreshed.contexts.find(value => value.name === 'subagent:delegation').text, child ? delegatedGuidance : delegation)
    await h.setRules([{ ...rule, enabled: false }])
    assert.equal(context(await h.render(), 'subagent:delegation'), delegation)
    assert.equal(context(active, 'subagent:delegation'), child ? delegatedGuidance : delegation)
  }
})
