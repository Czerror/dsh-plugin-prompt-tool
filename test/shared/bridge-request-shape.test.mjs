import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BRIDGE_ENDPOINTS } from '../../src/shared/bridge-contract.ts'
import {
  BRIDGE_REQUEST_FIELDS,
  BRIDGE_REQUEST_HANDLER_CHECKED,
  assertBridgeRequest,
} from '../../src/shared/bridge-request-shape.ts'

const handlerChecked = [
  BRIDGE_ENDPOINTS.assetRelease,
  BRIDGE_ENDPOINTS.exportModule,
  BRIDGE_ENDPOINTS.moduleVariables,
  BRIDGE_ENDPOINTS.moduleName,
  BRIDGE_ENDPOINTS.moduleConfigOrder,
  BRIDGE_ENDPOINTS.rules,
  BRIDGE_ENDPOINTS.persona,
  BRIDGE_ENDPOINTS.personaSources,
  BRIDGE_ENDPOINTS.importModulePackage,
  BRIDGE_ENDPOINTS.charactersImport,
].sort()

test('bridge request shape：45 端点全覆盖，6 个 none，10 个 handler-owned', () => {
  assert.deepEqual(Object.keys(BRIDGE_REQUEST_FIELDS).sort(), Object.keys(BRIDGE_ENDPOINTS).sort())
  const none = Object.entries(BRIDGE_REQUEST_FIELDS).filter(([, fields]) => fields === null).map(([key]) => key).sort()
  assert.deepEqual(none, ['assetUpload', 'charactersImportStream', 'describe', 'meta', 'templates', 'triggers'].sort())
  assert.deepEqual([...BRIDGE_REQUEST_HANDLER_CHECKED].sort(), handlerChecked)
  for (const [key, fields] of Object.entries(BRIDGE_REQUEST_FIELDS)) {
    if (fields === null) continue
    assert.equal(new Set(fields).size, fields.length, key + ' 字段不重复')
  }
})

test('bridge request shape：bridge-owned 拒绝未知字段，handler-owned 交给 handler，none 不读体', () => {
  assert.doesNotThrow(() => assertBridgeRequest('/models', { refresh: true }))
  assert.throws(() => assertBridgeRequest('/models', { refresh: true, extra: 1 }), /未知请求字段：extra/)
  assert.doesNotThrow(() => assertBridgeRequest('/persona', { extra: 1 }), 'handler-owned 保留域内错误')
  assert.throws(() => assertBridgeRequest('/rule-diagnostics', { extra: 1 }), /未知请求字段：extra/, '无字段 JSON 端点也拒绝')
  assert.doesNotThrow(() => assertBridgeRequest('/triggers', { extra: 1 }), 'none 端点不解析体')
})
