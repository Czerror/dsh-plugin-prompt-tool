import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { isolatedHome } from '../fixtures/host-harness.mjs'

const { presetRoot } = isolatedHome('pt-layer-settings-')
const { ENGINE_PARAM_LAYERS, engineParamPath } = await import('../../src/host/preset-layer-settings.ts')
const { ENGINE_PARAM_KEYS, ENGINE_PARAM_DEFINITIONS } = await import('../../src/shared/engine-params.ts')
const { ENGINE_EDITOR_GROUP_MAP } = await import('../../src/shared/engine-capabilities.ts')
const { loadPresetSpec, savePresetParams, savePresetPersona, withPresetDoc, createEngineCapabilityInPreset, removeEngineCapabilityFromPreset, resolvePresetParams, renderComposition, resolvePresetModuleFacts, resolveRenderablePresetDir, duplicateUserPreset } = await import('../../src/host/manifest.ts')

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
  assert.deepEqual(readdirSync(dir), ['preset.yml'], '参数保存仅更新预设定义，不生成额外备份文件')
})

test('旧参数段按未知字段保留但不生效，读取和保存只使用 layerSettings', () => {
  for (const [id, body] of [
    ['old-flat', 'params: { injectPrompt: false }\n'],
    ['old-model', 'model: { provider: vendor }\n'],
    ['old-child', 'subagentModel: { temperature: 0 }\n'],
    ['pt-minimal', 'params: { injectPrompt: true }\n'],
  ]) {
    const dir = preset(id, body)
    const file = join(dir, 'preset.yml')
    const before = parseYaml(readFileSync(file, 'utf8'))
    assert.deepEqual(loadPresetSpec(dir).params ?? {}, {})
    savePresetParams(presetRoot, id, { injectPrompt: true }, [])
    savePresetPersona(presetRoot, id, null)
    withPresetDoc(dir, (doc) => doc.set('variables', { x: 'v' }))
    assert.deepEqual(loadPresetSpec(dir).params, { injectPrompt: true })
    assert.equal(resolveRenderablePresetDir(id, presetRoot).dir, dir)
    const duplicate = duplicateUserPreset(id, presetRoot)
    assert.equal(duplicate.ok, true, duplicate.message)
    assert.deepEqual(loadPresetSpec(join(presetRoot, duplicate.id)).params, { injectPrompt: true })
    const after = parseYaml(readFileSync(file, 'utf8'))
    for (const segment of ['params', 'model', 'subagentModel']) assert.deepEqual(after[segment], before[segment])
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

test('直接渲染原始定义也忽略旧 params，能力编辑不会使旧值重新生效', () => {
  const source = { id: 'raw', modules: [], params: { toolGitBashEnabled: true, modelName: 'old' }, model: { provider: 'old' } }
  assert.deepEqual(resolvePresetParams(source, {}), { promptText: '' })
  assert.deepEqual(resolvePresetModuleFacts(source).effectiveModules, [])
  assert.deepEqual(parseYaml(renderComposition(source, {})), [])
  assert.equal(resolvePresetParams(source, { modelName: 'explicit' }).modelName, 'explicit', '当前调用方的显式运行参数仍生效')
  const dir = preset('raw-capability', 'params: { toolGitBashEnabled: true }\n')
  createEngineCapabilityInPreset(dir, { action: 'create', capabilityId: 'tool-config-engine' })
  const disk = parseYaml(readFileSync(join(dir, 'preset.yml'), 'utf8'))
  assert.deepEqual(disk.params, { toolGitBashEnabled: true })
  assert.ok(!resolvePresetModuleFacts(disk).effectiveModules.includes('tool-git-bash'))
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

test('复制与导出保持当前格式参数', async () => {
  const { exportPresetPackage } = await import('../../src/host/preset-package.ts')
  preset('export', 'layerSettings:\n  pre-step:\n    injectPrompt: false\n')
  const exported = await exportPresetPackage(presetRoot, { id: 'export', mode: 'definition' })
  assert.equal(exported.files.some(({ path }) => path.startsWith('.')), false)
  assert.equal(parseYaml(exported.content).layerSettings['pre-step'].injectPrompt, false)
  const copied = duplicateUserPreset('export', presetRoot)
  assert.equal(copied.ok, true, copied.message)
  assert.equal(loadPresetSpec(join(presetRoot, copied.id)).params.injectPrompt, false)
})
