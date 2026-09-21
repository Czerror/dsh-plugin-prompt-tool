import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { renderPrompt, renderContextSections } from '@deepseek-ai/dsh-system-prompt'
import { createScope } from '@deepseek-ai/dsh-scope'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import { createPromptConfigs } from '../../engine/schema.mjs'
import { applyPromptConfigs } from '../../engine/executor.mjs'
import { wireLayers } from '../../engine/layers.mjs'
import { setSessionVar } from '../../engine/session-vars.mjs'

async function harness(t) {
  const root = new Context()
  const home = mkdtempSync(join(process.cwd(), 'pt-official-vars-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(async () => {
    try {
      await root.fiber.dispose()
    } finally {
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
      rmSync(home, { recursive: true, force: true })
    }
  })
  await root.plugin(SystemPrompt, { includeHarnessIdentity: false })
  return {
    root,
    async mount(specs, prepare = wireLayers) {
      const key = {}
      const warnings = []
      let scope
      await root.plugin(Object.assign((inner) => {
        scope = createScope(inner, key)
        const configs = createPromptConfigs(specs)
        prepare(scope.ctx, configs, (message) => warnings.push(message))
      }, { inject: ['systemPrompt'] }))
      return { ...scope, key, warnings }
    },
    assemble(scope, session) {
      return root.systemPrompt.assemble({ scope: scope.key, agent: { session, options: {} } })
    },
    step(scope, session, messages) {
      const agent = Object.assign(scope.key, { ctx: scope.ctx, session, options: {} })
      return agentEvents(root, agent).waterfall('agent/pre-step', {
        messages, turn: 1, step: 1, signal: new AbortController().signal,
      }, async () => ({ kind: 'enter', messages }))
    },
  }
}

function sessionWith(text = 'LATEST', id = 'main') {
  return {
    id,
    header: { cwd: process.cwd(), delegationDepth: 0 },
    snapshotEvents: () => [{ type: 'user/message', data: { message: { content: [{ type: 'text', text }] } } }],
  }
}

test('官方同 scope：局部同名变量分别绑定，大小写事实只注册一次，等价绑定复用', async (t) => {
  const h = await harness(t)
  const scope = await h.mount([
    { id: 'a', layer: 'system-section', text: 'A={{tone}} {{lastusermessage}}/{{lastUserMessage}}', variables: { tone: 'A', unused: '不注册' } },
    { id: 'a2', layer: 'system-section', text: 'A2={{tone}}', variables: { tone: 'A', unused: '不注册' } },
    { id: 'b', layer: 'runtime-context', text: 'B={{tone}}', variables: { tone: 'B' } },
  ])
  const assembly = await h.assemble(scope, sessionWith())
  assert.equal(renderPrompt(assembly), 'A=A LATEST/LATEST\n\nA2=A')
  assert.deepEqual(renderContextSections(assembly), [{ name: 'b', text: 'B=B' }])
  assert.equal(assembly.variables.lastusermessage, 'LATEST')
  assert.equal(Object.hasOwn(assembly.variables, 'unused'), false)
  assert.equal(Object.keys(assembly.variables).length, 3, '两个 tone 绑定和一个运行时事实')
  assert.deepEqual(scope.warnings, [])
})

test('官方 assembly：嵌套内容值和会话覆盖值先解析再清洗；循环引用不让组装失败', async (t) => {
  const h = await harness(t)
  const scope = await h.mount([{ id: 'nested', layer: 'system-section', text: '{{body}}', variables: { body: 'A{{tone}}{{missing}}', tone: 'B' } }])
  const session = sessionWith()
  assert.equal(renderPrompt(await h.assemble(scope, session)), 'AB')
  setSessionVar(session, 'body', 'S{{tone}}/{{missing}}')
  assert.equal(renderPrompt(await h.assemble(scope, session)), 'SB/')
  setSessionVar(session, 'body', '{{body}}OK')
  assert.ok(renderPrompt(await h.assemble(scope, session)).endsWith('OK'))
  assert.ok(scope.warnings.some(w => w.includes('missing')))
})

test('官方 assembly：空白引用规范化，随机每次重算，兄弟scope和disposer不串', async (t) => {
  const h = await harness(t)
  const a = await h.mount([{ id: 'random', layer: 'system-section', text: '{{time}}/{{ time }}/{{random::A::B}}/{{random::A::B}}' }])
  const b = await h.mount([{ id: 'random', layer: 'system-section', text: 'OTHER' }])
  const session = sessionWith()
  let index = 0
  t.mock.method(Math, 'random', () => [0, 0.99, 0.99, 0][index++ % 4])
  assert.match(renderPrompt(await h.assemble(a, session)), /\/A\/B$/)
  assert.match(renderPrompt(await h.assemble(a, session)), /\/B\/A$/)
  assert.equal(renderPrompt(await h.assemble(b, session)), 'OTHER')
  await a.dispose()
  assert.equal(renderPrompt(await h.assemble(a, session)), '')
  assert.equal(renderPrompt(await h.assemble(b, session)), 'OTHER')
})

for (const hit of [false, true]) {
  test(`V2 官方 assembly 先于 pre-step，条件 setter 只在获准后求值（命中=${hit}）`, async (t) => {
    const h = await harness(t)
    const scope = await h.mount([
      { id: 'setter', order: 0, layer: 'pre-step', text: '{{setvar::x::BAD}}', params: { stMacros: true }, match: { keys: ['NEVER'] } },
      { id: 'system', order: 1, layer: 'system-section', text: 'SYS[{{getvar::x::EMPTY}}]', params: { stMacros: true } },
      { id: 'reader', order: 2, layer: 'pre-step', position: 'after-all', text: 'PRE[{{getvar::x::EMPTY}}]', params: { stMacros: true } },
    ], (ctx, configs) => applyPromptConfigs(ctx, configs))
    const session = sessionWith()
    session.snapshotEvents = () => [{ type: 'turn/start', seq: 1, data: { turn: 1 } }]
    assert.equal(renderPrompt(await h.assemble(scope, session)), 'SYS[EMPTY]', '尚无本批资格，官方组装不得执行 pre-step setter')
    assert.equal(renderPrompt(await h.assemble(scope, session)), 'SYS[EMPTY]', '重复组装仍不执行')
    const message = { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: hit ? 'NEVER' : 'ordinary' }] }
    const decision = await h.step(scope, session, [message])
    assert.equal(decision.messages.at(-1).content[0].text, hit ? 'PRE[BAD]' : 'PRE[EMPTY]')
    assert.equal(renderPrompt(await h.assemble(scope, session)), 'SYS[EMPTY]', '同一步已求值的官方文本保持稳定')
  })
}

for (const [layer, conditional] of [
  ['agent-request', false], ['llm-stream', false], ['tool-pipeline', true],
  ['turn-stop', true], ['subagent-start', true], ['subagent-end', true],
]) {
  test(`V2 官方 assembly 不求值其他插入点模板：${layer}`, async (t) => {
    const h = await harness(t)
    const scope = await h.mount([
      { id: 'setter', layer, order: 0, text: '{{setvar::x::BAD}}', params: { stMacros: true },
        ...(conditional ? { match: { keys: ['NEVER'] } } : {}) },
      { id: 'system', layer: 'system-section', order: 1, text: 'SYS[{{getvar::x::EMPTY}}]', params: { stMacros: true } },
      { id: 'context', layer: 'runtime-context', order: 2, text: 'CTX[{{getvar::x::EMPTY}}]', params: { stMacros: true } },
      { id: 'reader', layer: 'pre-step', order: 3, position: 'after-all', text: 'PRE[{{getvar::x::EMPTY}}]', params: { stMacros: true } },
    ], (ctx, configs) => applyPromptConfigs(ctx, configs))
    const session = { id: layer, header: {}, snapshotEvents: () => [{ type: 'turn/start', seq: 1, data: { turn: 1 } }] }
    for (let repeat = 0; repeat < 2; repeat++) {
      const assembly = await h.assemble(scope, session)
      assert.equal(renderPrompt(assembly), 'SYS[EMPTY]', '未进入配置所属插入点，setter 不得污染官方文本')
      assert.deepEqual(renderContextSections(assembly), [{ name: 'context', text: 'CTX[EMPTY]' }])
    }
    assert.equal((await h.step(scope, session, [])).messages.at(-1).content[0].text, 'PRE[EMPTY]')
  })
}

for (const { name, setter = {}, depth = 0, promoted = false, delivered = false, inBatch = false, expected = 'EMPTY' } of [
  { name: '禁用', setter: { enabled: false } },
  { name: '子代理限定对主会话不生效', setter: { audience: 'subagent' } },
  { name: '主会话限定对子代理不生效', setter: { audience: 'main' }, depth: 1 },
  { name: '子代理受众命中', setter: { audience: 'subagent' }, depth: 1, expected: '1' },
  { name: '模型不匹配', setter: { modelScope: 'flash' } },
  { name: '主会话未晋升', setter: { promotion: 'main' } },
  { name: '主会话晋升后生效', setter: { promotion: 'main' }, promoted: true, expected: '1' },
  { name: '子代理默认已晋升', setter: { promotion: 'main' }, depth: 1, expected: '1' },
  { name: '显式约束子代理晋升', setter: { promotion: 'include-subagents' }, depth: 1 },
  { name: '会话去重已投递', setter: { dedupe: 'session' }, delivered: true },
  { name: '批去重已有身份', setter: { dedupe: 'batch' }, inBatch: true },
]) {
  test(`V2 官方组装与 pre-step 共享资格边界：${name}`, async (t) => {
    const h = await harness(t)
    const scope = await h.mount([
      { id: 'setter', order: 0, layer: 'pre-step', position: 'after-all', text: '{{setvar::n::1}}SET', params: { stMacros: true }, ...setter },
      { id: 'system', order: 1, layer: 'system-section', text: 'SYS[{{getvar::n::EMPTY}}]', params: { stMacros: true } },
      { id: 'reader', order: 2, layer: 'pre-step', position: 'after-all', text: 'PRE[{{getvar::n::EMPTY}}]', params: { stMacros: true } },
    ], (ctx, configs) => applyPromptConfigs(ctx, configs))
    const prior = { id: 'prior', role: 'user', source: { kind: 'setter', plugin: 'setter' }, content: [{ type: 'text', text: 'prior setter' }] }
    const events = [{ type: 'turn/start', seq: 1, data: { turn: 1 } }]
    if (promoted) events.push({ type: 'tool/call', seq: 2, data: {} })
    if (delivered) events.push({ type: 'user/message', seq: 3, data: { message: prior } })
    const session = { id: name, header: { delegationDepth: depth }, snapshotEvents: () => events }
    assert.equal(renderPrompt(await h.assemble(scope, session)), 'SYS[EMPTY]')
    const message = { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'ordinary' }] }
    const decision = await h.step(scope, session, inBatch ? [message, prior] : [message])
    assert.equal(decision.messages.at(-1).content[0].text, `PRE[${expected}]`)
    const injected = decision.messages.filter(message => message.source?.plugin === 'setter' && message !== prior)
    assert.equal(injected.length, expected === '1' ? 1 : 0)
    assert.equal(renderPrompt(await h.assemble(scope, session)), 'SYS[EMPTY]')
  })
}

test('V2 官方组装与 pre-step 的跨层帧在重复组装、新 epoch 与重晋升下不重复赋值', async (t) => {
  const h = await harness(t)
  const scope = await h.mount([
    { id: 'system', order: 0, layer: 'system-section', text: 'SYS[{{incvar::s}}]', params: { stMacros: true } },
    { id: 'context', order: 1, layer: 'runtime-context', text: 'CTX[{{getvar::s}}]', params: { stMacros: true } },
    { id: 'setter', order: 2, layer: 'pre-step', position: 'after-all', promotion: 'main', text: 'SET[{{incvar::n}}]', params: { stMacros: true } },
    { id: 'reader', order: 3, layer: 'pre-step', position: 'after-all', text: 'PRE[{{getvar::s}}/{{getvar::n}}]', params: { stMacros: true } },
  ], (ctx, configs) => applyPromptConfigs(ctx, configs))
  const events = [{ type: 'turn/start', seq: 1, data: { turn: 1 } }]
  const session = { id: 'epochs', header: {}, snapshotEvents: () => events }
  const event = (type, data = {}) => {
    const item = { type, data, seq: events.length + 1 }
    events.push(item)
    h.root.emit('session/event', session, item)
  }
  const step = () => h.step(scope, session, [])
  const assembly = async (s) => {
    const value = await h.assemble(scope, session)
    assert.equal(renderPrompt(value), `SYS[${s}]`)
    assert.deepEqual(renderContextSections(value), [{ name: 'context', text: `CTX[${s}]` }])
  }
  await assembly(1)
  assert.equal((await step()).messages.at(-1).content[0].text, 'PRE[1/]')
  event('tool/call')
  event('step/end', { turn: 1, step: 1 })
  await assembly(2)
  assert.equal((await step()).messages.at(-1).content[0].text, 'PRE[2/1]')
  await assembly(2)
  assert.equal((await step()).messages.at(-1).content[0].text, 'PRE[2/1]', '重复执行同一步不重放宏')
  event('compaction/end', { error: 'cancelled' })
  await assembly(2)
  event('compaction/end', {})
  await assembly(3)
  assert.equal((await step()).messages.at(-1).content[0].text, 'PRE[3/1]', '新 epoch 未晋升不执行 setter')
  event('tool/call')
  event('step/end', { turn: 1, step: 2 })
  await assembly(4)
  assert.equal((await step()).messages.at(-1).content[0].text, 'PRE[4/2]', '新 epoch 重晋升只执行一次')
})

test('V2 pre-step 先行只求值本批获准模板，后续官方组装沿用变量帧', async (t) => {
  const h = await harness(t)
  const scope = await h.mount([
    { id: 'system', order: 0, layer: 'system-section', text: 'SYS[{{incvar::s}}/{{getvar::n}}]', params: { stMacros: true } },
    { id: 'setter', order: 1, layer: 'pre-step', position: 'after-all', text: 'SET[{{incvar::n}}]', params: { stMacros: true } },
    { id: 'reader', order: 2, layer: 'pre-step', position: 'after-all', text: 'PRE[{{getvar::s}}/{{getvar::n}}]', params: { stMacros: true } },
  ], (ctx, configs) => applyPromptConfigs(ctx, configs))
  const session = { id: 'pre-first', header: {}, snapshotEvents: () => [{ type: 'turn/start', seq: 1, data: { turn: 1 } }] }
  assert.equal((await h.step(scope, session, [])).messages.at(-1).content[0].text, 'PRE[/1]')
  assert.equal(renderPrompt(await h.assemble(scope, session)), 'SYS[1/1]')
  assert.equal(renderPrompt(await h.assemble(scope, session)), 'SYS[1/1]')
})

test('ST 模板经过真实官方 assembly 求值；两个插入点同一步只执行一次赋值', async (t) => {
  const h = await harness(t)
  const scope = await h.mount([
    { id: 'set', order: 0, layer: 'system-section', text: '{{incvar::n}}', params: { stMacros: true } },
    { id: 'get', order: 1, layer: 'runtime-context', text: '{{getvar::n}}', params: { stMacros: true } },
  ])
  const session = sessionWith()
  let step = 1
  session.snapshotEvents = () => [{ type: step === 1 ? 'turn/start' : 'step/end', seq: step, data: { turn: 1, step: step - 1 } }]
  const first = await h.assemble(scope, session)
  assert.equal(renderPrompt(first), '1')
  assert.deepEqual(renderContextSections(first), [{ name: 'get', text: '1' }])
  assert.equal(renderPrompt(await h.assemble(scope, session)), '1')
  step++
  assert.equal(renderPrompt(await h.assemble(scope, session)), '2')
  const child = sessionWith('CHILD', 'child')
  child.header.delegationDepth = 1
  assert.equal(renderPrompt(await h.assemble(scope, child)), '1')
})
