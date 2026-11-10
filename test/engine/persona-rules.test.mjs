import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { bindScopeParent, createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import { compileRules } from '../../engine/rule-spec.mjs'
import { createRuleRuntime } from '../../engine/rule-runtime.mjs'
import { instructionsBudgetState } from '../../engine/instructions-budget-bridge.mjs'

test('人设规则按配置序号拼接，动态失配撤回并恢复官方身份', async t => {
  const root = new Context()
  await root.plugin(SystemPrompt)
  const agent = { id: 'persona', status: 'idle', session: { id: 'persona', header: {}, snapshotEvents: () => [] } }
  const scope = createScope(root, agent)
  agent.ctx = scope.ctx
  const official = { name: 'deployment:persona-prefix', order: 0, text: 'OFFICIAL', complete: true }
  const standing = createScope(root, {})
  standing.ctx.get('systemPrompt').section(official)
  bindScopeParent(scopeOf(scope.ctx), scopeOf(standing.ctx))
  let mode = 'coding', commits = 0, publications = 0
  const values = { module: { n: '0' }, global: { n: '0' } }
  const runtime = createRuleRuntime(scope.ctx, { agent, persona: { inherited: name => name === official.name ? official : undefined },
    variableStore: {
      read: () => ({ ...values, session: { n: '0' }, effective: { mode }, revisions: { module: values.module.n, global: values.global.n } }),
      commit: (_id, request) => { commits++; Object.assign(values[request.scope], request.changes); return { publicationPending: true } },
      publish: () => { publications++ },
    } })
  t.after(async () => { runtime.dispose(); await scope.dispose(); await standing.dispose(); await root.fiber.dispose() })
  const source = (moduleId, text, sequence) => ({ moduleId, rules: compileRules([{ id: 'identity',
    if: { variable: { key: 'mode', value: 'coding' } },
    then: [{ id: 'identity', kind: 'persona', prefix: text, complete: false }],
  }], { moduleId, configOrder: { identity: sequence } }) })
  runtime.replace([source('a', 'LATE', 20), source('b', 'EARLY', 10)])
  const render = async () => {
    const context = { agent, scope: scopeOf(scope.ctx) }
    runtime.prepareAssembly(context)
    return (await scope.ctx.get('systemPrompt').assemble(context)).sections
  }
  assert.equal((await render()).find(section => section.name === official.name).text, 'EARLY\n\nLATE')
  mode = 'general'
  assert.deepEqual((await render()).map(section => section.text), ['OFFICIAL'])
  mode = 'coding'
  assert.equal((await render()).find(section => section.name === official.name).text, 'EARLY\n\nLATE')
  const setterRules = () => compileRules([{ id: 'setters', then: [
    { id: 'module', kind: 'persona', prefix: 'M={{module.inc::n}}', complete: false },
    { id: 'global', kind: 'persona', suffix: 'G={{global.inc::n}}', complete: false },
  ] }])
  const setters = () => runtime.replace([{ moduleId: 'writes', rules: setterRules() }])
  assert.doesNotThrow(setters, '挂载预检允许旧持久域赋值语法，但不提交')
  assert.deepEqual(values, { module: { n: '0' }, global: { n: '0' } })
  assert.equal(commits, 0)
  const events = [{ type: 'turn/start', seq: 0, data: { turn: 1 } }]
  agent.status = 'running'
  agent.session.snapshotEvents = () => events
  const context = { agent, scope: scopeOf(scope.ctx), signal: new AbortController().signal }
  const execute = async () => {
    runtime.prepareAssembly(context)
    return (await scope.ctx.get('systemPrompt').assemble(context)).sections.filter(section => section.name.startsWith('deployment:persona')).map(section => section.text)
  }
  assert.deepEqual(await execute(), ['M=1', 'G=1'])
  assert.equal(commits, 2)
  assert.equal(publications, 0)
  setters()
  assert.equal(commits, 2, '重挂预检不提交，也不消费真实执行凭据')
  assert.equal(publications, 0, '挂载不重试待发布凭据')
  assert.deepEqual(await execute(), ['M=1', 'G=1'])
  assert.equal(commits, 2, '同一次真实执行不重放赋值')
  assert.equal(publications, 2)
  events.push({ type: 'step/end', seq: 1, data: {} })
  assert.deepEqual(await execute(), ['M=2', 'G=2'])
  assert.equal(commits, 4)
  assert.throws(() => runtime.replace([{ moduleId: 'writes', rules: compileRules([{ id: 'session', then: [
    { id: 'blocked', kind: 'persona', prefix: '{{session.inc::n}}' },
  ] }]) }]), /asynchronous rule or tool/)
  assert.equal(commits, 4, '人设仍不得提交session赋值')
  assert.deepEqual(await execute(), ['M=2', 'G=2'], '被拒候选保留原人设及执行凭据')
  runtime.dispose()
  assert.deepEqual((await scope.ctx.get('systemPrompt').assemble({ agent, scope: scopeOf(scope.ctx) })).sections.map(section => section.text), ['OFFICIAL'])
})

test('人设候选布尔冲突或半组注册失败时保留完整旧贡献', async t => {
  const root = new Context()
  await root.plugin(SystemPrompt)
  const agent = { id: 'conflict', session: { id: 'conflict', header: {}, snapshotEvents: () => [] } }
  const scope = createScope(root, agent)
  const runtime = createRuleRuntime(scope.ctx, { agent })
  t.after(async () => { runtime.dispose(); await scope.dispose(); await root.fiber.dispose() })
  const source = actions => ({ moduleId: 'source', rules: compileRules([{ id: 'identity', then: actions }]) })
  runtime.replace([source([{ id: 'good', kind: 'persona', prefix: 'GOOD', suffix: 'TAIL', complete: false }])])
  const context = { agent, scope: scopeOf(scope.ctx) }
  const texts = async () => (await scope.ctx.get('systemPrompt').assemble(context)).sections.filter(section => section.name.startsWith('deployment:persona')).map(section => section.text)
  for (const flag of ['complete', 'includeRuntimeContext']) {
    assert.throws(() => runtime.replace([source([{ id: 'yes', kind: 'persona', prefix: 'BAD', [flag]: true },
      { id: 'no', kind: 'persona', suffix: 'BAD', [flag]: false }])]), /conflict/)
    assert.deepEqual(await texts(), ['GOOD', 'TAIL'])
  }
  const prompt = root.systemPrompt
  const section = prompt.section
  t.mock.method(prompt, 'section', function (value) {
    if (value.text === 'FAIL') throw new Error('REGISTER-FAIL')
    return section.call(this, value)
  })
  assert.throws(() => runtime.replace([source([{ id: 'broken', kind: 'persona', prefix: 'PARTIAL', suffix: 'FAIL', complete: false }])]), /REGISTER-FAIL/)
  assert.deepEqual(await texts(), ['GOOD', 'TAIL'])
  assert.throws(() => runtime.replace([source([{ id: 'one', kind: 'persona', prefix: 'NEW', instructionsMaxBytes: 65536 },
    { id: 'two', kind: 'persona', instructionsMaxBytes: 512 }])]), /instructionsMaxBytes.*conflict/)
  assert.deepEqual(await texts(), ['GOOD', 'TAIL'], '预算与人设作为完整候选拒绝，旧正文不被替换')
  const complete = { id: 'complete', then: [{ id: 'exclusive', kind: 'inject-text', config: { layer: 'system-section', text: 'EXCLUSIVE', params: { complete: true } } }] }
  assert.throws(() => runtime.replace([{ moduleId: 'source', rules: compileRules([complete, { id: 'persona', then: [{ id: 'identity', kind: 'persona', prefix: 'BAD', complete: true }] }]) }]), /multiple complete/)
  assert.deepEqual(await texts(), ['GOOD', 'TAIL'])
})

test('人设字段省略、空串和不可用条件分别保留继承与三值语义', async t => {
  const root = new Context()
  await root.plugin(SystemPrompt)
  const agent = { id: 'boundary', session: { id: 'boundary', header: {}, snapshotEvents: () => [] } }
  const scope = createScope(root, agent)
  const standing = createScope(root, {})
  bindScopeParent(scopeOf(scope.ctx), scopeOf(standing.ctx))
  const official = { name: 'deployment:persona-prefix', order: 0, text: 'RAW {{untouched}}', complete: true, interpolate: false }
  standing.ctx.get('systemPrompt').section(official)
  let available = true, runtimeValue = 'FACT'
  const runtime = createRuleRuntime(scope.ctx, { agent, persona: { inherited: name => name === official.name ? official : undefined },
    variableStore: { read: () => ({ enabled: available, module: {}, global: {}, effective: {} }), readRuntime: () => runtimeValue } })
  t.after(async () => { runtime.dispose(); await scope.dispose(); await standing.dispose(); await root.fiber.dispose() })
  const replace = rules => runtime.replace([{ moduleId: 'source', rules: compileRules(rules) }])
  const context = { agent, scope: scopeOf(scope.ctx) }
  const read = async () => { runtime.prepareAssembly(context); return (await scope.ctx.get('systemPrompt').assemble(context)).sections.find(section => section.name === official.name) }
  replace([{ id: 'inherit', then: [{ id: 'flags', kind: 'persona', complete: false }] }])
  assert.equal((await read()).text, 'RAW {{untouched}}')
  assert.equal((await read()).interpolate, false)
  replace([{ id: 'empty', then: [{ id: 'blank', kind: 'persona', prefix: '', complete: false }] }])
  assert.equal((await read()).text, '')
  replace([{ id: 'mixed', then: [{ id: 'blank', kind: 'persona', prefix: '', complete: false }, { id: 'body', kind: 'persona', prefix: 'BODY', complete: false }] }])
  assert.equal((await read()).text, 'BODY')
  replace([{ id: 'unknown', if: { not: { variable: { key: 'missing', value: 'yes' } } },
    then: [{ id: 'hit', kind: 'persona', prefix: 'KNOWN', complete: false }],
    else: [{ id: 'else', kind: 'persona', prefix: 'ELSE', complete: false }] }])
  assert.equal((await read()).text, 'KNOWN')
  available = false
  assert.equal((await read()).text, 'RAW {{untouched}}', 'UNAVAILABLE 不经 not 或 else 变成命中')
  available = true
  replace([{ id: 'fact', then: [{ id: 'body', kind: 'persona', prefix: '{{runtime.get::session.id}}', complete: false }] }])
  assert.equal((await read()).text, 'FACT')
  runtimeValue = undefined
  assert.equal((await read()).text, 'RAW {{untouched}}', '正文所需事实不可用时同样撤回身份')
})

test('预算观测只来自实际采用的完整计划，冲突保留旧观测且正常else按miss记录', async t => {
  const root = new Context(); await root.plugin(SystemPrompt)
  root.provide('fs', {}); root.provide('workingDirectory', {})
  const agent = { id: 'budget-observation', session: { id: 'budget-observation', header: {}, snapshotEvents: () => [] } }
  const scope = createScope(root, agent); agent.ctx = scope.ctx
  instructionsBudgetState.available = true; instructionsBudgetState.track(root)
  const reports = []; let conflict = false
  const runtime = createRuleRuntime(scope.ctx, { agent, externalAssembly: true, onOutcome: report => reports.push(report),
    variableStore: { read: () => ({ module: {}, global: {}, effective: { conflict: conflict ? 'yes' : 'no' } }) } })
  t.after(async () => { runtime.dispose(); instructionsBudgetState.available = false; await scope.dispose(); await root.fiber.dispose() })
  runtime.replace([{ moduleId: 'budget', rules: compileRules([
    { id: 'stable', if: { scope: { audience: 'main' } }, then: [{ id: 'main', kind: 'persona', prefix: 'OLD', complete: false, instructionsMaxBytes: 1024 }], else: [{ id: 'child', kind: 'persona', instructionsMaxBytes: 512 }] },
    { id: 'dynamic', if: { variable: { key: 'conflict', value: 'yes' } }, then: [{ id: 'new', kind: 'persona', prefix: 'NEW', instructionsMaxBytes: 2048 }] },
  ]) }])
  const context = { agent, scope: scopeOf(scope.ctx) }
  runtime.prepareAssembly(context)
  const assembly = await runtime.settleToolSurface(await scope.ctx.get('systemPrompt').assemble(context), context)
  assert.ok(assembly.sections.some(section => section.text === 'OLD'))
  assert.equal(reports.find(report => report.actionId === 'child' && report.channel === 'persona:instructions').identityOutcome, 'condition-miss')
  const before = reports.filter(report => report.channel === 'persona:instructions').length
  conflict = true
  assert.throws(() => runtime.prepareAssembly({ ...context }), /instructionsMaxBytes.*conflict/)
  assert.equal(runtime.readInstructionsBudget(), 1024)
  assert.equal(reports.filter(report => report.channel === 'persona:instructions').length, before, '失败候选不发布任何新预算观测')
})
