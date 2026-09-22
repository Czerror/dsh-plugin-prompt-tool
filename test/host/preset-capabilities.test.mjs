/**
 * 预设能力事实与能力创建/删除（2026-09-17 测试归一精简 Wave 2）。
 *
 * 合并自：engine-capability(8)、module-facts(6)、legacy-policy-facts(1)、subagent-creates-tool-filter(1)。
 * 用例标题与断言逐条原样保留；唯一调整是顶层样板：统一用 `isolatedHome()` 建隔离 DSH_HOME
 * （原 legacy-policy-facts 设置后不还原、subagent-creates-tool-filter 也只设不还），并把
 * 原先分散的 `../../lib/index.mjs` 动态导入合并为一次。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml, stringify } from 'yaml'
import { SUBAGENT_TOOL_POLICY_SKELETON } from '../../src/shared/engine-capabilities.ts'
import { FIXTURE_PRESET_SRC } from '../fixtures/preset-template.mjs'
import { isolatedHome } from '../fixtures/host-harness.mjs'

const { home } = isolatedHome('pt-preset-capabilities-')
const {
  ENGINE_CAPABILITIES,
  createEngineCapabilityInPreset,
  isEngineCapabilityPresent,
  loadPresetSpec,
  removeEngineCapabilityFromPreset,
  renderComposition,
  resolvePresetModuleFacts,
  validateCustomToolIdentities,
} = await import('../../lib/index.mjs')
const { modelRequestConfigs } = await import('../../src/host/prompt-configs.ts')
const { createPromptConfigs } = await import('../../engine/schema.mjs')
const { wireLayers } = await import('../../engine/layers.mjs')

// —— 能力创建/删除（原 engine-capability.test.mjs） ——

test('能力创建一次写入 modules 并保持幂等', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pt-engine-capability-'))
  try {
    const file = join(dir, 'preset.yml')
    writeFileSync(file, [
      'id: demo', 'name: demo', 'version: "1"', 'engineCompat: ">=0"',
      'modules: [prompt-config-engine]', 'params: { customKeep: true }',
      'moduleConfigs:', '  tool-web:', '    fetch: true', '',
    ].join('\n'), 'utf8')
    // B7 T3：recipe（`deliberation` 等）已随能力删除清空，改用存活的单项能力。
    const first = createEngineCapabilityInPreset(dir, { action: 'create', capabilityId: 'tool-git-bash' })
    assert.equal(first.changed, true)
    const parsed = parseYaml(readFileSync(file, 'utf8'))
    assert.ok(parsed.modules.includes('tool-git-bash'))
    assert.equal(parsed.params.customKeep, true)
    const before = readFileSync(file, 'utf8')
    const second = createEngineCapabilityInPreset(dir, { action: 'create', capabilityId: 'tool-git-bash' })
    assert.equal(second.changed, false)
    assert.equal(readFileSync(file, 'utf8'), before)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('能力候选校验失败时不写入 preset.yml', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pt-engine-capability-invalid-'))
  try {
    const file = join(dir, 'preset.yml')
    writeFileSync(file, 'id: demo\nname: demo\nversion: "1"\nengineCompat: ">=0"\nmodules: [missing-module]\n', 'utf8')
    const before = readFileSync(file, 'utf8')
    assert.throws(() => createEngineCapabilityInPreset(dir, { action: 'create', capabilityId: 'tool-git-bash' }))
    assert.equal(readFileSync(file, 'utf8'), before)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('filesystem 组合已满足编辑器能力时不追加独立模块', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pt-engine-capability-nested-'))
  try {
    const file = join(dir, 'preset.yml')
    writeFileSync(file, 'id: nested\nname: nested\nversion: "1"\nengineCompat: ">=0"\nmodules: [filesystem-editor]\n', 'utf8')
    const before = readFileSync(file, 'utf8')
    const result = createEngineCapabilityInPreset(dir, { action: 'create', capabilityId: 'str-replace-editor' })
    assert.equal(result.changed, false)
    assert.deepEqual(result.addedModules, [])
    assert.equal(readFileSync(file, 'utf8'), before)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('能力候选校验拒绝重复 Loader row 且不写盘', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pt-engine-capability-duplicate-row-'))
  try {
    const file = join(dir, 'preset.yml')
    writeFileSync(file, 'id: duplicate-row\nname: duplicate-row\nversion: "1"\nengineCompat: ">=0"\nmodules: [delegation, delegation-ptc]\n', 'utf8')
    const before = readFileSync(file, 'utf8')
    assert.throws(
      () => createEngineCapabilityInPreset(dir, { action: 'create', capabilityId: 'tool-git-bash' }),
      /重复 row id[\s\S]*delegation/,
    )
    assert.equal(readFileSync(file, 'utf8'), before)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('删除编辑器能力移除 filesystem-editor 组合', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pt-engine-capability-remove-editor-'))
  try {
    const file = join(dir, 'preset.yml')
    writeFileSync(file, 'id: remove-editor\nname: remove-editor\nversion: "1"\nengineCompat: ">=0"\nmodules: [filesystem-editor, prompt-config-engine]\n', 'utf8')
    const result = removeEngineCapabilityFromPreset(dir, 'str-replace-editor')
    assert.deepEqual(result, { changed: true, removedModules: ['filesystem-editor'], capabilityIds: ['str-replace-editor'] })
    assert.deepEqual(parseYaml(readFileSync(file, 'utf8')).modules, ['prompt-config-engine'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('空白预设只装配用户新建的单项能力', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pt-engine-capability-blank-'))
  try {
    const file = join(dir, 'preset.yml')
    writeFileSync(file, 'id: blank\nname: blank\nversion: "1"\nengineCompat: ">=0"\nmodules: []\n', 'utf8')
    const result = createEngineCapabilityInPreset(dir, { action: 'create', capabilityId: 'tool-git-bash' })
    assert.equal(result.changed, true)
    assert.deepEqual(parseYaml(readFileSync(file, 'utf8')).modules, ['tool-git-bash'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('删除能力连显式参数与行配置一起移除，保留未登记参数与未知字段', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pt-engine-capability-remove-'))
  try {
    const file = join(dir, 'preset.yml')
    // B7 T3：载体换成存活的能力提供者（tool-git-bash 有 `toolGitBashEnabled` 参数与自有行配置）。
    writeFileSync(file, [
      'id: demo', 'name: demo', 'version: "1"', 'engineCompat: ">=0"',
      'modules: [tool-git-bash, filesystem-editor]',
      'params: { customKeep: true }',
      'layerSettings: { tool-pipeline: { toolGitBashEnabled: false } }',
      'moduleConfigs:', '  tool-git-bash:', '    timeoutMs: 90000',
      'unknown: keep', '',
    ].join('\n'), 'utf8')
    const first = removeEngineCapabilityFromPreset(dir, 'tool-git-bash')
    assert.deepEqual(first, { changed: true, removedModules: ['tool-git-bash'], capabilityIds: ['tool-git-bash'] })
    const parsed = parseYaml(readFileSync(file, 'utf8'))
    assert.deepEqual(parsed.modules, ['filesystem-editor'])
    assert.equal(parsed.layerSettings['tool-pipeline'].toolGitBashEnabled, undefined, '该能力参数随能力一起移除（参数在 ⇒ 装配在）')
    assert.equal(parsed.params.customKeep, true, '未登记的键不是引擎参数，不碰')
    assert.equal(parsed.moduleConfigs?.['tool-git-bash'], undefined, '该能力的行配置一起移除')
    assert.equal(parsed.unknown, 'keep')
    assert.equal(removeEngineCapabilityFromPreset(dir, 'tool-git-bash').changed, false, '重复删除幂等')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('参数在 ⇒ 装配在：显式参数与行配置自动补齐能力模块', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pt-implied-modules-'))
  try {
    // B7 T3：载体换成存活的能力提供者（参数 → tool-git-bash，行配置 → tool-config-engine）。
    writeFileSync(join(dir, 'preset.yml'), [
      'id: implied', 'name: implied', 'version: "1"', 'engineCompat: ">=0"',
      'modules: [tool-web]',
      'params: { customKeep: true }',
      'layerSettings: { tool-pipeline: { toolGitBashEnabled: false } }',
      'moduleConfigs:', '  tool-config-engine:', '    requireApproval: [shell]',
      '',
    ].join('\n'), 'utf8')
    const spec = loadPresetSpec(dir)
    const facts = resolvePresetModuleFacts(spec, dir, true)
    assert.deepEqual(facts.declaredModules, ['tool-web'], '声明事实仍是磁盘内容，不伪造')
    assert.ok(facts.effectiveModules.includes('tool-git-bash'), '参数隐含的模块进入装配事实')
    assert.ok(facts.effectiveModules.includes('tool-config-engine'), '行配置隐含的模块进入装配事实')
    assert.equal(isEngineCapabilityPresent('tool-git-bash', facts), true, '编辑卡据此出现')
    const ids = parseYaml(renderComposition(spec, {}, dir)).map((row) => row.id)
    assert.ok(ids.includes('tool-git-bash'), '装配产物真的含该能力行')
    assert.ok(ids.includes('tool-config-engine'), '行配置隐含的模块同样真的装配')
    assert.equal(facts.effectiveModules.includes('filesystem-editor'), false, '无关参数不触发其他能力')
    // 移除能力时参数与行配置一起消失：不会再被隐含装配拉回来。
    assert.equal(removeEngineCapabilityFromPreset(dir, 'tool-git-bash').changed, true)
    const after = resolvePresetModuleFacts(loadPresetSpec(dir), dir, true)
    assert.equal(after.effectiveModules.includes('tool-git-bash'), false, '移除后不再隐含装配')
    assert.equal(loadPresetSpec(dir).params?.toolGitBashEnabled, undefined, '移除后参数已随能力删除')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('删除最后一项能力后保持显式空组合', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pt-engine-capability-remove-last-'))
  try {
    const file = join(dir, 'preset.yml')
    writeFileSync(file, 'id: blank\nname: blank\nversion: "1"\nengineCompat: ">=0"\nmodules: [tool-git-bash]\n', 'utf8')
    const result = removeEngineCapabilityFromPreset(dir, 'tool-git-bash')
    assert.equal(result.changed, true)
    assert.deepEqual(parseYaml(readFileSync(file, 'utf8')).modules, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// —— 模块事实（原 module-facts.test.mjs） ——

test('实际规则和请求参数自动补齐执行引擎，空预设与手写组合保持独立', () => {
  const blank = { id: 'blank', modules: [], promptConfigs: [] }
  for (const spec of [
    { ...blank, promptConfigs: [{ id: 'rule', text: 'RUN', layer: 'pre-step' }] },
    { ...blank, layerSettings: { 'agent-request': { modelTemperature: 0 } } },
    { ...blank, layerSettings: { 'agent-request': { modelProvider: 'provider-a', modelName: 'model-a' } } },
    { ...blank, layerSettings: { 'subagent-start': { subagentReasoningEffort: 'high' } } },
  ]) {
    const facts = resolvePresetModuleFacts(spec)
    assert.deepEqual(facts.declaredModules, [])
    assert.deepEqual(facts.effectiveModules, ['prompt-config-engine'])
    assert.ok(facts.rowIds.includes('prompt-config-engine'))
    assert.ok(parseYaml(renderComposition(spec, {})).some(row => row.id === 'prompt-config-engine'))
    assert.deepEqual(spec.modules, [], '只派生必要装配，不修改预设声明')
  }
  assert.deepEqual(resolvePresetModuleFacts(blank).effectiveModules, [])
  assert.deepEqual(parseYaml(renderComposition(blank, {})), [])
  assert.deepEqual(parseYaml(renderComposition({ ...blank, modules: undefined, composition: '[]\n', promptConfigs: [{ id: 'rule', text: 'RUN' }] }, {})), [])
  assert.ok(parseYaml(renderComposition(blank, { modelMaxTokens: 128 })).some(row => row.id === 'prompt-config-engine'), '显式运行参数同样需要消费者')
  assert.deepEqual(parseYaml(renderComposition({ ...blank, layerSettings: { 'agent-request': { modelTemperature: '' } } }, {})), [], '空参数不产生请求规则或执行引擎')
})

test('预设主模型在自身请求中生效，其他预设与子代理不继承该覆盖', async () => {
  const inherited = { provider: 'host', model: 'host-model', temperature: 0.5 }
  const requestFor = async (params, depth = 0) => {
    let request
    const configs = createPromptConfigs(modelRequestConfigs(params))
    wireLayers({ get: () => undefined, on: (name, listener) => { if (name === 'agent/request') request = listener } }, configs, () => {})
    return request === undefined ? { ...inherited } : request({ agent: { session: { header: { delegationDepth: depth } } } }, async () => ({ ...inherited }))
  }
  const a = { modelProvider: 'provider-a', modelName: 'model-a', modelTemperature: 0 }
  assert.deepEqual(await requestFor(a), { provider: 'provider-a', model: 'model-a', temperature: 0 })
  assert.deepEqual(await requestFor({}), inherited, '未配置模型的预设继承宿主，不能继承 A')
  assert.deepEqual(await requestFor(a, 1), inherited, '主模型覆盖不强写子代理')
  assert.deepEqual(modelRequestConfigs({ modelProvider: 'provider-a', modelName: '' }), [], '不完整路由不生成半个请求覆盖')
})

const preset = (id) => loadPresetSpec(fileURLToPath(new URL(`../../preset/pt-${id}/`, import.meta.url)))

test('modules: [] 是显式空装配，不再展开默认引擎能力', () => {
  const explicit = resolvePresetModuleFacts(loadPresetSpec(FIXTURE_PRESET_SRC))
  assert.equal(explicit.sourceMode, 'explicit')
  assert.ok(explicit.effectiveModules.includes('filesystem-editor'))
  assert.ok(explicit.rowIds.includes('str-replace-editor'), '嵌套编辑器 row 必须被收集')

  const blank = preset('custom')
  const facts = resolvePresetModuleFacts(blank)
  assert.equal(facts.sourceMode, 'explicit')
  assert.deepEqual(facts.declaredModules, [])
  assert.deepEqual(facts.effectiveModules, [])
  assert.deepEqual(facts.rowIds, [])
  assert.deepEqual(ENGINE_CAPABILITIES.filter((item) => isEngineCapabilityPresent(item.id, facts)), [])
  assert.deepEqual(JSON.parse(renderComposition(blank, {})), [])
})

test('能力事实覆盖本地 filesystem module 与 nested row id', () => {
  // rc.2 官方 minimal 只剩单 shell 工具，编辑能力改由本地 filesystem-editor 提供；
  // 该能力只对显式声明它的预设生效。
  const dir = mkdtempSync(join(tmpdir(), 'pt-filesystem-facts-'))
  try {
    writeFileSync(join(dir, 'preset.yml'), [
      'id: explicit-editor',
      'name: explicit-editor',
      'version: "1"',
      'engineCompat: ">=0"',
      'modules: [filesystem-editor]',
      '',
    ].join('\n'), 'utf8')
    const facts = resolvePresetModuleFacts(loadPresetSpec(dir), dir, true)
    assert.equal(facts.sourceMode, 'explicit')
    assert.ok(facts.effectiveModules.includes('filesystem-editor'))
    assert.equal(facts.editable, true)
    assert.ok(facts.rowIds.includes('fs-local'))
    assert.ok(facts.rowIds.includes('str-replace-editor'))
    assert.equal(isEngineCapabilityPresent('str-replace-editor', facts), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }

  const minimal = resolvePresetModuleFacts(preset('minimal'), fileURLToPath(new URL('../../preset/pt-minimal/', import.meta.url)), true)
  assert.equal(minimal.effectiveModules.includes('filesystem-editor'), false, 'rc.2 minimal 不再装配编辑器能力')
  assert.equal(isEngineCapabilityPresent('str-replace-editor', minimal), false)
})

test('官方 agent.cordis.yml 行只作运行事实，不伪装成可编辑引擎能力', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pt-official-facts-'))
  try {
    // B7 T3：原夹具列的是三个已删本地行；换成官方包行（本仓库无对应 .mjs）。
    writeFileSync(join(dir, 'agent.cordis.yml'), [
      '- id: str-replace-editor',
      '  name: "@deepseek-ai/dsh-tool-str-replace-editor"',
      '- id: tool-web',
      '  name: "@deepseek-ai/dsh-tool-web"',
      '',
    ].join('\n'), 'utf8')
    const facts = resolvePresetModuleFacts({ id: 'official', name: 'official', version: '1', engineCompat: '>=0' }, dir, true)
    assert.equal(facts.sourceMode, 'official')
    assert.equal(facts.editable, false)
    assert.ok(facts.rowIds.includes('str-replace-editor'), '官方行事实仍保留供诊断')
    assert.deepEqual(ENGINE_CAPABILITIES.filter((item) => isEngineCapabilityPresent(item.id, facts)), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('显式模块清单稳定去重', () => {
  const facts = resolvePresetModuleFacts({
    id: 'duplicate', name: 'duplicate', version: '1', engineCompat: '>=0',
    modules: ['tool-git-bash', 'tool-git-bash', 'tool-config-engine'],
  })
  assert.deepEqual(facts.declaredModules, ['tool-git-bash', 'tool-config-engine'])
  assert.deepEqual(facts.effectiveModules, ['tool-git-bash', 'tool-config-engine'])
})

test('params-only 不能伪造模块事实', () => {
  const facts = resolvePresetModuleFacts({
    id: 'params-only', name: 'params-only', version: '1', engineCompat: '>=0', params: { toolGitBashEnabled: false },
  })
  assert.equal(facts.sourceMode, 'unknown')
  assert.equal(facts.effectiveModules, null)
  assert.deepEqual(facts.rowIds, [])
})

test('自定义工具 id/name 重复在写盘前被拒绝', () => {
  assert.deepEqual(validateCustomToolIdentities([
    { id: 'one', name: 'same' },
    { id: 'one', name: 'other' },
    { id: 'two', name: 'same' },
  ]), [
    'customTools[1].id 与 customTools[0] 重复：one',
    'customTools[2].name 与 customTools[0] 重复：same',
  ])
})

// —— 历史策略事实（原 legacy-policy-facts.test.mjs） ——

test('历史策略段：实际运行能力可见，补声明保留授权，移除真正停用', () => {
  const root = mkdtempSync(join(home, 'presets-'))
  const dir = join(root, 'legacy')
  const id = 'subagent-tool-policy'
  const spec = { id: 'legacy', name: 'Legacy', version: '1', engineCompat: '*', modules: ['delegation'],
    subagentToolPolicy: SUBAGENT_TOOL_POLICY_SKELETON }
  try {
    mkdirSync(dir)
    writeFileSync(join(dir, 'preset.yml'), stringify(spec))
    const original = readFileSync(join(dir, 'preset.yml'), 'utf8')
    const facts = resolvePresetModuleFacts(spec, dir, true)
    assert.deepEqual(facts.declaredModules, ['delegation'], '声明事实不伪造模块')
    assert.ok(facts.rowIds.includes(id), '历史段继续装配授权，不静默放宽')
    assert.ok(facts.effectiveModules.includes(id), '实际装配必须体现在模块事实中')
    assert.equal(isEngineCapabilityPresent(id, facts), true, '编辑卡应显示实际生效策略')
    assert.equal(readFileSync(join(dir, 'preset.yml'), 'utf8'), original, '只读事实不改写用户文件')
    assert.deepEqual(createEngineCapabilityInPreset(dir, { action: 'create', capabilityId: id }).addedModules, [id])
    assert.deepEqual(loadPresetSpec(dir).subagentToolPolicy, spec.subagentToolPolicy, '补声明不覆盖已有授权')
    assert.equal(createEngineCapabilityInPreset(dir, { action: 'create', capabilityId: id }).changed, false)
    assert.equal(removeEngineCapabilityFromPreset(dir, id).changed, true)
    const removed = loadPresetSpec(dir)
    assert.equal(removed.subagentToolPolicy, undefined)
    assert.equal(isEngineCapabilityPresent(id, resolvePresetModuleFacts(removed, dir, true)), false)
    assert.doesNotMatch(renderComposition(removed, {}, dir), /id: subagent-tool-policy/)
    const implied = { ...removed, params: { toolGitBashEnabled: false }, moduleConfigs: { 'tool-git-bash': { enabled: false } } }
    assert.equal(isEngineCapabilityPresent('tool-git-bash', resolvePresetModuleFacts(implied, dir, true)), true,
      '参数在 ⇒ 装配在：显式参数/行配置会隐含装配该能力')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// B7 T3：原「子代理页创建 tool-filter」整段随 tool-filter 能力与委派 toolFilter 通道删除而退场
// （能力卡、参数键、`engine/tool-filter.mjs` 均已不存在；子代理工具面改由实例级 subagent-tool-policy 授权，
//  覆盖见 test/engine/declaration-parity-tool-filter.test.mjs 与 test/host/subagent-tool-policy.test.mjs）。
