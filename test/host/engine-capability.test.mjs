import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parse as parseYaml } from 'yaml'
import { createEngineCapabilityInPreset, removeEngineCapabilityFromPreset } from '../../lib/index.mjs'

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
    assert.ok(parsed.modules.includes('cot-drip'))
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
    writeFileSync(file, 'id: nested\nname: nested\nversion: "1"\nengineCompat: ">=0"\nmodules: [bootstrap-filesystem]\n', 'utf8')
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

test('删除编辑器能力移除 bootstrap-filesystem 组合', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pt-engine-capability-remove-editor-'))
  try {
    const file = join(dir, 'preset.yml')
    writeFileSync(file, 'id: remove-editor\nname: remove-editor\nversion: "1"\nengineCompat: ">=0"\nmodules: [bootstrap-filesystem, prompt-config-engine]\n', 'utf8')
    const result = removeEngineCapabilityFromPreset(dir, 'str-replace-editor')
    assert.deepEqual(result, { changed: true, removedModules: ['bootstrap-filesystem'], capabilityIds: ['str-replace-editor'] })
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
