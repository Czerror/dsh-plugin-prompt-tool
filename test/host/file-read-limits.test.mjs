import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import * as Native from '@deepseek-ai/dsh-tool-executor-native'
import { compileRules } from '../../engine/rule-spec.mjs'
import { createRuleRuntime } from '../../engine/rule-runtime.mjs'
import { readLimitsState } from '../../engine/read-limits.mjs'

const control = value => ({ id: 'read', kind: 'host-control', capability: 'file-read-limits', value })
const source = (moduleId, value) => ({ moduleId, rules: compileRules([{ id: 'limits', then: [control(value)] }], { moduleId }) })

test('读取工具消费各自已接受步骤，热更新、主子并发及释放不混入其他额度', async t => {
  const root = new Context()
  await root.plugin(SystemPrompt)
  await root.plugin(Tools)
  await root.plugin(Native)
  root.provide('fs', {})
  root.provide('workingDirectory', {})
  const available = readLimitsState.available
  readLimitsState.available = true
  const main = { id: 'read-main', session: { id: 'read-main', header: {}, snapshotEvents: () => [] } }
  const child = { id: 'read-child', session: { id: 'read-child', header: { parent: 'read-main' }, snapshotEvents: () => [] } }
  for (const agent of [main, child]) agent.ctx = createScope(root, agent).ctx
  const runtimes = [main, child].map(agent => createRuleRuntime(agent.ctx, { agent }))
  const frames = []
  t.after(async () => {
    for (const frame of frames) frame.toolSet.dispose()
    for (const runtime of runtimes) runtime.dispose()
    await root.fiber.dispose()
    readLimitsState.available = available
  })
  runtimes[0].replace([source('main', { limit: 3 }), source('bytes', { maxBytes: 7 })])
  runtimes[1].replace([source('child', { limit: 9 })])
  const services = new Map()
  for (const agent of [main, child]) await agent.ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(ctx) {
    services.set(agent, { tools: ctx.tools, prompt: ctx.systemPrompt })
    ctx.effect(() => ctx.tools.register(readLimitsState.mark(ctx, {
      name: 'read', description: 'Read limits consumer',
      parameters: { type: 'object', properties: { limit: { type: 'integer', description: 'Original line limit.' } } },
      output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: (_args, exec) => readLimitsState.read(ctx, exec, { limit: 20, maxBytes: 100, maxLineLength: 30 }),
    })))
  } })
  const prepare = async agent => {
    const { tools, prompt } = services.get(agent)
    const context = { agent, scope: scopeOf(agent.ctx), signal: new AbortController().signal }
    const toolSet = await tools.resolve(context)
    const frame = { ...context, toolSet }
    frames.push(frame)
    await prompt.assemble(frame)
    return frame
  }
  const call = async frame => (await services.get(frame.agent).tools.execute({ ...frame, calls: [
    { type: 'tool-call', id: 'read', name: 'read', arguments: '{}' },
  ] })).results[0].result.value
  const [first, childFrame] = await Promise.all([prepare(main), prepare(child)])
  assert.deepEqual(await call(first), { limit: 3, maxBytes: 7, maxLineLength: 30 })
  assert.deepEqual(await call(childFrame), { limit: 9, maxBytes: 100, maxLineLength: 30 })
  assert.throws(() => runtimes[0].replace([source('bad-a', { limit: 4 }), source('bad-b', { limit: 5 })]), /limit.*conflict/)
  assert.deepEqual(await call(await prepare(main)), { limit: 3, maxBytes: 7, maxLineLength: 30 })
  runtimes[0].replace([source('main', { limit: 6 })])
  assert.deepEqual(await call(await prepare(main)), { limit: 6, maxBytes: 100, maxLineLength: 30 })
  assert.deepEqual(await call(first), { limit: 3, maxBytes: 7, maxLineLength: 30 })
  runtimes[0].dispose()
  assert.deepEqual(await call(await prepare(main)), { limit: 20, maxBytes: 100, maxLineLength: 30 })
  assert.deepEqual(await call(childFrame), { limit: 9, maxBytes: 100, maxLineLength: 30 })
})

test('读取额度沿普通规则编译校验，允许独立字段且拒绝非法数字和空配置', () => {
  for (const value of [{ maxLineLength: 10000, maxBytes: 1048576, limit: 20000 }, { limit: 3 }]) {
    assert.doesNotThrow(() => source('read', value))
  }
  for (const value of [{}, { limit: 0 }, { maxBytes: -1 }, { maxLineLength: 1.5 }, { limit: '' },
    { limit: '2e' }, { maxBytes: Number.MAX_SAFE_INTEGER + 1 }, { streamMinSize: 1 }]) {
    assert.throws(() => source('read', value), /file-read-limits|positive safe integer/)
  }
  assert.throws(() => compileRules([{ id: 'unknown', then: [
    { ...control({ limit: 3 }), capability: 'not-a-capability' },
  ] }]), /capability/)
})

test('读取额度完整候选同值共存、不同字段合并，异值拒绝后保留原贡献', async t => {
  const root = new Context()
  await root.plugin(SystemPrompt)
  const agent = { id: 'read-candidate', session: { id: 'read-candidate', header: {}, snapshotEvents: () => [] } }
  agent.ctx = createScope(root, agent).ctx
  const runtime = createRuleRuntime(agent.ctx, { agent })
  t.after(async () => { runtime.dispose(); await root.fiber.dispose() })
  for (const [field, independent] of [['limit', 'maxBytes'], ['maxBytes', 'maxLineLength'], ['maxLineLength', 'limit']]) {
    const good = [source('a', { [field]: 3 }), source('b', { [field]: 3 }), source('c', { [independent]: 7 })]
    assert.doesNotThrow(() => runtime.replace(good))
    assert.throws(() => runtime.replace([...good, source('d', { [field]: 4 })]), new RegExp(`file-read-limits.*${field}.*conflict`))
    assert.doesNotThrow(() => runtime.replace(good))
  }
})

test('读取额度动态条件出现异值时拒绝新步骤，不悄悄采用官方值或排序赢家', async t => {
  const root = new Context()
  await root.plugin(SystemPrompt)
  const agent = { id: 'read-dynamic', session: { id: 'read-dynamic', header: {}, snapshotEvents: () => [] } }
  agent.ctx = createScope(root, agent).ctx
  let mode = 'left'
  const runtime = createRuleRuntime(agent.ctx, { agent, variableStore: { read: () => ({ effective: { mode } }) } })
  t.after(async () => { runtime.dispose(); await root.fiber.dispose() })
  runtime.replace([{ moduleId: 'dynamic', rules: compileRules([
    { id: 'left', if: { variable: { key: 'mode', op: 'ne', value: 'right' } }, then: [control({ limit: 3 })] },
    { id: 'right', if: { variable: { key: 'mode', op: 'ne', value: 'left' } }, then: [control({ limit: 4 })] },
  ]) }])
  assert.doesNotThrow(() => runtime.prepareAssembly({ agent, scope: scopeOf(agent.ctx) }))
  mode = 'both'
  assert.throws(() => runtime.prepareAssembly({ agent, scope: scopeOf(agent.ctx) }), /file-read-limits.*limit.*conflict/)
  mode = 'right'
  assert.doesNotThrow(() => runtime.prepareAssembly({ agent, scope: scopeOf(agent.ctx) }), '消除冲突后下一次正常重判恢复')
})

test('缺少读取接缝只暂停同分支后代，保留独立正文和启用意图', async t => {
  const root = new Context()
  await root.plugin(SystemPrompt)
  await root.plugin(Tools)
  await root.plugin(Native)
  const agent = { id: 'read-dependency', session: { id: 'read-dependency', header: {}, snapshotEvents: () => [] } }
  agent.ctx = createScope(root, agent).ctx
  const observations = []
  const runtime = createRuleRuntime(agent.ctx, { agent, onOutcome: value => observations.push(value) })
  t.after(async () => { runtime.dispose(); await root.fiber.dispose() })
  const body = (id, text) => ({ id, kind: 'inject-text', config: { layer: 'system-section', text } })
  const rules = compileRules([{ id: 'dependent', then: [{ if: { scope: { audience: 'main' } }, then: [
    control({ limit: 3 }), { if: { scope: { audience: 'main' } }, then: [body('dependent', 'DEPENDENT READ BODY')] },
  ] }, body('sibling', 'INDEPENDENT SIBLING')] }, { id: 'independent', then: [body('control', 'INDEPENDENT CONTROL')] },
  { id: 'child-only', if: { scope: { audience: 'subagent' } }, then: [control({ limit: 7 })] }])
  runtime.replace([{ moduleId: 'dependency', rules }])
  let services
  await agent.ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(ctx) { services = { tools: ctx.tools, prompt: ctx.systemPrompt } } })
  for (let index = 0; index < 2; index++) {
    const context = { agent, scope: scopeOf(agent.ctx), signal: new AbortController().signal }
    const toolSet = await services.tools.resolve(context)
    const assembly = await services.prompt.assemble({ ...context, toolSet })
    assert.equal(assembly.sections.some(value => value.text.includes('DEPENDENT READ BODY')), false)
    assert.ok(assembly.sections.some(value => value.text.includes('INDEPENDENT SIBLING')))
    assert.ok(assembly.sections.some(value => value.text.includes('INDEPENDENT CONTROL')))
    toolSet.dispose()
  }
  assert.equal(rules[0].enabled, true, '不可用不改写原启用意图')
  assert.ok(observations.some(value => value.channel === 'host:file-read-limits' && value.outcome === 'unavailable'
    && /early|入口|重启/.test(value.reason)))
  assert.ok(observations.some(value => value.ruleId === 'child-only' && value.channel === 'host:file-read-limits'
    && value.identityOutcome === 'condition-miss'), '受众不符沿普通miss，不伪报依赖不可用')
})
