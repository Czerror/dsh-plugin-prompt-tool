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

// ───────────────────────── 四、撤销时机 ─────────────────────────

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
