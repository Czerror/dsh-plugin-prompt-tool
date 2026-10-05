import test from 'node:test'
import assert from 'node:assert/strict'
import { EMPTY_FIELDS } from '../../src/client/data/prompt-tool-fields.ts'
import { buildParamOverrides, readParamOverridesPatch, updateLoadedParamKeys } from '../../src/client/data/param-overrides.ts'
import { snapshotSwitches, switchesEqual } from '../../src/client/data/dirty-state.ts'

// 离线迁移可读取这些旧键，公共参数 bridge 永远不承载它们。
const legacyRoutes = {
  modelProvider: 'main-provider', modelName: 'main-model', modelReasoningEffort: 'high', modelTemperature: '0', modelMaxTokens: '8192',
  subagentModelProvider: 'sub-provider', subagentModelName: 'sub-model', subagentReasoningEffort: 'low', subagentTemperature: '0.5', subagentMaxTokens: '4096',
}

test('public params read ignores rule-owned routes and preserves ordinary zero/false/list values', () => {
  assert.deepEqual(readParamOverridesPatch({ ...legacyRoutes, maxDepth: 0, instructionHint: false, toolGitBashEnabled: false, customToolRequireApproval: ['shell', 'http'], unknown: 'keep out' }), {
    maxDepth: '0', instructionHint: false, toolGitBashEnabled: false, customToolRequireApproval: 'shell, http',
  })
})

test('public params save excludes loaded legacy routes and round-trips zero, false and explicit clears', () => {
  const fields = { ...EMPTY_FIELDS, ...legacyRoutes, maxDepth: '0', instructionHint: false, toolGitBashEnabled: false, customToolRequireApproval: '' }
  const loadedKeys = new Set([...Object.keys(legacyRoutes), 'instructionHint', 'customToolRequireApproval'])
  assert.deepEqual(buildParamOverrides(fields, { loadedKeys }), { maxDepth: 0, instructionHint: false, toolGitBashEnabled: false, customToolRequireApproval: [] })
  const saved = new Set()
  updateLoadedParamKeys(saved, { ...legacyRoutes, maxDepth: 0, instructionHint: false, customToolRequireApproval: ['shell'] })
  assert.deepEqual([...saved].sort(), ['customToolRequireApproval', 'instructionHint', 'maxDepth'])
  updateLoadedParamKeys(saved, { maxDepth: '', customToolRequireApproval: [] })
  assert.deepEqual([...saved], ['instructionHint'])
})

test('public params dirty state ignores rule-owned routes but tracks ordinary edits', () => {
  const baseline = snapshotSwitches(EMPTY_FIELDS)
  assert.ok(switchesEqual(baseline, snapshotSwitches({ ...EMPTY_FIELDS, ...legacyRoutes })))
  assert.equal(switchesEqual(baseline, snapshotSwitches({ ...EMPTY_FIELDS, maxDepth: '0' })), false)
  assert.equal(switchesEqual(baseline, snapshotSwitches({ ...EMPTY_FIELDS, toolGitBashEnabled: false })), false)
})
