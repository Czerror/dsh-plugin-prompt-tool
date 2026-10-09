// 状态栏的全仓计数：真值源是手算样例（X = enabled 为 true 的条数，Y = 全部条数）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { countEnabledConfigs } from '../../src/shared/module-config-order.ts'

const entry = (moduleId, configId, enabled) => ({ moduleId, configId, name: configId, layer: 'pre-step', position: 'after-user', sequence: 10, enabled })

test('countEnabledConfigs：跨模块只数启用条与总条，不改动入参', () => {
  const entries = [
    entry('ponytail', 'a', true),
    entry('ponytail', 'b', true),
    entry('ponytail', 'c', false),
    entry('skill-surface', 'd', true),
    entry('tool-surface', 'e', false),
  ]
  const before = structuredClone(entries)
  assert.deepEqual(countEnabledConfigs(entries), { enabled: 3, total: 5 })
  assert.deepEqual(entries, before, '计数是只读投影，不排序也不改条目')
})

test('countEnabledConfigs：空清单与全停用都报 0 启用，不假设至少有一条', () => {
  assert.deepEqual(countEnabledConfigs([]), { enabled: 0, total: 0 })
  assert.deepEqual(countEnabledConfigs([entry('m', 'a', false), entry('m', 'b', false)]), { enabled: 0, total: 2 })
  assert.deepEqual(countEnabledConfigs([entry('m', 'a', true)]), { enabled: 1, total: 1 })
})
