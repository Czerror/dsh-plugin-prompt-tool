import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { isolatedHome } from '../fixtures/host-harness.mjs'

const { presetRoot } = isolatedHome('pt-layer-settings-')
const { ENGINE_PARAM_LAYERS, engineParamPath, readPresetLayerSettings, migratePresetLayerSettings } = await import('../../src/host/preset-layer-settings.ts')
const { ENGINE_PARAM_KEYS, ENGINE_PARAM_DEFINITIONS } = await import('../../src/shared/engine-params.ts')
const { ENGINE_EDITOR_GROUP_MAP } = await import('../../src/shared/engine-capabilities.ts')
const { loadPresetSpec, savePresetParams, savePresetPersona, withPresetDoc, createEngineCapabilityInPreset, removeEngineCapabilityFromPreset, renderComposition, resolvePresetModuleFacts, resolveRenderablePresetDir, duplicateUserPreset } = await import('../../src/host/manifest.ts')
const { migrateFile } = await import('../../scripts/migrate-layer-settings.mjs')

function preset(id, body) {
  const dir = join(presetRoot, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'preset.yml'), `id: ${id}\nname: ${id}\nmodules: []\n${body}`, 'utf8')
  return dir
}

test('每个登记参数的存储层从编辑组目录派生，未知键不能保存', () => {
  assert.equal(Object.keys(ENGINE_PARAM_LAYERS).length, ENGINE_PARAM_KEYS.length)
  for (const key of ENGINE_PARAM_KEYS) {
    const group = ENGINE_EDITOR_GROUP_MAP.find(({ id }) => id === ENGINE_PARAM_DEFINITIONS[key].card)
    assert.deepEqual(engineParamPath(key), ['layerSettings', group.displayLayer, key])
  }
  assert.throws(() => engineParamPath('futureFlag'), /未知引擎参数/)
})

test('新格式按层往返、false/0 保留、空字符串和数组删除；规则参数与未知字段保持', () => {
  const dir = preset('roundtrip', 'params: { futureFlag: keep }\nlayerSettings:\n  pre-step:\n    injectPrompt: true # 注入注释\n    customField: keep\npromptConfigs:\n  - id: local\n    layer: pre-step\n    params: { injectPrompt: local }\n')
  // B7 T3：原用例用的 stagePreUnlock / bootstrapTools 已随七个专用能力删除，换成本批存活的键
  // （pre-step 布尔、agent-request 可为零的数字、tool-pipeline 的列表与布尔）。
  savePresetParams(presetRoot, 'roundtrip', { injectPrompt: false, modelTemperature: 0, toolGitBashEnabled: false, customToolRequireApproval: ['shell'] }, undefined)
  const first = loadPresetSpec(dir)
  assert.equal(first.params.injectPrompt, false)
  assert.equal(first.params.modelTemperature, 0)
  assert.equal(first.params.toolGitBashEnabled, false)
  assert.deepEqual(first.params.customToolRequireApproval, ['shell'])
  assert.equal(first.params.futureFlag, undefined)
  assert.equal(first.params.customField, undefined)
  savePresetParams(presetRoot, 'roundtrip', { modelTemperature: '', customToolRequireApproval: [] }, undefined)
  const raw = readFileSync(join(dir, 'preset.yml'), 'utf8')
  const disk = parseYaml(raw)
  assert.match(raw, /注入注释/)
  assert.equal(disk.layerSettings['pre-step'].injectPrompt, false)
  assert.equal(disk.layerSettings['tool-pipeline'].toolGitBashEnabled, false, 'false 是合法值，必须留在盘上')
  assert.equal(disk.layerSettings['agent-request'].modelTemperature, undefined, '空串删键')
  assert.equal(disk.layerSettings['tool-pipeline'].customToolRequireApproval, undefined, '空数组删键')
  assert.equal(disk.params.futureFlag, 'keep')
  assert.equal(disk.layerSettings['pre-step'].customField, 'keep')
  assert.equal(disk.promptConfigs[0].params.injectPrompt, 'local')
})

test('所有旧位置登记键必须显式迁移，其他段保存与模板回退也不能绕过', () => {
  for (const [id, body] of [
    ['old-flat', 'params: { injectPrompt: false }\n'],
    ['old-model', 'model: { provider: vendor }\n'],
    ['old-child', 'subagentModel: { temperature: 0 }\n'],
    ['pt-minimal', 'params: { injectPrompt: true }\n'],
  ]) {
    const dir = preset(id, body)
    const file = join(dir, 'preset.yml')
    const before = readFileSync(file)
    const code = { code: 'preset-migration-required' }
    assert.throws(() => loadPresetSpec(dir), code)
    assert.throws(() => savePresetParams(presetRoot, id, undefined, []), code)
    assert.throws(() => savePresetPersona(presetRoot, id, null), code)
    assert.throws(() => withPresetDoc(dir, (doc) => doc.set('variables', { x: 'v' })), code)
    assert.throws(() => createEngineCapabilityInPreset(dir, { action: 'create', capabilityId: 'tool-filter' }), code)
    assert.throws(() => removeEngineCapabilityFromPreset(dir, 'tool-filter'), code)
    assert.throws(() => resolveRenderablePresetDir(id, presetRoot), code)
    assert.equal(duplicateUserPreset(id, presetRoot).ok, false)
    assert.deepEqual(readFileSync(file), before)
  }
})

test('新字段拒绝错误层和非对象形状，不写盘', () => {
  const bodies = ['layerSettings: []\n', 'layerSettings: null\n', 'layerSettings: { unknown: {} }\n', 'layerSettings: { pre-step: false }\n', 'layerSettings: { pre-step: { modelName: wrong } }\n']
  bodies.forEach((body, index) => {
    const dir = preset(`bad-shape-${index}`, body)
    const before = readFileSync(join(dir, 'preset.yml'))
    assert.throws(() => loadPresetSpec(dir), { code: 'preset-layer-settings-invalid' })
    assert.throws(() => savePresetParams(presetRoot, `bad-shape-${index}`, undefined, []), { code: 'preset-layer-settings-invalid' })
    assert.deepEqual(readFileSync(join(dir, 'preset.yml')), before)
  })
})

test('节点迁移保留注释、未知字段、false/0、实例参数，并保持组合行为等价', () => {
  // B7 T3：`bootstrapMaxTokens` 已随 tool-bootstrap 删除，换成本批存活的同层键
  // （modelTemperature 为 agent-request 的可为零数字，customToolRequireApproval 为 tool-pipeline 列表）。
  const legacy = '# 文档注释\nid: migration\nmodules: [prompt-config-engine]\nparams: # 旧段注释\n  modelTemperature: 0 # 数值注释\n  injectPrompt: false\n  futureFlag: keep\nmodel:\n  provider: vendor # 模型注释\n  futureModel: keep\nsubagentModel:\n  maxTokens: 4096\npromptConfigs:\n  - id: local\n    layer: pre-step\n    params: { injectPrompt: true }\n'
  const migrated = migratePresetLayerSettings(legacy)
  const value = parseYaml(migrated.text)
  for (const comment of ['文档注释', '旧段注释', '数值注释', '模型注释']) assert.match(migrated.text, new RegExp(comment))
  assert.deepEqual(readPresetLayerSettings(value), { modelTemperature: 0, injectPrompt: false, modelProvider: 'vendor', subagentMaxTokens: 4096 })
  assert.equal(value.params.futureFlag, 'keep')
  assert.equal(value.model.futureModel, 'keep')
  assert.equal(value.promptConfigs[0].params.injectPrompt, true)
  const prior = { id: 'migration', modules: ['prompt-config-engine'], params: { modelTemperature: 0, injectPrompt: false, modelProvider: 'vendor', subagentMaxTokens: 4096 } }
  assert.deepEqual(parseYaml(renderComposition(value, {})), parseYaml(renderComposition(prior, {})))
  assert.deepEqual(migratePresetLayerSettings(migrated.text), { text: migrated.text, moved: [] })
})

test('显式迁移冲突与非法 YAML 拒绝；原文件及备份均不改变', () => {
  for (const [id, body] of [
    ['mixed', 'params: { injectPrompt: false }\nlayerSettings: { pre-step: { injectPrompt: true } }\n'],
    ['same-value', 'params: { injectPrompt: false }\nlayerSettings: { pre-step: { injectPrompt: false } }\n'],
    ['two-old', 'params: { modelProvider: a }\nmodel: { provider: b }\n'],
    ['bad-yaml', 'params: [unterminated\n'],
  ]) {
    const dir = preset(id, body)
    const original = readFileSync(join(dir, 'preset.yml'))
    assert.throws(() => migrateFile(dir, { write: true }))
    assert.deepEqual(readFileSync(join(dir, 'preset.yml')), original)
    assert.equal(existsSync(join(dir, '.layer-settings-backup.json')), false)
  }
})

test('迁移默认预览，显式写入幂等；受 hash 保护的恢复拒绝覆盖用户编辑并恢复原字节', () => {
  const dir = preset('rollback', '# 原文\nparams:\n  injectPrompt: false\n')
  const file = join(dir, 'preset.yml')
  const original = readFileSync(file)
  assert.equal(migrateFile(dir).mode, 'preview')
  assert.deepEqual(readFileSync(file), original)
  assert.equal(existsSync(join(dir, '.layer-settings-backup.json')), false)
  const result = migrateFile(dir, { write: true })
  const migrated = readFileSync(file)
  assert.equal(result.mode, 'migrated')
  assert.equal(migrateFile(dir, { write: true }).mode, 'unchanged')
  assert.deepEqual(readFileSync(file), migrated)
  assert.equal(migrateFile(dir, { rollback: true }).mode, 'rollback-preview')
  assert.deepEqual(readFileSync(file), migrated)
  writeFileSync(file, Buffer.concat([migrated, Buffer.from('# 用户后来编辑\n')]))
  assert.throws(() => migrateFile(dir, { rollback: true, write: true }), /迁移后已被修改/)
  assert.match(readFileSync(file, 'utf8'), /用户后来编辑/)
  assert.ok(existsSync(result.backup))
  writeFileSync(file, migrated)
  assert.equal(migrateFile(dir, { rollback: true, write: true }).mode, 'restored')
  assert.deepEqual(readFileSync(file), original)
  assert.equal(existsSync(result.backup), false)
})

test('新格式参数隐含装配，能力移除同时删除所属参数，不影响同层其他能力', () => {
  // B7 T3：原用例用 deliberation-gate + `create-recipe`（recipe 已清空），换成本批存活的能力提供者。
  const dir = preset('capability', 'layerSettings:\n  tool-pipeline:\n    toolGitBashEnabled: false\n    customToolRequireApproval: ["shell"]\n    futureFlag: keep\n')
  const spec = loadPresetSpec(dir)
  assert.ok(resolvePresetModuleFacts(spec, dir, true).effectiveModules.includes('tool-git-bash'))
  removeEngineCapabilityFromPreset(dir, 'tool-git-bash')
  const after = loadPresetSpec(dir)
  assert.equal(after.params.toolGitBashEnabled, undefined, '该能力的参数一起移除')
  assert.deepEqual(after.params.customToolRequireApproval, ['shell'], '同层其他能力的参数不受影响')
  assert.equal(after.layerSettings['tool-pipeline'].futureFlag, 'keep')
  assert.ok(!resolvePresetModuleFacts(after, dir, true).effectiveModules.includes('tool-git-bash'))
  createEngineCapabilityInPreset(dir, { action: 'create', capabilityId: 'tool-git-bash' })
  assert.ok(resolvePresetModuleFacts(loadPresetSpec(dir), dir, true).effectiveModules.includes('tool-git-bash'),
    '显式创建后该能力重新进入装配事实')
})

test('迁移备份不进入导出资产；复制与导出保持新格式参数', async () => {
  const { exportPresetPackage } = await import('../../src/host/preset-package.ts')
  const dir = preset('export', 'params: { injectPrompt: false }\n')
  migrateFile(dir, { write: true })
  const exported = await exportPresetPackage(presetRoot, { id: 'export', mode: 'definition' })
  assert.equal(exported.files.some(({ path }) => path.startsWith('.')), false)
  assert.equal(parseYaml(exported.content).layerSettings['pre-step'].injectPrompt, false)
  const copied = duplicateUserPreset('export', presetRoot)
  assert.equal(copied.ok, true, copied.message)
  assert.equal(loadPresetSpec(join(presetRoot, copied.id)).params.injectPrompt, false)
})

test('CLI 默认仅预览，--write 与 --rollback --write 操作指定预设', () => {
  const dir = preset('cli', 'params: { injectPrompt: false }\n')
  const cli = fileURLToPath(new URL('../../scripts/migrate-layer-settings.mjs', import.meta.url))
  const file = join(dir, 'preset.yml')
  const original = readFileSync(file)
  for (const [args, mode] of [[[], 'preview'], [['--write'], 'migrated'], [['--rollback', '--write'], 'restored']]) {
    const run = spawnSync(process.execPath, [cli, dir, ...args], { encoding: 'utf8', cwd: process.cwd() })
    assert.equal(run.status, 0, run.stderr)
    assert.equal(JSON.parse(run.stdout).mode, mode)
    if (mode === 'preview' || mode === 'restored') assert.deepEqual(readFileSync(file), original)
  }
})
