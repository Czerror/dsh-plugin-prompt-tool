/**
 * `subagent-tool-policy` 作为模块类型能力的端到端核验。
 *
 * 用户决策：①启用写「可用骨架」；②单独一张能力卡内嵌策略编辑器；③删除能力时一并删除策略段。
 * 本文件覆盖宿主侧：启用 → 模块声明 + 顶层段骨架；物化 → subagent-tools/policy.yml；
 * 组合 → shadow 行；删除 → 模块与段同时消失；幂等与"已有策略不被覆盖"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'

const home = mkdtempSync(join(tmpdir(), 'pt-cap-home-'))
process.env.DSH_HOME = home
const {
  createEngineCapabilityInPreset,
  loadPresetSpec,
  removeEngineCapabilityFromPreset,
  renderComposition,
  writePreset,
} = await import('../../lib/index.mjs')
const { ENGINE_CAPABILITIES, SUBAGENT_TOOL_POLICY_SKELETON, engineCapability } = await import('../../src/shared/engine-capabilities.ts')
const { validateSubagentToolPolicy } = await import('../../engine/subagent-tool-policy-core.mjs')

const CAPABILITY_ID = 'subagent-tool-policy'
const PRESET_ID = 'cap-e2e'
const presetRoot = join(home, '.agent-presets')
const presetDir = join(presetRoot, PRESET_ID)

function seedPreset() {
  mkdirSync(presetDir, { recursive: true })
  writeFileSync(join(presetDir, 'preset.yml'),
    `id: ${PRESET_ID}\nname: ${PRESET_ID}\nversion: "1"\nengineCompat: ">=0"\nmodules:\n  - tool-fs\n  - delegation\nparams: {}\npromptConfigs: []\n`, 'utf8')
}

function writeOptions() {
  return {
    firstTurnAnchor: false, firstTurnText: '', firstTurnCustom: false,
    guideText: '', guideCustom: false, injectPrompt: true,
    modelProvider: '', modelName: '', subagentModelProvider: '', subagentModelName: '',
    bootstrapMaxTokens: 0, usePtcMode: false,
    presetDir: presetRoot, presetTemplate: PRESET_ID, presetOrder: 5,
  }
}

function findAllNested(rows, idSet) {
  const found = []
  const walk = (items) => {
    for (const item of Array.isArray(items) ? items : []) {
      if (item === null || typeof item !== 'object') continue
      if (idSet.has(item.id)) found.push(item)
      walk(item.config)
    }
  }
  walk(rows)
  return found
}

test('能力目录登记：subagent-tool-policy 带 ownSection 且骨架通过校验', () => {
  const capability = engineCapability(CAPABILITY_ID)
  assert.ok(capability, '能力目录必须登记 subagent-tool-policy')
  assert.deepEqual(capability.moduleKeys, [CAPABILITY_ID])
  assert.deepEqual(capability.rowIds, [CAPABILITY_ID])
  assert.equal(capability.displayLayer, 'tool-pipeline')
  assert.equal(capability.ownSection?.key, 'subagentToolPolicy')
  // 骨架必须能被策略校验接受（否则"启用即不可保存"）。
  assert.deepEqual(validateSubagentToolPolicy(SUBAGENT_TOOL_POLICY_SKELETON), [])
  // 目录里的每个能力都要有唯一 id。
  assert.equal(new Set(ENGINE_CAPABILITIES.map((item) => item.id)).size, ENGINE_CAPABILITIES.length)
})

test('启用能力：模块声明 + 顶层骨架同时写入，物化与组合链路成立', () => {
  seedPreset()
  const created = createEngineCapabilityInPreset(presetDir, { action: 'create', capabilityId: CAPABILITY_ID })
  assert.equal(created.changed, true)
  assert.deepEqual(created.addedModules, [CAPABILITY_ID])
  const spec = loadPresetSpec(presetDir)
  assert.ok(spec.modules.includes(CAPABILITY_ID), '模块声明写入')
  assert.deepEqual(spec.subagentToolPolicy, SUBAGENT_TOOL_POLICY_SKELETON, '启用即写入可用骨架（模块在 ⇒ 数据在）')

  // 物化：生成目录产出策略文件 + 生成目录 preset.yml 同步模块与段。
  writePreset('PROMPT', writeOptions())
  assert.deepEqual(parseYaml(readFileSync(join(presetDir, 'subagent-tools', 'policy.yml'), 'utf8')), SUBAGENT_TOOL_POLICY_SKELETON)
  const generated = loadPresetSpec(presetDir)
  assert.ok(generated.modules.includes(CAPABILITY_ID))
  assert.deepEqual(generated.subagentToolPolicy, SUBAGENT_TOOL_POLICY_SKELETON)

  // 组合：shadow 行装配。
  const [row] = findAllNested(parseYaml(renderComposition(generated, {}, presetDir)), new Set([CAPABILITY_ID]))
  assert.ok(row, '组合装配 shadow 行')
  assert.equal(row.config.policyFile, '../subagent-tools/policy.yml')
})

test('幂等与保护：重复启用不重复追加；段已有用户内容时只补模块、不覆盖策略', () => {
  seedPreset()
  createEngineCapabilityInPreset(presetDir, { action: 'create', capabilityId: CAPABILITY_ID })
  const second = createEngineCapabilityInPreset(presetDir, { action: 'create', capabilityId: CAPABILITY_ID })
  assert.equal(second.changed, false, '已装配且段已存在时不重复写盘')
  assert.equal(loadPresetSpec(presetDir).modules.filter((item) => item === CAPABILITY_ID).length, 1)
})

test('半状态自愈：段已有用户策略但没有模块声明时，启用补上模块声明且不覆盖策略', () => {
  seedPreset()
  // 手工构造"段在、模块不在"的历史状态（旧版本或手工编辑过 preset.yml）。
  const file = join(presetDir, 'preset.yml')
  writeFileSync(file, readFileSync(file, 'utf8').replace('params: {}',
    'subagentToolPolicy:\n  defaultProfile: reader\n  ceiling:\n    allow: [read]\n    deny: []\n  profiles:\n    - id: reader\n      name: 只读\n      allow: [read]\n      deny: []\n      modelSelectable: false\nparams: {}'), 'utf8')
  const custom = loadPresetSpec(presetDir).subagentToolPolicy
  assert.equal(custom.defaultProfile, 'reader')
  // 关键：段的存在让 resolvePresetModuleFacts 会把模块算进 effectiveModules，
  // 但声明的 modules 里没有它——判定必须只看 declaredModules，才能补齐声明。
  const created = createEngineCapabilityInPreset(presetDir, { action: 'create', capabilityId: CAPABILITY_ID })
  assert.equal(created.changed, true, '半状态必须能补上模块声明')
  assert.deepEqual(created.addedModules, [CAPABILITY_ID])
  const after = loadPresetSpec(presetDir)
  assert.ok(after.modules.includes(CAPABILITY_ID), '模块声明补齐')
  assert.deepEqual(after.subagentToolPolicy, custom, '既有策略内容不被骨架覆盖')
})

test('模块已在声明里时不重复写盘（幂等）', () => {
  seedPreset()
  createEngineCapabilityInPreset(presetDir, { action: 'create', capabilityId: CAPABILITY_ID })
  const again = createEngineCapabilityInPreset(presetDir, { action: 'create', capabilityId: CAPABILITY_ID })
  assert.equal(again.changed, false)
  assert.deepEqual(again.addedModules, [])
  assert.equal(loadPresetSpec(presetDir).modules.filter((item) => item === CAPABILITY_ID).length, 1)
})

test('删除能力：模块声明与顶层策略段一并移除（用户决策 3）', () => {
  seedPreset()
  createEngineCapabilityInPreset(presetDir, { action: 'create', capabilityId: CAPABILITY_ID })
  const removed = removeEngineCapabilityFromPreset(presetDir, CAPABILITY_ID)
  assert.equal(removed.changed, true)
  assert.deepEqual(removed.removedModules, [CAPABILITY_ID])
  const spec = loadPresetSpec(presetDir)
  assert.equal(spec.modules.includes(CAPABILITY_ID), false, '模块声明移除')
  assert.equal(spec.subagentToolPolicy, undefined, '顶层策略段一并删除')
  // 组合不再有 shadow 行。
  assert.deepEqual(findAllNested(parseYaml(renderComposition(spec, {}, presetDir)), new Set([CAPABILITY_ID])), [])
  // 再次删除幂等。
  assert.equal(removeEngineCapabilityFromPreset(presetDir, CAPABILITY_ID).changed, false)
})

test('只有段没有模块的残留也能被删除能力清理（半状态自愈）', () => {
  seedPreset()
  writeFileSync(join(presetDir, 'preset.yml'),
    readFileSync(join(presetDir, 'preset.yml'), 'utf8').replace('params: {}', `subagentToolPolicy:\n  defaultProfile: default\n  ceiling:\n    allow: [read]\n    deny: []\n  profiles:\n    - id: default\n      name: 默认\n      allow: [read]\n      deny: []\nparams: {}`), 'utf8')
  const removed = removeEngineCapabilityFromPreset(presetDir, CAPABILITY_ID)
  assert.equal(removed.changed, true, '模块不在但段存在时也必须清理')
  assert.equal(loadPresetSpec(presetDir).subagentToolPolicy, undefined)
})
