import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 隔离 DSH_HOME（buildModuleConfigsFromParams 无路径依赖，但保持与其他 host 测试一致）。
const home = mkdtempSync(join(tmpdir(), 'pt-contract-'))
process.env.DSH_HOME = home
const {
  ENGINE_PARAM_KEYS,
  WRITER_PARAM_KEYS,
  PARAM_KEYS,
  buildModuleConfigsFromParams,
  MODEL_SEGMENT_MAP,
} = await import('../../lib/index.mjs')

/** 非 writer 键的合法样本值（类型与引擎消费一致；键缺失时测试报「无装配消费」）。 */
const BRIDGE_SAMPLES = {
  promoteGate: true,
  promoteAfterFirstResponse: true,
  maxPromoteSteps: 5,
  bootstrapTools: ['bash'],
  compactionTools: ['read'],
  personaSectionsOnly: true,
  workspaceLine: true,
  phase1FirstCallInstruction: 'x',
  messageSources: ['user'],
  deferredSources: ['skill-catalog'],
  deferredGraceSteps: 1,
  instructionHint: true,
  stages: [{ name: 's', tools: ['t'] }],
  stagePreUnlock: 2,
  stageAdvanceTool: 'x',
  stageAdvanceDescription: 'x',
  stageSectionTemplate: 'x',
  toolFilterSubagents: true,
  strReplaceEditorMaxOutputChars: 20000,
}

test('PARAM_KEYS 派生一致性：= ENGINE_PARAM_KEYS + 锚定内容键 + promptConfigs', () => {
  const EXTRA = new Set(['buildPattern', 'complexPattern', 'firstTurnBuild', 'firstTurnInspect', 'firstTurnDeep',
    'guideComplexPattern', 'guideWeak', 'guideDeep', 'promptConfigs'])
  const engineKeys = new Set(ENGINE_PARAM_KEYS)
  for (const key of PARAM_KEYS) {
    assert.ok(engineKeys.has(key) || EXTRA.has(key), `${key} 应属于 ENGINE_PARAM_KEYS 或附加键`)
  }
  for (const key of ENGINE_PARAM_KEYS) {
    assert.ok(PARAM_KEYS.has(key), `${key} 应从 ENGINE_PARAM_KEYS 派生进 PARAM_KEYS`)
  }
  for (const key of EXTRA) {
    assert.ok(PARAM_KEYS.has(key), `${key} 附加键应存在`)
  }
  // 无重复。
  assert.equal(PARAM_KEYS.size, ENGINE_PARAM_KEYS.length + EXTRA.size, 'PARAM_KEYS 无重复键')
})

test('ENGINE_PARAM_KEYS 每个非 writer 键都有参数桥装配消费（防「加键没装配」）', () => {
  const writerKeys = new Set(WRITER_PARAM_KEYS)
  const bridgeConsumed = new Set(Object.keys(buildModuleConfigsFromParams({})))
  for (const key of ENGINE_PARAM_KEYS) {
    if (writerKeys.has(key)) continue // writePreset.runtimeOf 透传（模型 patch / prompt-injector 等）。
    assert.ok(BRIDGE_SAMPLES[key] !== undefined, `${key} 缺测试样本值`)
    const configs = buildModuleConfigsFromParams({ [key]: BRIDGE_SAMPLES[key] })
    assert.ok(Object.keys(configs).length > 0, `${key} 应被参数桥消费（产出组合行 config）`)
    for (const id of Object.keys(configs)) bridgeConsumed.add(id)
  }
  assert.ok(bridgeConsumed.has('tool-bootstrap') && bridgeConsumed.has('context-gate'),
    '参数桥应覆盖核心引擎行')
})

test('MODEL_SEGMENT_MAP 双向一致：展平读回 = 保存写回（段目标唯一）', () => {
  const targets = new Set()
  for (const [flatKey, [segment, segmentKey]] of Object.entries(MODEL_SEGMENT_MAP)) {
    assert.ok(flatKey.length > 0 && segment.length > 0 && segmentKey.length > 0, `映射项非空: ${flatKey}`)
    const target = `${segment}.${segmentKey}`
    assert.ok(!targets.has(target), `段目标重复: ${target}（两个扁平键映射到同一段键）`)
    targets.add(target)
  }
  assert.equal(Object.keys(MODEL_SEGMENT_MAP).length, 10, '模型段映射应覆盖 10 个扁平键')
})

rmSync(home, { recursive: true, force: true })
