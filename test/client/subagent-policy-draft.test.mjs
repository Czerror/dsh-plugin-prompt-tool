import test from 'node:test'
import assert from 'node:assert/strict'
import { asBool, asList, asNum, createEmptyPolicy, splitList } from '../../src/client/features/subagents/subagent-policy-draft.ts'

test('subagent policy draft：首次启用复用现有 allow 并建立稳定默认', () => {
  const policy = createEmptyPolicy('read, glob, read')
  assert.equal(policy.defaultProfile, 'base')
  assert.deepEqual(policy.profiles[0].allow, ['read', 'glob', 'read'])
  assert.equal(policy.modelExpansion.requireApproval, true)
})

test('subagent policy draft：宽松 UI 值归一不抛错', () => {
  assert.deepEqual(asList(['a', 2]), ['a', '2'])
  assert.deepEqual(asList(null), [])
  assert.equal(asBool(true), true)
  assert.equal(asBool(1), false)
  assert.equal(asNum(3), 3)
  assert.equal(asNum(3.5), 0)
  assert.deepEqual(splitList('a, , b'), ['a', 'b'])
})
