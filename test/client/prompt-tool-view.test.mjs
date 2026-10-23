/**
 * /bootstrap 视图投影：descriptor 只提供设置字段，指令卡只来自会话段。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { fieldsFromView } from '../../src/client/data/prompt-tool-view.ts'

const bootstrap = (value, base = {}) => ({ ok: true, value: { value, base, revision: 1 } })

test('缺省时指令卡为空，设置字段仍从 descriptor 读', () => {
  const res = bootstrap({ modulesEnabled: false })
  const fields = fieldsFromView(res)
  assert.deepEqual(fields.instructionCards, [])
  assert.equal(fields.modulesEnabled, false)
})
