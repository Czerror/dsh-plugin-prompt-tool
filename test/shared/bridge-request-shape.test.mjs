import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BRIDGE_ENDPOINTS } from '../../src/shared/bridge-contract.ts'
import { BRIDGE_REQUEST_FIELDS, assertBridgeRequest } from '../../src/shared/bridge-request-shape.ts'

const entries = Object.entries(BRIDGE_REQUEST_FIELDS)
const keysOf = (pick) => entries.filter(([, rule]) => pick(rule)).map(([key]) => key).sort()

test('bridge request shape：端点全覆盖，none / fields 两态由表唯一登记', () => {
  assert.deepEqual(Object.keys(BRIDGE_REQUEST_FIELDS).sort(), Object.keys(BRIDGE_ENDPOINTS).sort())
  const none = keysOf((rule) => rule.body === 'none')
  assert.deepEqual(none, ['assetUpload', 'describe', 'meta', 'templates', 'triggers'].sort())
  for (const [key, rule] of entries) {
    if (!Array.isArray(rule.fields)) continue
    assert.equal(new Set(rule.fields).size, rule.fields.length, key + ' 字段不重复')
  }
})

test('bridge request shape：所有 fields 态统一拒绝未知顶层字段，none 不读体', () => {
  assert.doesNotThrow(() => assertBridgeRequest('/models', { refresh: true }))
  // 独立真值源：这 9 个端点曾经由 handler 自己拒绝，本轮统一到表。
  const formerlyHandlerOwned = [
    'assetRelease', 'exportModule', 'importModulePackage', 'moduleConfigOrder', 'moduleName',
    'moduleVariables', 'persona', 'personaSources', 'rules',
  ]
  for (const key of formerlyHandlerOwned) {
    assert.throws(() => assertBridgeRequest(BRIDGE_ENDPOINTS[key], { extra: 1 }), /未知请求字段：extra/, key)
  }
  assert.throws(() => assertBridgeRequest('/models', { refresh: true, extra: 1 }), /未知请求字段：extra/, 'bridge-owned')
  for (const key of ['assetUpload', 'describe', 'meta', 'templates', 'triggers']) {
    assert.doesNotThrow(() => assertBridgeRequest(BRIDGE_ENDPOINTS[key], { extra: 1 }), key + ' 不解析体')
  }
})
