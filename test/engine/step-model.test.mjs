import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { compileRules } from '../../engine/rule-spec.mjs'
import { mountRuleSources } from '../../engine/rule-runtime.mjs'
import { createPromptConfigs } from '../../engine/schema.mjs'
import { mountPreStepConfigs } from '../fixtures/pre-step.mjs'
import { registerAction } from '../../engine/actions.mjs'

test('步骤模型事实：真实装配采用第二实参捕获选择，切换与重试不改变本步', async t => {
  const root = new Context()
  await root.plugin(SystemPrompt)
  t.after(() => root.fiber.dispose())
  let nextModel = 'deepseek-pro'
  const agent = { session: { id: 'step-model', header: {}, snapshotEvents: () => [] },
    options: { model: 'deepseek-pro' }, model: { current: () => ({ model: nextModel }) } }
  createScope(root, agent)
  const dispose = mountRuleSources(root, [{ moduleId: 'model', rules: compileRules([
    { id: 'flash', if: { scope: { modelScope: 'flash' } }, then: [
      { id: 'text', kind: 'inject-text', config: { layer: 'system-section', text: 'CAPTURED FLASH' } },
    ] },
  ]) }])
  t.after(dispose)
  const step = { agent, scope: agent, model: 'payload-pro', modelSelection: { provider: 'test', model: 'deepseek-flash' } }
  const assemble = context => root.systemPrompt.assemble(context).then(result => result.sections.map(entry => entry.text).filter(text => text === 'CAPTURED FLASH'))
  assert.deepEqual(await assemble(step), ['CAPTURED FLASH'])
  nextModel = 'next-pro'
  assert.deepEqual(await assemble(step), ['CAPTURED FLASH'], '重试保留步骤选择')
  assert.deepEqual(await assemble({ ...step, modelSelection: { provider: 'test', model: nextModel } }), [])
})

test('步骤模型事实：缺失、空串与非法事实不回退，not/any 保留三值与精确受众', async t => {
  const root = new Context()
  await root.plugin(SystemPrompt)
  t.after(() => root.fiber.dispose())
  const agent = { session: { id: 'missing-model', header: {}, snapshotEvents: () => [] },
    options: { model: 'fallback-flash' }, model: { current: () => ({ model: 'next-flash' }) } }
  createScope(root, agent)
  const scopes = [
    ['flash', { scope: { modelScope: 'flash' } }],
    ['pro', { scope: { modelScope: 'pro' } }],
    ['not', { not: { scope: { audience: 'main', modelScope: 'flash' } } }],
    ['any', { any: [{ scope: { modelScope: 'flash' } }, { scope: { audience: 'subagent' } }] }],
    ['all', { scope: { modelScope: 'all' } }],
  ]
  const dispose = mountRuleSources(root, [{ moduleId: 'missing', rules: compileRules(scopes.map(([id, condition]) => ({
    id, if: condition, then: [{ id: `${id}-text`, kind: 'inject-text', config: { layer: 'system-section', text: id.toUpperCase() } }],
  }))) }])
  t.after(dispose)
  const assemble = async extra => (await root.systemPrompt.assemble({ agent, scope: agent, ...extra })).sections
    .filter(entry => entry.name.startsWith('prompt-tool:')).map(entry => entry.text).filter(Boolean)
  for (const extra of [{ step: 1 }, { modelSelection: {} }, { modelSelection: { model: '' } },
    { modelSelection: { model: '  ' } }, { modelSelection: { model: {} } }, { toolSet: {} }]) {
    assert.deepEqual(await assemble(extra), ['ALL'], JSON.stringify(extra))
  }
  assert.deepEqual(await assemble({ model: 'actual-flash', modelSelection: {} }), ['FLASH', 'ANY', 'ALL'], '旧字段仅作为捕获字段回退')
  assert.deepEqual(await assemble({}), ['FLASH', 'ANY', 'ALL'], '无步骤装配允许读取下一选择')
})

test('步骤模型事实：pre-step 批过滤保留捕获选择并拒绝缺失事实', async () => {
  const listeners = new Map()
  const ctx = { get() {}, on(name, handler) { listeners.set(name, handler); return () => listeners.delete(name) },
    effect() {}, logger: { warn() {} } }
  const dispose = mountPreStepConfigs(ctx, createPromptConfigs([
    { id: 'flash', strategy: 'static', text: 'FLASH', modelScope: 'flash', position: 'after-all' },
    { id: 'pro', strategy: 'static', text: 'PRO', modelScope: 'pro', position: 'after-all' },
    { id: 'all', strategy: 'static', text: 'ALL', modelScope: 'all', position: 'after-all' },
  ]))
  const agent = { session: { id: 'pre-model', header: {}, snapshotEvents: () => [] }, options: { model: 'next-pro' } }
  const run = async payload => (await listeners.get('agent/pre-step')({ agent, ...payload }, async () => ({ kind: 'enter', messages: [] })))
    .messages.flatMap(message => message.content.map(block => block.text))
  try {
    assert.deepEqual(await run({ modelSelection: { model: 'captured-flash' }, step: 1 }), ['FLASH', 'ALL'])
    assert.deepEqual(await run({ modelSelection: { model: '' }, step: 1 }), ['ALL'])
  } finally { dispose() }
})

test('步骤模型事实：请求动作层按捕获模型过滤，缺步骤事实不冒用下一选择', async () => {
  const listeners = new Map()
  const ctx = { get() {}, on(name, handler) { listeners.set(name, handler); return () => listeners.delete(name) }, logger: { warn() {} } }
  const dispose = registerAction(ctx, { id: 'request', kind: 'request-params', modelScope: 'flash', patch: { maxTokens: 123 } })
  const agent = { session: { header: {} }, options: { model: 'fallback-pro' }, model: { current: () => ({ model: 'next-pro' }) } }
  const request = extra => listeners.get('agent/request')({ agent, ...extra }, async () => ({ maxTokens: 1 }))
  try {
    assert.deepEqual(await request({ step: 1, modelSelection: { model: 'captured-flash' } }), { maxTokens: 123 })
    assert.deepEqual(await request({ step: 1 }), { maxTokens: 1 })
  } finally { dispose() }
})

test('步骤模型事实：子代理注入与工具规则保留捕获模型，程序调用不伪造步骤', async () => {
  const listeners = new Map(), injected = []
  const child = { session: { id: 'model-child', header: { delegationDepth: 1 }, snapshotEvents: () => [] },
    options: { model: 'next-pro' }, inject: message => injected.push(message.content[0].text) }
  const agents = new Map([[child.session.id, child]])
  const ctx = { get: name => name === 'agents' ? agents : undefined,
    on(name, handler) { const handlers = listeners.get(name) ?? []; handlers.push(handler); listeners.set(name, handlers);
      return () => listeners.set(name, handlers.filter(entry => entry !== handler)) }, logger: { warn() {} } }
  const dispose = mountRuleSources(ctx, [{ moduleId: 'child', rules: compileRules([{
    id: 'flash', if: { scope: { modelScope: 'flash' } }, then: [
      { id: 'start', kind: 'inject-text', config: { layer: 'subagent-start', text: 'CHILD FLASH' } },
      { id: 'gate', kind: 'tool-gate', decision: 'deny' },
    ],
  }]) }])
  try {
    for (const handler of listeners.get('subagent/start')) await handler({ id: child.session.id, modelSelection: { model: 'captured-flash' }, step: 1 })
    assert.deepEqual(injected, ['CHILD FLASH'])
    const invoke = async extra => {
      const handlers = listeners.get('tools/pre-execute')
      const payload = { agent: child, name: 'read', arguments: {}, ...extra }
      const run = index => index === handlers.length ? 'EXECUTED' : handlers[index](payload, () => run(index + 1))
      return run(0)
    }
    assert.notEqual(await invoke({ toolSet: {}, modelSelection: { model: 'captured-flash' } }), 'EXECUTED')
    assert.equal(await invoke({ toolSet: {} }), 'EXECUTED', '缺捕获事实的工具集合不以下一模型命中')
    assert.equal(await invoke({}), 'EXECUTED', '程序调用无步骤，不以 options 伪造步骤模型')
  } finally { dispose() }
})
