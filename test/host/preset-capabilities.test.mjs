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
const { buildEngineModuleParams } = await import('../../src/shared/engine-params.ts')
const { apply: applyToolFilter } = await import('../../engine/tool-filter.mjs')

// —— 能力创建/删除（原 engine-capability.test.mjs） ——

test('能力创建一次写入 modules/初始参数并保持幂等', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pt-engine-capability-'))
  try {
    const file = join(dir, 'preset.yml')
    writeFileSync(file, [
      'id: demo', 'name: demo', 'version: "1"', 'engineCompat: ">=0"',
      'modules: [context-gate]', 'params: { customKeep: true }',
      'moduleConfigs:', '  context-gate:', '    custom: keep', '',
    ].join('\n'), 'utf8')
    const first = createEngineCapabilityInPreset(dir, { action: 'create-recipe', recipeId: 'deliberation' })
    assert.equal(first.changed, true)
    const parsed = parseYaml(readFileSync(file, 'utf8'))
    assert.ok(parsed.modules.includes('deliberation-gate'))
    assert.ok(parsed.modules.includes('progress-reminder'))
    assert.equal(parsed.params.customKeep, true)
    assert.equal(parsed.params.deliberationGate, true)
    const before = readFileSync(file, 'utf8')
    const second = createEngineCapabilityInPreset(dir, { action: 'create-recipe', recipeId: 'deliberation' })
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
    assert.throws(() => createEngineCapabilityInPreset(dir, { action: 'create', capabilityId: 'tool-filter' }))
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
      () => createEngineCapabilityInPreset(dir, { action: 'create', capabilityId: 'tool-filter' }),
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
    const result = createEngineCapabilityInPreset(dir, { action: 'create', capabilityId: 'tool-filter' })
    assert.equal(result.changed, true)
    assert.deepEqual(parseYaml(readFileSync(file, 'utf8')).modules, ['tool-filter'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('删除能力只移除显式模块，保留 dormant 参数与未知字段', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pt-engine-capability-remove-'))
  try {
    const file = join(dir, 'preset.yml')
    writeFileSync(file, [
      'id: demo', 'name: demo', 'version: "1"', 'engineCompat: ">=0"',
      'modules: [context-gate, tool-bootstrap]',
      'params: { bootstrapMaxTokens: 1024, customKeep: true }',
      'moduleConfigs:', '  tool-bootstrap:', '    promoteGate: true',
      'unknown: keep', '',
    ].join('\n'), 'utf8')
    const first = removeEngineCapabilityFromPreset(dir, 'tool-bootstrap')
    assert.deepEqual(first, { changed: true, removedModules: ['tool-bootstrap'], capabilityIds: ['tool-bootstrap'] })
    const parsed = parseYaml(readFileSync(file, 'utf8'))
    assert.deepEqual(parsed.modules, ['context-gate'])
    assert.equal(parsed.params.bootstrapMaxTokens, 1024, '参数保留为 dormant 配置')
    assert.equal(parsed.moduleConfigs['tool-bootstrap'].promoteGate, true, '行配置保留为 dormant 配置')
    assert.equal(parsed.unknown, 'keep')
    assert.equal(removeEngineCapabilityFromPreset(dir, 'tool-bootstrap').changed, false, '重复删除幂等')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('删除最后一项能力后保持显式空组合', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pt-engine-capability-remove-last-'))
  try {
    const file = join(dir, 'preset.yml')
    writeFileSync(file, 'id: blank\nname: blank\nversion: "1"\nengineCompat: ">=0"\nmodules: [tool-filter]\n', 'utf8')
    const result = removeEngineCapabilityFromPreset(dir, 'tool-filter')
    assert.equal(result.changed, true)
    assert.deepEqual(parseYaml(readFileSync(file, 'utf8')).modules, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// —— 模块事实（原 module-facts.test.mjs） ——

const preset = (id) => loadPresetSpec(fileURLToPath(new URL(`../../preset/${id}/`, import.meta.url)))

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

  const minimal = resolvePresetModuleFacts(preset('minimal'), fileURLToPath(new URL('../../preset/minimal/', import.meta.url)), true)
  assert.equal(minimal.effectiveModules.includes('filesystem-editor'), false, 'rc.2 minimal 不再装配编辑器能力')
  assert.equal(isEngineCapabilityPresent('str-replace-editor', minimal), false)
})

test('官方 agent.cordis.yml 行只作运行事实，不伪装成可编辑引擎能力', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pt-official-facts-'))
  try {
    writeFileSync(join(dir, 'agent.cordis.yml'), [
      '- id: tool-bootstrap',
      '  name: ./tool-bootstrap.mjs',
      '- id: context-gate',
      '  name: ./context-gate.mjs',
      '- id: promoted-code-mode',
      '  name: ./promoted-code-mode.mjs',
      '- id: str-replace-editor',
      '  name: "@deepseek-ai/dsh-tool-str-replace-editor"',
      '',
    ].join('\n'), 'utf8')
    const facts = resolvePresetModuleFacts({ id: 'official', name: 'official', version: '1', engineCompat: '>=0' }, dir, true)
    assert.equal(facts.sourceMode, 'official')
    assert.equal(facts.editable, false)
    assert.ok(facts.rowIds.includes('tool-bootstrap'), '官方行事实仍保留供诊断')
    assert.deepEqual(ENGINE_CAPABILITIES.filter((item) => isEngineCapabilityPresent(item.id, facts)), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('显式模块清单稳定去重', () => {
  const facts = resolvePresetModuleFacts({
    id: 'duplicate', name: 'duplicate', version: '1', engineCompat: '>=0',
    modules: ['context-gate', 'context-gate', 'tool-bootstrap'],
  })
  assert.deepEqual(facts.declaredModules, ['context-gate', 'tool-bootstrap'])
  assert.deepEqual(facts.effectiveModules, ['context-gate', 'tool-bootstrap'])
})

test('params-only 不能伪造模块事实', () => {
  const facts = resolvePresetModuleFacts({
    id: 'params-only', name: 'params-only', version: '1', engineCompat: '>=0', params: { cotDrip: true },
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
    const dormant = { ...removed, params: { toolFilterAllow: ['read'] }, moduleConfigs: { 'tool-filter': { enabled: true } } }
    assert.equal(isEngineCapabilityPresent('tool-filter', resolvePresetModuleFacts(dormant, dir, true)), false,
      '其他 dormant 参数不触发隐式能力')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// —— 子代理页创建 tool-filter（原 subagent-creates-tool-filter.test.mjs） ——

const PRESET_ID = 'subfilter-e2e'

/** 独立临时预设根：modules 可编辑（create/remove 都要求显式 modules 数组）。 */
function seedPreset() {
  const root = mkdtempSync(join(tmpdir(), 'pt-subfilter-root-'))
  const dir = join(root, PRESET_ID)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'preset.yml'),
    `id: ${PRESET_ID}\nname: ${PRESET_ID}\nversion: "1"\nengineCompat: ">=0"\nmodules:\n  - tool-fs\n  - delegation\nparams: {}\n`, 'utf8')
  return { root, dir }
}

function makeCtx() {
  const listeners = new Map()
  const ctx = {
    logger: { warn: () => {} },
    on(type, handler, opts) {
      const list = listeners.get(type) ?? []
      list.push({ handler, opts })
      listeners.set(type, list)
    },
  }
  ctx.listeners = listeners
  return ctx
}

const tool = (name) => ({ name, description: `tool ${name}` })
const assembled = (tools) => ({ sections: [], contexts: [], tools, variables: {} })

/** 跑一次 system-prompt/assemble 瀑布（模拟主会话或子代理）。 */
async function runAssemble(ctx, delegationDepth, tools) {
  const handler = ctx.listeners.get('system-prompt/assemble')?.[0]?.handler
  assert.ok(handler, 'tool-filter 应注册 assemble 监听器')
  const agent = { session: { id: `s-${delegationDepth}`, header: { delegationDepth } } }
  return handler(assembled(tools), { agent }, async () => assembled(tools))
}

test('子代理页创建 tool-filter：预设级落盘 + 组合行 + 参数桥只写主对话语义', async () => {
  const { root, dir } = seedPreset()
  try {
    // 1) 创建能力（等价于 UI 点「添加能力 → tool-filter」）。
    const created = createEngineCapabilityInPreset(dir, { action: 'create', capabilityId: 'tool-filter' })
    assert.equal(created.changed, true)
    assert.deepEqual(created.addedModules, ['tool-filter'])
    assert.ok(loadPresetSpec(dir).modules.includes('tool-filter'), '写入激活预设 modules（预设级，无作用域参数）')

    // 2) 参数桥：用户在卡片里配的白/黑名单只产生主对话语义的键。
    const configs = buildEngineModuleParams({ toolFilterAllow: ['read'], toolFilterDeny: ['bash'] })
    assert.deepEqual(configs['tool-filter'], { allow: ['read'], deny: ['bash'] })
    assert.equal(configs['tool-filter'].includeSubagents, undefined, '不存在写 includeSubagents 的 UI 路径')

    // 3) 组合行与参数桥一致。
    const row = parseYaml(renderComposition(loadPresetSpec(dir), { toolFilterAllow: ['read'], toolFilterDeny: ['bash'] }, root))
      .find((item) => item?.id === 'tool-filter')
    assert.deepEqual(row.config, { allow: ['read'], deny: ['bash'] })

    // 4) 引擎实测：主对话被过滤，子代理保持完整目录。
    const mainCtx = makeCtx()
    applyToolFilter(mainCtx, row.config)
    const main = await runAssemble(mainCtx, 0, [tool('bash'), tool('read'), tool('write')])
    assert.deepEqual(main.tools.map((item) => item.name), ['read'], '主对话只留白名单内工具')

    const subCtx = makeCtx()
    applyToolFilter(subCtx, row.config)
    const sub = await runAssemble(subCtx, 1, [tool('bash'), tool('read'), tool('write')])
    assert.deepEqual(sub.tools.map((item) => item.name), ['bash', 'read', 'write'], '子代理完全不受这条过滤影响')

    // 5) 总开关关闭时不注册监听器（整条链失效）。
    const offCtx = makeCtx()
    applyToolFilter(offCtx, { allow: ['read'], enabled: false })
    assert.equal(offCtx.listeners.get('system-prompt/assemble'), undefined, 'enabled=false 不注册监听器')

    // 6) 兼容路径：显式 moduleConfigs 直写 includeSubagents 仍可让子代理继承（非 UI 路径）。
    const directCtx = makeCtx()
    applyToolFilter(directCtx, { allow: ['read'], includeSubagents: true })
    const inherited = await runAssemble(directCtx, 1, [tool('bash'), tool('read')])
    assert.deepEqual(inherited.tools.map((item) => item.name), ['read'], '显式直写才让子代理继承')

    // 7) 创建/删除对称：移除能力后组合不再出现过滤行。
    const removed = removeEngineCapabilityFromPreset(dir, 'tool-filter')
    assert.equal(removed.changed, true)
    assert.deepEqual(removed.removedModules, ['tool-filter'])
    const rows = parseYaml(renderComposition(loadPresetSpec(dir), {}, root))
    assert.equal(rows.find((item) => item?.id === 'tool-filter'), undefined)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
