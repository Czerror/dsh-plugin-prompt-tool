import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getEngineMeta, KNOWN_STRATEGIES } from '../../engine/schema.mjs'

test('getEngineMeta 返回引擎能力矩阵，anchored 策略为内置策略', () => {
  const meta = getEngineMeta()
  assert.ok(meta.layers.includes('pre-step'))
  assert.ok(meta.layers.includes('tool-pipeline'))
  assert.ok(meta.strategies.includes('custom-fallback'))
  assert.ok(!meta.strategies.includes('anchor-fallback'))
  assert.ok(!meta.strategies.includes('we-fallback'))
  assert.deepEqual(meta.strategies, ['custom-fallback', 'first-turn-anchor', 'guide-auto', 'instruction-hint', 'placeholder', 'static'])
  assert.ok(meta.fills.includes('skill-catalog'))
  assert.ok(meta.layerFieldPolicies['pre-step'].position === true)
  assert.ok(meta.layerFieldPolicies['agent-request'].priority === true)
  assert.ok(meta.layerLabels['pre-step'].title.length > 0)
  assert.deepEqual([...KNOWN_STRATEGIES].sort(), meta.strategies)
})
