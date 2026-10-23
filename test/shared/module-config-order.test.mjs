import { test } from 'node:test'
import assert from 'node:assert/strict'

import { nextConfigSequence } from '../../src/shared/module-config-order.ts'

test('nextConfigSequence：空集合从 0 开始，负数下限 -10', () => {
  assert.equal(nextConfigSequence({}), 0)
  assert.equal(nextConfigSequence({ a: -20 }), 0)
})

test('nextConfigSequence：取 current 与 reserved 的最大值 + 10', () => {
  assert.equal(nextConfigSequence({ a: 10 }), 20)
  assert.equal(nextConfigSequence({ a: 10 }, [100]), 110)
  assert.equal(nextConfigSequence({}, [5, 30]), 40)
})

test('nextConfigSequence：超出安全整数抛错', () => {
  assert.throws(() => nextConfigSequence({ a: Number.MAX_SAFE_INTEGER }), /安全整数/u)
})
