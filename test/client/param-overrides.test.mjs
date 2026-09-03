import test from 'node:test'
import assert from 'node:assert/strict'
import { EMPTY_FIELDS } from '../../src/client/data/prompt-tool-fields.ts'
import { buildParamOverrides, readParamOverridesPatch } from '../../src/client/data/param-overrides.ts'

test('param overrides：列表与 stages 读回为 UI 草稿', () => {
  assert.deepEqual(readParamOverridesPatch({
    toolFilterAllow: ['read', 'glob'],
    maxDepth: 3,
    stages: [{ name: '了解', tools: ['read'] }],
  }), {
    toolFilterAllow: 'read, glob',
    maxDepth: '3',
    stages: [{ name: '了解', tools: 'read' }],
  })
})

test('param overrides：只发送已有键或偏离默认值的字段', () => {
  const overrides = buildParamOverrides({ ...EMPTY_FIELDS, firstTurnText: 'hello' }, {
    loadedKeys: new Set(['guideText']),
  })
  assert.equal(overrides.firstTurnText, 'hello')
  assert.equal(overrides.guideText, '', '已有空键必须发送以执行删键语义')
  assert.equal('promoteGate' in overrides, false)
})

test('param overrides：自动预选 provider 在模型为空时不落盘', () => {
  const overrides = buildParamOverrides({ ...EMPTY_FIELDS, modelProvider: 'deepseek' }, {
    loadedKeys: new Set(),
    autoModelProvider: 'deepseek',
  })
  assert.equal('modelProvider' in overrides, false)
  const explicit = buildParamOverrides({ ...EMPTY_FIELDS, modelProvider: 'deepseek', modelName: 'chat' }, {
    loadedKeys: new Set(),
    autoModelProvider: 'deepseek',
  })
  assert.equal(explicit.modelProvider, 'deepseek')
})
