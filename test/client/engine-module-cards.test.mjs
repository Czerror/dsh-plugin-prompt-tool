import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const delegation = readFileSync(new URL('../../src/client/features/subagents/DelegationToolsCard.tsx', import.meta.url), 'utf8')
const modules = readFileSync(new URL('../../src/client/features/modules/EngineModuleList.tsx', import.meta.url), 'utf8')

test('工具与深度卡保留递归深度入口', () => {
  assert.ok(delegation.includes('aria-label="递归深度"'), '子代理工具与深度卡应包含递归深度控件')
  assert.ok(delegation.includes('fields.maxDepth'), '递归深度控件应绑定 fields.maxDepth')
})

test('递归深度入口不重复出现', () => {
  const source = delegation + modules
  assert.equal((source.match(/aria-label="递归深度"/g) ?? []).length, 1, '递归深度控件应只保留一个入口')
})
