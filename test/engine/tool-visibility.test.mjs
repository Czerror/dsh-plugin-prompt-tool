/**
 * tool-visibility：一份声明拥有目录、SDK 正文与执行闸（T1–T3 的行为验收）。
 *
 * 真值源是官方 ToolRestriction 语义（deepseek-harness packages/core/tools/src/index.ts:701-706）：
 * allow 与 deny 可以同时给，判据是「先按 allow 保留、再按 deny 剔除」；allow 的执行面由 guard 兜底。
 * 这里用记录型 ctx 与假 agent scope 验证本动作的投影与撤销时机，宿主语义由 tool-narrow.test.mjs 覆盖。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerAction } from '../../engine/actions.mjs'
import { compileRules } from '../../engine/rule-spec.mjs'
import { mountRuleSources } from '../../engine/rule-runtime.mjs'
import { createDiscoveryRegistry } from '../../engine/discovery.mjs'
import { DISCOVERY_SERVICE } from '../../engine/service-names.mjs'
import { SDK_SECTION_NAME, sdkToolNames } from '../../engine/sdk-strip.mjs'

function recordingCtx(services = {}) {
  const events = []
  const warnings = []
  const ctx = {
    logger: { warn: (message) => warnings.push(String(message)) },
    on(event, handler) {
      events.push({ event, handler })
      return () => {}
    },
    effect(callback) { const disposer = callback(); return typeof disposer === 'function' ? disposer : () => {} },
    get: (name) => services[name],
  }
  return { ctx, events, warnings }
}

const only = (record, name) => {
  const found = record.events.filter((entry) => entry.event === name)
  assert.equal(found.length, 1, `应恰好注册一个 ${name} 监听器，实际 ${found.length}`)
  return found[0].handler
}
const assembled = (tools = [], sections = []) => ({ sections, contexts: [], tools, variables: {} })
const toolList = (...names) => names.map((name) => ({ name }))

function scopeOf({ disposed = {}, names = ['alpha', 'beta'] } = {}) {
  return {
    tools: {
      schemas: () => toolList(...names),
      register: (definition) => {
        ;(disposed.registered ??= []).push(definition)
        return () => { disposed.registerDisposed = (disposed.registerDisposed ?? 0) + 1 }
      },
      restrict: (options) => {
        ;(disposed.restrict ??= []).push(options)
        return () => { disposed.restrictDisposed = (disposed.restrictDisposed ?? 0) + 1 }
      },
      guard: (fn) => {
        ;(disposed.guards ??= []).push(fn)
        return () => { disposed.guardDisposed = (disposed.guardDisposed ?? 0) + 1 }
      },
    },
  }
}
const agentOf = (scope, depth = 0, id = 's1') => ({ session: { id, header: { delegationDepth: depth } }, ctx: scope })

// ───────────────────────── 一、声明校验 ─────────────────────────

test('tool-visibility：合法声明编译到 assemble/after-next，事件类生命周期', () => {
  const rule = compileRules([{ id: 'r', then: [{ id: 'v', kind: 'tool-visibility', deny: ['web_search'] }] }])[0]
  assert.equal(rule.actions[0].execution.channel, 'system-prompt/assemble')
  assert.equal(rule.actions[0].execution.phase, 'after-next')
  assert.equal(rule.actions[0].execution.lifecycle, 'event')
})

test('tool-visibility：未知字段、allow 与 requireMatch 的错误组合都在编译期拒绝', () => {
  assert.throws(() => compileRules([{ id: 'r', then: [{ id: 'v', kind: 'tool-visibility', deny: ['a'], unknown: true }] }]),
    /unknown config key\(s\) unknown/)
  assert.throws(() => compileRules([{ id: 'r', then: [{ id: 'v', kind: 'tool-visibility', deny: ['a'], requireMatch: true }] }]),
    /requireMatch only applies to allow/)
  assert.throws(() => compileRules([{ id: 'r', then: [{ id: 'v', kind: 'tool-visibility', allow: ['a'], discovery: {} }] }]),
    /discovery.kind is required/)
  assert.throws(() => compileRules([{ id: 'r', then: [{ id: 'v', kind: 'tool-visibility', allow: ['a'], discovery: { kind: 'skills' } }] }]),
    /has no unlock semantics/)
  assert.throws(() => compileRules([{ id: 'r', then: [{ id: 'v', kind: 'tool-visibility', allow: ['a'], discovery: { kind: 'tools', tool: '' } }] }]),
    /discovery.tool must be a non-empty string/)
})

// ───────────────────────── 二、目录与 SDK 正文 ─────────────────────────

test('tool-visibility：deny 同时裁剪目录与 SDK 正文，并注册执行闸', async () => {
  const rec = recordingCtx()
  const disposed = {}
  const scope = scopeOf({ disposed })
  registerAction(rec.ctx, { kind: 'tool-visibility', id: 'v', deny: ['beta'] })
  const handler = only(rec, 'system-prompt/assemble')
  const sdk = [
    'interface ToolArgsMap {',
    '  alpha: { x: string };',
    '  beta: { x: string };',
    '}',
    'interface ToolOutputMap {',
    '  alpha: { text: string };',
    '  beta: { text: string };',
    '}',
  ].join('\n')
  const out = await handler(assembled(toolList('alpha', 'beta'), [{ name: SDK_SECTION_NAME, text: sdk }]), { agent: agentOf(scope) }, async () => assembled(toolList('alpha', 'beta'), [{ name: SDK_SECTION_NAME, text: sdk }]))
  assert.deepEqual(out.tools.map((tool) => tool.name), ['alpha'], '目录只剩未被下架的工具')
  assert.deepEqual(sdkToolNames(out.sections[0].text).sort(), ['alpha'], 'SDK 正文同步删掉被下架工具')
  assert.deepEqual(disposed.restrict, [{ deny: ['beta'] }], 'restrict 只喂已知全局名')
  assert.equal(disposed.guards.length, 1, '登记一条执行闸')
  assert.equal(disposed.guards[0]({ name: 'beta' }), 'v: tool "beta" is denied by tool-visibility')
  assert.equal(disposed.guards[0]({ name: 'alpha' }), undefined)
})

test('tool-visibility：allow 与 deny 同时给时先保留再剔除（对齐官方 and/or）', async () => {
  const rec = recordingCtx()
  const disposed = {}
  const scope = scopeOf({ disposed })
  registerAction(rec.ctx, { kind: 'tool-visibility', id: 'v', allow: ['alpha', 'beta'], deny: ['beta'] })
  const handler = only(rec, 'system-prompt/assemble')
  const input = assembled(toolList('alpha', 'beta'))
  const out = await handler(input, { agent: agentOf(scope) }, async () => input)
  assert.deepEqual(out.tools.map((tool) => tool.name), ['alpha'])
  assert.deepEqual(disposed.restrict, [{ deny: ['beta'] }], 'allow 不交给 restrict，避免漏掉预设/祖先层工具')
  assert.equal(disposed.guards[0]({ name: 'beta' }), 'v: tool "beta" is denied by tool-visibility')
  assert.equal(disposed.guards[1]({ name: 'gamma' }), 'v: tool "gamma" is not allowed by tool-visibility')
})

test('tool-visibility：allow 的 requireMatch 缺工具时 fail-open 并告警', async () => {
  const rec = recordingCtx()
  const disposed = {}
  const scope = scopeOf({ disposed })
  registerAction(rec.ctx, { kind: 'tool-visibility', id: 'v', allow: ['alpha', 'ghost'], requireMatch: true })
  const handler = only(rec, 'system-prompt/assemble')
  const input = assembled(toolList('alpha', 'beta'))
  const out = await handler(input, { agent: agentOf(scope) }, async () => input)
  assert.deepEqual(out.tools.map((tool) => tool.name), ['alpha', 'beta'], '缺名单工具时暴露完整目录')
  assert.ok(rec.warnings.some((message) => /requireMatch tool is absent/.test(message)))
  assert.equal(disposed.guards[0]({ name: 'beta' }), undefined, 'fail-open 时 allow guard 同步放行')
})

test('tool-visibility：run_code 是保留传输，allow 不点名也保留且不计入 requireMatch', async () => {
  for (const allow of [['alpha'], ['alpha', 'run_code']]) {
    const rec = recordingCtx()
    const disposed = {}
    const scope = scopeOf({ disposed, names: ['alpha', 'beta', 'run_code'] })
    registerAction(rec.ctx, { kind: 'tool-visibility', id: 'v', allow, requireMatch: true })
    const handler = only(rec, 'system-prompt/assemble')
    const input = assembled(toolList('alpha', 'beta', 'run_code'))
    const out = await handler(input, { agent: agentOf(scope) }, async () => input)
    assert.deepEqual(out.tools.map((tool) => tool.name), ['alpha', 'run_code'], `allow ${allow.join(',')} 仍保留传输`)
    assert.equal(disposed.restrict, undefined, 'allow 模式不调用 restrict')
    assert.equal(disposed.guards[0]({ name: 'beta' }), 'v: tool "beta" is not allowed by tool-visibility')
    assert.deepEqual(rec.warnings, [], 'run_code 不参与 requireMatch 的缺失判定')
  }
})

// ───────────────────────── 三、发现工具与提示 ─────────────────────────

test('tool-visibility：discovery 从持久调用记录回收解锁名（含 PTC 嵌套 dispatch）', async () => {
  const registry = createDiscoveryRegistry()
  const rec = recordingCtx({ [DISCOVERY_SERVICE]: registry })
  const disposed = {}
  const scope = scopeOf({ disposed, names: ['alpha', 'beta', 'gamma', 'delta'] })
  const session = {
    id: 's1',
    header: { delegationDepth: 0 },
    snapshotEvents: () => [
      { type: 'tool/call', data: { name: 'tool_search', arguments: JSON.stringify({ toolNames: ['gamma'] }) } },
      { type: 'tool/ptc-dispatch', data: { name: 'tool_search', arguments: { toolNames: ['delta'] } } },
    ],
  }
  const agent = { session, ctx: scope }
  registry.register(agent, 'tools', { kind: 'tools', tool: 'tool_search', unlock: { tool: 'tool_search', key: 'toolNames' } })
  registerAction(rec.ctx, {
    kind: 'tool-visibility',
    id: 'v',
    allow: ['alpha', 'beta'],
    discovery: { kind: 'tools' },
  })
  const handler = only(rec, 'system-prompt/assemble')
  const input = assembled(toolList('alpha', 'beta', 'gamma', 'delta'))
  const out = await handler(input, { agent }, async () => input)
  assert.deepEqual(out.tools.map((tool) => tool.name), ['alpha', 'beta', 'gamma', 'delta'], '两种调用记录都只做加法')
  assert.equal(disposed.restrict, undefined, 'allow 模式不调用 restrict')
  assert.equal(disposed.guards[0]({ name: 'gamma' }), undefined, '顶层 tool/call 解锁项通过 allow guard')
  assert.equal(disposed.guards[0]({ name: 'delta' }), undefined, 'PTC 嵌套 dispatch 解锁项通过 allow guard')
  assert.match(disposed.guards[0]({ name: 'epsilon' }), /not allowed by tool-visibility/)
  assert.deepEqual(rec.warnings, [], '元数据匹配时不得告警')
})

test('tool-visibility：adapter 未注册时告警一次并跳过解锁回收', async () => {
  const registry = createDiscoveryRegistry()
  const rec = recordingCtx({ [DISCOVERY_SERVICE]: registry })
  const disposed = {}
  const scope = scopeOf({ disposed, names: ['alpha', 'beta', 'gamma'] })
  const session = {
    id: 's-missing',
    header: { delegationDepth: 0 },
    snapshotEvents: () => [{ type: 'tool/call', data: { name: 'tool_search', arguments: JSON.stringify({ toolNames: ['gamma'] }) } }],
  }
  registerAction(rec.ctx, { kind: 'tool-visibility', id: 'v', allow: ['alpha', 'beta'], discovery: { kind: 'tools' } })
  const handler = only(rec, 'system-prompt/assemble')
  const input = assembled(toolList('alpha', 'beta', 'gamma'))
  const out = await handler(input, { agent: { session, ctx: scope } }, async () => input)
  assert.deepEqual(out.tools.map((tool) => tool.name), ['alpha', 'beta'], '没有 adapter 就没有解锁项')
  assert.ok(rec.warnings.some((message) => /discovery adapter "tools" is not registered/.test(message)))
})

// ───────────────────────── 四、真实规则挂载 ─────────────────────────

/** 轻量 ctx：只记录 ctx.on / effect，够 mountRuleSources 跑瀑布与 pre-step。 */
function ruleHarness() {
  const events = new Map()
  const warnings = []
  const ctx = {
    logger: { warn: (message) => warnings.push(String(message)), info() {} },
    on(name, handler, options) {
      const list = events.get(name) ?? []
      events.set(name, list)
      if (options?.prepend) list.unshift(handler)
      else list.push(handler)
      return () => { const at = list.indexOf(handler); if (at >= 0) list.splice(at, 1) }
    },
    effect(callback) { const dispose = callback(); return typeof dispose === 'function' ? dispose : () => {} },
    get: () => undefined,
  }
  return {
    ctx,
    warnings,
    emit(name, ...args) {
      for (const handler of (events.get(name) ?? []).slice()) handler(...args)
    },
    run(name, args, terminal) {
      const list = (events.get(name) ?? []).slice()
      const invoke = index => index === list.length ? terminal() : list[index](...args, () => invoke(index + 1))
      return invoke(0)
    },
  }
}

test('普通文本条件：批内全部真实用户文本的长度与关键词共同选择注入分支', async () => {
  const h = ruleHarness()
  const agent = { session: { id: 'batch-length', header: { delegationDepth: 0 }, snapshotEvents: () => [] } }
  const rules = compileRules([{
    id: 'length',
    if: { text: { subject: 'userMessage', keys: ['甲'], minChars: 5, maxChars: 5 } },
    then: [{ id: 'long', kind: 'inject-text', config: { layer: 'pre-step', strategy: 'static', position: 'after-all', text: 'LONG' } }],
    else: [{ id: 'short', kind: 'inject-text', config: { layer: 'pre-step', strategy: 'static', position: 'after-all', text: 'SHORT' } }],
  }])
  const dispose = mountRuleSources(h.ctx, [{ moduleId: 'module', rules }])
  const message = text => ({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })
  const run = messages => h.run('agent/pre-step', [{ agent, messages }], () => ({ kind: 'enter', messages }))
  assert.equal((await run([message('甲乙'), message('丙丁')])).messages.at(-1).content[0].text, 'LONG')
  assert.equal((await run([message('甲乙')])).messages.at(-1).content[0].text, 'SHORT')
  assert.equal((await run([message('天地'), message('玄黄')])).messages.at(-1).content[0].text, 'SHORT')
  dispose()
})

test('真实规则挂载：条件由真变假时撤销上一轮注册的执行闸', async () => {
  const h = ruleHarness()
  const disposed = {}
  const sessionEvents = []
  const session = { id: 's-flip', header: { delegationDepth: 0 }, snapshotEvents: () => sessionEvents }
  const agent = { session, ctx: scopeOf({ disposed }) }
  const rules = compileRules([{
    id: 'flip',
    if: { session: { type: 'user/message', present: false } },
    then: [{ id: 'v', kind: 'tool-visibility', deny: ['beta'] }],
  }])
  const dispose = mountRuleSources(h.ctx, [{ moduleId: 'module', rules }])
  const input = assembled(toolList('alpha', 'beta'))
  const assemble = () => h.run('system-prompt/assemble', [input, { agent }], () => input)
  const first = await assemble()
  assert.deepEqual(first.tools.map((tool) => tool.name), ['alpha'], '条件为真：目录被裁、执行闸注册')
  assert.equal(disposed.guardDisposed ?? 0, 0)
  // 模型可见上下文里出现一条 user/message：条件转假，规则条目被跳过 → 未命中回调撤闸。
  sessionEvents.push({ type: 'user/message', seq: 0, data: {} })
  const second = await assemble()
  assert.deepEqual(second.tools.map((tool) => tool.name), ['alpha', 'beta'], '条件为假：不再裁剪')
  assert.equal(disposed.guardDisposed, 1, '条件变假必须撤销 guard')
  assert.equal(disposed.restrictDisposed, 1, '条件变假必须撤销 restrict')
  dispose()
})

test('真实规则挂载：受众三态各自只在自己的装配里生效', async () => {
  const h = ruleHarness()
  const mainDisposed = {}
  const childDisposed = {}
  const main = { session: { id: 's-main', header: { delegationDepth: 0 }, snapshotEvents: () => [] }, ctx: scopeOf({ disposed: mainDisposed }) }
  const child = { session: { id: 's-child', header: { delegationDepth: 1 }, snapshotEvents: () => [] }, ctx: scopeOf({ disposed: childDisposed }) }
  const rules = compileRules([{ id: 'aud', then: [
    { if: { scope: { audience: 'main' } }, then: [{ id: 'main-only', kind: 'tool-visibility', deny: ['alpha'] }] },
    { if: { scope: { audience: 'subagent' } }, then: [{ id: 'sub-only', kind: 'tool-visibility', deny: ['beta'] }] },
    { id: 'everyone', kind: 'tool-visibility', deny: ['gamma'] },
  ] }])
  const dispose = mountRuleSources(h.ctx, [{ moduleId: 'module', rules }])
  const input = assembled(toolList('alpha', 'beta', 'gamma'))
  const assemble = (agent) => h.run('system-prompt/assemble', [input, { agent }], () => input)
  const mainOut = await assemble(main)
  assert.deepEqual(mainOut.tools.map((tool) => tool.name), ['beta'], '主会话收到 main + all 两份声明')
  const childOut = await assemble(child)
  assert.deepEqual(childOut.tools.map((tool) => tool.name), ['alpha'], '子代理收到 subagent + all 两份声明')
  assert.equal(mainDisposed.guardDisposed ?? 0, 0)
  assert.equal(childDisposed.guardDisposed ?? 0, 0)
  dispose()
  assert.equal(mainDisposed.guardDisposed, 2, '父 mount 释放撤销主会话的两条闸')
  assert.equal(childDisposed.guardDisposed, 2, '父 mount 释放撤销子代理的两条闸')
})

test('真实规则挂载：首轮提示只注入一次', async () => {
  const h = ruleHarness()
  const sessionEvents = []
  const session = { id: 's-notice', header: { delegationDepth: 0 }, snapshotEvents: () => sessionEvents }
  const agent = { session, ctx: scopeOf({}) }
  const rules = compileRules([{ id: 'notice', then: [
    { id: 'v', kind: 'tool-visibility', allow: ['alpha'] },
    { if: { count: { of: 'user-message', max: 1 } }, then: [{ id: 'hint', kind: 'inject-text', config: {
      layer: 'pre-step', strategy: 'static', position: 'after-user', dedupe: 'session',
      text: 'Use tool_search to search for a capability and unlock it by exact name.',
    } }] },
  ] }])
  const dispose = mountRuleSources(h.ctx, [{ moduleId: 'module', rules }])
  const input = assembled(toolList('alpha'))
  await h.run('system-prompt/assemble', [input, { agent }], () => input)
  const messages = [{ id: 'u', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] }]
  const step = () => h.run('agent/pre-step', [{ agent, messages }], () => ({ kind: 'enter', messages }))
  const first = await step()
  assert.equal(first.messages.length, 2, '首轮注入一条提示')
  assert.match(first.messages[1].content[0].text, /Use tool_search/)
  // 真实会话里注入的消息会进入后续上下文：dedupe: session 据此不再投递同一条。
  const carried = first.messages
  // 宿主把接纳的注入写成 durable user/message 事件；dedupe: session 的真相是当前上下文。
  sessionEvents.push({ type: 'user/message', seq: 0, data: { message: first.messages[1] } })
  const second = await h.run('agent/pre-step', [{ agent, messages: carried }], () => ({ kind: 'enter', messages: carried }))
  assert.equal(second.messages.length, 2, '同一条提示不得重复注入')
  assert.equal(second.messages.filter((message) => String(message?.content?.[0]?.text ?? '').includes('Use tool_search')).length, 1)
  dispose()
})

test('工具目录正文：普通注入引用同规则名单，修改声明或复制规则后自动跟随', async () => {
  const make = (id, allow) => ({ id, then: [
    { id: 'tools', kind: 'tool-visibility', allow, deny: ['beta'], discovery: { kind: 'tools' } },
    { id: 'hint', kind: 'inject-text', config: { layer: 'pre-step', strategy: 'placeholder', fill: 'tool-catalog',
      position: 'after-all', text: 'Resident: {{RESIDENT_TOOLS}}. Search: {{DISCOVERY_TOOL}}.', params: { action: 'tools' } } },
  ] })
  const registry = createDiscoveryRegistry()
  const agent = { session: { id: 'catalog', header: {}, snapshotEvents: () => [] }, ctx: scopeOf({}) }
  registry.register(agent, 'tools', { tool: 'find_tools', unlock: { tool: 'find_tools', key: 'toolNames' } })
  const h = ruleHarness()
  h.ctx.get = key => key === DISCOVERY_SERVICE ? registry : undefined
  const messages = [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'task' }] }]
  for (const [id, allow, expected] of [
    ['original', ['alpha', 'beta'], 'Resident: alpha. Search: find_tools.'],
    ['copied-rule', ['alpha', 'gamma'], 'Resident: alpha, gamma. Search: find_tools.'],
  ]) {
    const dispose = mountRuleSources(h.ctx, [{ moduleId: id, rules: compileRules([make(id, allow)]) }])
    const result = await h.run('agent/pre-step', [{ agent, messages }], () => ({ kind: 'enter', messages }))
    assert.equal(result.messages.at(-1).content[0].text, expected)
    dispose()
  }
  const contexts = []
  const runtime = make('runtime', ['alpha', 'beta'])
  runtime.then[1].config.layer = 'runtime-context'
  delete runtime.then[1].config.position
  h.ctx.get = key => key === DISCOVERY_SERVICE ? registry : key === 'systemPrompt' ? {
    variable() { return () => {} }, context(entry) { contexts.push(entry); return () => {} },
  } : undefined
  const release = mountRuleSources(h.ctx, [{ moduleId: 'runtime', rules: compileRules([runtime]) }])
  const assembly = { ...assembled(toolList('alpha')), contexts: contexts.map(entry => ({ ...entry })) }
  const rendered = await h.run('system-prompt/assemble', [assembly, { agent }], () => assembly)
  assert.equal(rendered.contexts[0].text, 'Resident: alpha. Search: find_tools.', '运行上下文出口读取相同目录事实')
  release()
  h.ctx.get = () => undefined
  const absent = mountRuleSources(h.ctx, [{ moduleId: 'unavailable', rules: compileRules([make('unavailable', ['alpha'])]) }])
  const skipped = await h.run('agent/pre-step', [{ agent, messages }], () => ({ kind: 'enter', messages }))
  assert.equal(skipped.messages.length, 1, '发现适配器不可用时跳过提示，不注入伪造工具名')
  absent()
  const missing = make('bad', ['alpha'])
  missing.then[1].config.params.action = 'absent'
  assert.throws(() => compileRules([missing]), /tool-catalog|action|reference/)
  const writing = make('readonly', ['alpha'])
  writing.then[1].config.params.templateEvaluation = true
  assert.throws(() => compileRules([writing]), /tool-catalog.*templateEvaluation/, '只读目录填充不得静默丢失为持久变量求值')
})

test('tool-visibility：条件由真变假时撤销上一轮的执行闸（未命中回调）', async () => {
  const rec = recordingCtx()
  const disposed = {}
  const scope = scopeOf({ disposed })
  let enabled = true
  registerAction(rec.ctx, { kind: 'tool-visibility', id: 'v', deny: ['beta'] }, { when: () => enabled })
  const handler = only(rec, 'system-prompt/assemble')
  const agent = agentOf(scope)
  const input = assembled(toolList('alpha', 'beta'))
  await handler(input, { agent }, async () => input)
  assert.equal(disposed.guardDisposed ?? 0, 0, '条件为真时不撤闸')
  enabled = false
  await handler(input, { agent }, async () => input)
  assert.equal(disposed.guardDisposed, 1, '条件变假必须撤销 guard')
  assert.equal(disposed.restrictDisposed, 1, '条件变假必须撤销 restrict')
})

test('真实规则挂载：工具面与自定义提示共用受众条件且提示仅首轮执行', async () => {
  const h = ruleHarness()
  const events = []
  const session = { id: 's-custom-notice', header: { delegationDepth: 0 }, snapshotEvents: () => events }
  const agent = { session, ctx: scopeOf({}) }
  const rules = compileRules([{ id: 'notice', if: { scope: { audience: 'main' } }, then: [
    { id: 'v', kind: 'tool-visibility', allow: ['alpha'] },
    { if: { count: { of: 'user-message', max: 1 } }, then: [{ id: 'hint', kind: 'inject-text', config: {
      layer: 'pre-step', strategy: 'static', position: 'after-user', text: 'CUSTOM-NOTICE',
    } }] },
  ] }])
  const dispose = mountRuleSources(h.ctx, [{ moduleId: 'module', rules }])
  const input = assembled(toolList('alpha'))
  await h.run('system-prompt/assemble', [input, { agent }], () => input)
  const messages = [{ id: 'u', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] }]
  const first = await h.run('agent/pre-step', [{ agent, messages }], () => ({ kind: 'enter', messages }))
  assert.equal(first.messages.length, 2, '自定义提示照常投递')
  assert.equal(first.messages[1].content[0].text, 'CUSTOM-NOTICE', '正文以声明为准，不是引擎措辞')
  for (const seq of [0, 1]) {
    const event = { type: 'user/message', seq, data: { message: messages[0] } }
    events.push(event)
    h.emit('session/event', session, event)
  }
  const later = await h.run('agent/pre-step', [{ agent, messages }], () => ({ kind: 'enter', messages }))
  assert.equal(later.messages.length, 1, '超过显式计数上限后不再注入提示')
  const child = { session: { ...session, id: 'child', header: { delegationDepth: 1 } }, ctx: scopeOf({}) }
  const childOut = await h.run('agent/pre-step', [{ agent: child, messages }], () => ({ kind: 'enter', messages }))
  assert.equal(childOut.messages.length, 1, '同一受众条件阻止子代理提示')
  const childAssembly = await h.run('system-prompt/assemble', [assembled(toolList('alpha', 'beta')), { agent: child }], () => assembled(toolList('alpha', 'beta')))
  assert.deepEqual(childAssembly.tools.map(tool => tool.name), ['alpha', 'beta'], '同一受众条件阻止子代理工具裁剪')
  dispose()
})
