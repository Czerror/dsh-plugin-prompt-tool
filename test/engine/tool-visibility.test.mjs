/**
 * tool-visibility：一份声明拥有目录、SDK 正文与执行闸（T1–T3 的行为验收）。
 *
 * 真值源是官方 ToolRestriction 语义（deepseek-harness packages/core/tools/src/index.ts:701-706）：
 * allow 与 deny 可以同时给，判据是「先按 allow 保留、再按 deny 剔除」；guard 只有 deny 语义。
 * 这里用记录型 ctx 与假 agent scope 验证本动作的投影与撤销时机，宿主语义由 tool-narrow.test.mjs 覆盖。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerAction } from '../../engine/actions.mjs'
import { compileRules } from '../../engine/rule-spec.mjs'
import { mountRuleSources } from '../../engine/rule-runtime.mjs'
import { SDK_SECTION_NAME, sdkToolNames } from '../../engine/sdk-strip.mjs'

function recordingCtx() {
  const events = []
  const warnings = []
  const ctx = {
    logger: { warn: (message) => warnings.push(String(message)) },
    on(event, handler) {
      events.push({ event, handler })
      return () => {}
    },
    effect(callback) { const disposer = callback(); return typeof disposer === 'function' ? disposer : () => {} },
    get: () => undefined,
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

test('tool-visibility：未知字段、非法受众、allow 与 requireMatch 的错误组合都在编译期拒绝', () => {
  assert.throws(() => compileRules([{ id: 'r', then: [{ id: 'v', kind: 'tool-visibility', deny: ['a'], unknown: true }] }]),
    /unknown config key\(s\) unknown/)
  assert.throws(() => compileRules([{ id: 'r', then: [{ id: 'v', kind: 'tool-visibility', deny: ['a'], audience: 'nobody' }] }]),
    /audience must be main, subagent or all/)
  assert.throws(() => compileRules([{ id: 'r', then: [{ id: 'v', kind: 'tool-visibility', deny: ['a'], requireMatch: true }] }]),
    /requireMatch only applies to allow/)
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
  assert.deepEqual(disposed.restrict, [{ allow: ['alpha', 'beta'], deny: ['beta'] }])
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
})

// ───────────────────────── 三、发现工具与提示 ─────────────────────────

test('tool-visibility：discovery 注册发现工具，并从持久 tool/call 回收解锁名', async () => {
  const rec = recordingCtx()
  const disposed = {}
  const scope = scopeOf({ disposed, names: ['alpha', 'beta', 'gamma'] })
  const session = {
    id: 's1',
    header: { delegationDepth: 0 },
    snapshotEvents: () => [{ type: 'tool/call', data: { name: 'tool_search', arguments: JSON.stringify({ toolNames: ['gamma'] }) } }],
  }
  const agent = { session, ctx: scope }
  registerAction(rec.ctx, {
    kind: 'tool-visibility',
    id: 'v',
    allow: ['alpha', 'beta'],
    discovery: { tool: 'tool_search', key: 'toolNames' },
  })
  const handler = only(rec, 'system-prompt/assemble')
  const input = assembled(toolList('alpha', 'beta', 'gamma'))
  const out = await handler(input, { agent }, async () => input)
  assert.equal(disposed.registered.length, 1, '发现工具在本 scope 注册一次')
  assert.equal(disposed.registered[0].name, 'tool_search')
  assert.ok(disposed.registered[0].description.includes('alpha'), '描述里的常驻集来自声明')
  assert.deepEqual(out.tools.map((tool) => tool.name), ['alpha', 'beta', 'gamma'], '解锁名只做加法')
  assert.deepEqual(disposed.restrict.at(-1).allow, ['alpha', 'beta', 'gamma'], 'restrict 的 allow 含解锁项')
  await handler(input, { agent }, async () => input)
  assert.equal(disposed.registered.length, 1, '名单未变时不重复注册')
})

test('tool-visibility：notice 交给现有提示配置引擎，正文由声明派生', async () => {
  const rec = recordingCtx()
  const scope = scopeOf({})
  registerAction(rec.ctx, { kind: 'tool-visibility', id: 'v', allow: ['alpha', 'beta'], notice: true })
  const handler = only(rec, 'system-prompt/assemble')
  const input = assembled(toolList('alpha', 'beta'))
  await handler(input, { agent: agentOf(scope) }, async () => input)
  assert.ok(rec.events.some((entry) => entry.event === 'agent/pre-step'), '提示经既有 pre-step 引擎注册')
  assert.ok(rec.warnings.length === 0, '正常路径不得告警')
})

test('tool-visibility：提示正文列出常驻集与发现入口', async () => {
  const { toolVisibilityNoticeText } = await import('../../engine/actions/tool-visibility.mjs')
  const text = toolVisibilityNoticeText({ resident: ['alpha', 'beta'], discovery: { tool: 'tool_search', key: 'toolNames' } })
  assert.match(text, /resident core set \(alpha, beta\)/)
  assert.match(text, /tool_search/)
  assert.equal(toolVisibilityNoticeText({ resident: [], text: '自定义' }), '自定义', '显式正文优先')
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
    run(name, args, terminal) {
      const list = (events.get(name) ?? []).slice()
      const invoke = index => index === list.length ? terminal() : list[index](...args, () => invoke(index + 1))
      return invoke(0)
    },
  }
}

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
    { id: 'main-only', kind: 'tool-visibility', audience: 'main', deny: ['alpha'] },
    { id: 'sub-only', kind: 'tool-visibility', audience: 'subagent', deny: ['beta'] },
    { id: 'everyone', kind: 'tool-visibility', audience: 'all', deny: ['gamma'] },
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
  const rules = compileRules([{ id: 'notice', then: [{ id: 'v', kind: 'tool-visibility', allow: ['alpha'], notice: true }] }])
  const dispose = mountRuleSources(h.ctx, [{ moduleId: 'module', rules }])
  const input = assembled(toolList('alpha'))
  await h.run('system-prompt/assemble', [input, { agent }], () => input)
  const messages = [{ id: 'u', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] }]
  const step = () => h.run('agent/pre-step', [{ agent, messages }], () => ({ kind: 'enter', messages }))
  const first = await step()
  assert.equal(first.messages.length, 2, '首轮注入一条提示')
  assert.match(first.messages[1].content[0].text, /resident core set \(alpha\)/)
  // 真实会话里注入的消息会进入后续上下文：dedupe: session 据此不再投递同一条。
  const carried = first.messages
  // 宿主把接纳的注入写成 durable user/message 事件；dedupe: session 的真相是当前上下文。
  sessionEvents.push({ type: 'user/message', seq: 0, data: { message: first.messages[1] } })
  const second = await h.run('agent/pre-step', [{ agent, messages: carried }], () => ({ kind: 'enter', messages: carried }))
  assert.equal(second.messages.length, 2, '同一条提示不得重复注入')
  assert.equal(second.messages.filter((message) => String(message?.content?.[0]?.text ?? '').includes('resident core set')).length, 1)
  dispose()
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
