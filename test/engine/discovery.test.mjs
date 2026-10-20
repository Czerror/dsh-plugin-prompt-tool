/**
 * discovery —— 发现引擎的共享搜索与适配器注册表。
 *
 * 真值源：两个数据源的差异只在「准入规则」与「渲染文案」；注册表按 agent 隔离、
 * 同一 adapter 幂等、不同实现重复注册必须失败（防止静默换实现）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createDiscoveryRegistry,
  assertDiscoveryRows,
  queryTokens,
  scoreRows,
  rankRows,
  renderRows,
  DISCOVERY_ADAPTER_ROWS,
  UNLOCKABLE_DISCOVERY_KINDS,
} from '../../engine/discovery.mjs'

// ───────────────────────── 注册表 ─────────────────────────

test('discovery 注册表：按 agent 隔离，同一 adapter 幂等，不同实现重复注册抛错', () => {
  const registry = createDiscoveryRegistry()
  const agentA = { id: 'a' }
  const agentB = { id: 'b' }
  const tools = { kind: 'tools', tool: 'tool_search', unlock: { tool: 'tool_search', key: 'toolNames' } }
  const dispose = registry.register(agentA, 'tools', tools)
  assert.equal(registry.get(agentA, 'tools'), tools)
  assert.equal(registry.get(agentB, 'tools'), undefined, '未注册的 agent 解析为 undefined')
  assert.doesNotThrow(() => registry.register(agentA, 'tools', tools), '同一 adapter 重复注册是幂等的')
  assert.throws(() => registry.register(agentA, 'tools', { ...tools }), /already registered/)
  dispose()
  assert.equal(registry.get(agentA, 'tools'), undefined)
})

test('discovery 注册表：缺工具名或坏的 unlock 在注册时拒绝', () => {
  const registry = createDiscoveryRegistry()
  const agent = { id: 'a' }
  assert.throws(() => registry.register(agent, 'tools', { kind: 'tools' }), /needs a tool name/)
  assert.throws(() => registry.register(agent, 'tools', { kind: 'tools', tool: 'x', unlock: { tool: 'x' } }), /unlock.key/)
})

// ───────────────────────── 准备期校验 ─────────────────────────

test('discovery 准备期校验：缺 adapter 行或未知 kind 直接失败', () => {
  const rules = [{ actions: [{ kind: 'tool-visibility', discovery: { kind: 'tools' } }] }]
  assert.doesNotThrow(() => assertDiscoveryRows(rules, ['rule-engine', 'tool-search'], 'm'))
  assert.throws(() => assertDiscoveryRows(rules, ['rule-engine'], 'm'), /modules 未包含 "tool-search" 行/)
  assert.throws(() => assertDiscoveryRows([{ actions: [{ discovery: { kind: 'nope' } }] }], ['tool-search'], 'm'), /未知 discovery kind/)
  assert.doesNotThrow(() => assertDiscoveryRows([{ enabled: false, actions: [{ discovery: { kind: 'tools' } }] }], ['rule-engine'], 'm'), '未启用规则不要求行')
  assert.deepEqual(DISCOVERY_ADAPTER_ROWS.tools, 'tool-search')
  assert.equal(UNLOCKABLE_DISCOVERY_KINDS.has('tools'), true)
  assert.equal(UNLOCKABLE_DISCOVERY_KINDS.has('skills'), false)
})

// ───────────────────────── 共享搜索 ─────────────────────────

const items = [
  { name: 'web_search', description: 'Search the web' },
  { name: 'web_fetch', description: 'Fetch a URL' },
  { name: 'read', description: 'Read a file' },
]

test('discovery 共享搜索：分词、any-token 准入、精确名优先', () => {
  assert.deepEqual(queryTokens('Web Search'), ['web', 'search'])
  const tokens = queryTokens('web search')
  const rows = scoreRows(items, tokens, { nameOf: (item) => item.name })
  assert.equal(rows.length, 3)
  assert.deepEqual(rankRows(rows).map((row) => row.name), ['web_search', 'web_fetch'], 'any-token 命中；read 不命中')
  assert.equal(rows.find((row) => row.name === 'web_search').exact, false)
})

test('discovery 共享搜索：all-token 准入由调用方决定', () => {
  const tokens = queryTokens('web fetch')
  const rows = scoreRows(items, tokens, { nameOf: (item) => item.name })
  const admitted = rankRows(rows, (row) => row.exact || row.score === tokens.length)
  assert.deepEqual(admitted.map((row) => row.name), ['web_fetch'], '技能面用完整命中作准入')
})

test('discovery 共享渲染：空结果、截断提示、页脚与告警', () => {
  assert.deepEqual(renderRows([], { query: 'x', limit: 2, noun: 'tools', emptyText: 'NONE' }), ['NONE'])
  const rows = Array.from({ length: 5 }, (_, index) => ({ name: 'tool' + index }))
  const lines = renderRows(rows, {
    query: 'tool', limit: 2, noun: 'tools', lineOf: (row) => '- ' + row.name,
    emptyText: 'NONE', footer: 'FOOT', warnings: ['WARN'],
  })
  assert.deepEqual(lines, ['Matching tools (2 of 5):', '- tool0', '- tool1', '(truncated at 2 — add tokens to narrow the query)', 'WARN', 'FOOT'])
})
