import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BRIDGE_ENDPOINTS } from '../../src/shared/bridge-contract.ts'
import { BRIDGE_REQUEST_FIELDS, assertBridgeRequest } from '../../src/shared/bridge-request-shape.ts'

const entries = Object.entries(BRIDGE_REQUEST_FIELDS)
const keysOf = (pick) => entries.filter(([, rule]) => pick(rule)).map(([key]) => key).sort()

/** 独立真值源：handler 已自带域内拒绝的端点键名；与表里的 handler 标记对拍。 */
const handlerChecked = [
  'assetRelease', 'exportModule', 'importModulePackage',
  'moduleConfigOrder', 'moduleName', 'moduleVariables', 'persona', 'personaSources', 'rules',
].sort()

test('bridge request shape：端点全覆盖，none / fields / handler 三态由表唯一登记', () => {
  assert.deepEqual(Object.keys(BRIDGE_REQUEST_FIELDS).sort(), Object.keys(BRIDGE_ENDPOINTS).sort())
  const none = keysOf((rule) => rule.body === 'none')
  const handler = keysOf((rule) => rule.handler === true)
  assert.deepEqual(none, ['assetUpload', 'describe', 'meta', 'templates', 'triggers'].sort())
  assert.deepEqual(handler, handlerChecked, 'handler-owned 名单与独立真值源一致')
  for (const [key, rule] of entries) {
    if (!Array.isArray(rule.fields)) continue
    assert.equal(new Set(rule.fields).size, rule.fields.length, key + ' 字段不重复')
  }
})

test('bridge request shape：bridge-owned 拒绝未知字段，handler-owned 交给 handler，none 不读体', () => {
  assert.doesNotThrow(() => assertBridgeRequest('/models', { refresh: true }))
  assert.throws(() => assertBridgeRequest('/models', { refresh: true, extra: 1 }), /未知请求字段：extra/)
  assert.doesNotThrow(() => assertBridgeRequest('/persona', { extra: 1 }), 'handler-owned 保留域内错误')
  assert.throws(() => assertBridgeRequest('/rule-diagnostics', { extra: 1 }), /未知请求字段：extra/, '无字段 JSON 端点也拒绝')
  assert.doesNotThrow(() => assertBridgeRequest('/triggers', { extra: 1 }), 'none 端点不解析体')
})
