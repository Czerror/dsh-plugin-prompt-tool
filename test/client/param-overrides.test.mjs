import test from 'node:test'
import assert from 'node:assert/strict'
import { EMPTY_FIELDS } from '../../src/client/data/prompt-tool-fields.ts'
import { buildParamOverrides, readParamOverridesPatch, updateLoadedParamKeys } from '../../src/client/data/param-overrides.ts'
import { snapshotSwitches, switchesEqual } from '../../src/client/data/dirty-state.ts'

// 模型路由/采样参数与 maxDepth 一样是公共参数：参数桥读写它们，运行时由 modelRequestConfigs 生成请求配置。
const modelParams = {
  modelProvider: 'main-provider', modelName: 'main-model', modelReasoningEffort: 'high', modelTemperature: '0', modelMaxTokens: '8192',
  subagentModelProvider: 'sub-provider', subagentModelName: 'sub-model', subagentReasoningEffort: 'low', subagentTemperature: '0.5', subagentMaxTokens: '4096',
}

test('public params read keeps model routes and preserves ordinary zero/false/list values', () => {
  assert.deepEqual(readParamOverridesPatch({ ...modelParams, maxDepth: 0, instructionHint: false, toolGitBashEnabled: false, customToolRequireApproval: ['shell', 'http'], unknown: 'keep out' }), {
    ...modelParams, maxDepth: '0', instructionHint: false, toolGitBashEnabled: false, customToolRequireApproval: 'shell, http',
  })
})

test('public params save round-trips model routes alongside zero, false and explicit clears', () => {
  const fields = { ...EMPTY_FIELDS, ...modelParams, maxDepth: '0', instructionHint: false, toolGitBashEnabled: false, customToolRequireApproval: '' }
  const loadedKeys = new Set([...Object.keys(modelParams), 'instructionHint', 'customToolRequireApproval'])
  assert.deepEqual(buildParamOverrides(fields, { loadedKeys }), {
    ...modelParams, maxDepth: 0, instructionHint: false, toolGitBashEnabled: false, customToolRequireApproval: [],
  })
  const saved = new Set()
  updateLoadedParamKeys(saved, { ...modelParams, maxDepth: 0, instructionHint: false, customToolRequireApproval: ['shell'] })
  assert.deepEqual([...saved].sort(), [...Object.keys(modelParams), 'customToolRequireApproval', 'instructionHint', 'maxDepth'].sort())
  updateLoadedParamKeys(saved, { maxDepth: '', customToolRequireApproval: [] })
  assert.deepEqual([...saved].sort(), [...Object.keys(modelParams), 'instructionHint'].sort())
})

test('public params dirty state tracks model routes like any other field', () => {
  const baseline = snapshotSwitches(EMPTY_FIELDS)
  assert.equal(switchesEqual(baseline, snapshotSwitches({ ...EMPTY_FIELDS, ...modelParams })), false)
  assert.equal(switchesEqual(baseline, snapshotSwitches({ ...EMPTY_FIELDS, maxDepth: '0' })), false)
  assert.equal(switchesEqual(baseline, snapshotSwitches({ ...EMPTY_FIELDS, toolGitBashEnabled: false })), false)
  assert.ok(switchesEqual(baseline, snapshotSwitches(EMPTY_FIELDS)), '未编辑的基线仍相等')
})
