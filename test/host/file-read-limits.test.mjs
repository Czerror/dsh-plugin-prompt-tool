import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import * as Native from '@deepseek-ai/dsh-tool-executor-native'
import { compileRules } from '../../engine/rule-spec.mjs'
import { createRuleRuntime } from '../../engine/rule-runtime.mjs'

const control = value => ({ id: 'read', kind: 'host-control', capability: 'file-read-limits', value })
const source = (moduleId, value) => ({ moduleId, rules: compileRules([{ id: 'limits', then: [control(value)] }], { moduleId }) })

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
