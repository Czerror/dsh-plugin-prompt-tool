import test from 'node:test'
import assert from 'node:assert/strict'
import { importPublicationRequest } from '../../src/client/data/asset-import.ts'

test('导入发布重试请求只带目标身份与 refreshOnly', () => {
  assert.deepEqual(importPublicationRequest('mod-a'), { targetId: 'mod-a', refreshOnly: true })
})
