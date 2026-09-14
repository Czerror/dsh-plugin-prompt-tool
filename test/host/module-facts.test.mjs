import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ENGINE_CAPABILITIES,
  isEngineCapabilityPresent,
  loadPresetSpec,
  renderComposition,
  resolvePresetModuleFacts,
  validateCustomToolIdentities,
} from '../../lib/index.mjs'

const preset = (id) => loadPresetSpec(fileURLToPath(new URL(`../../preset/${id}/`, import.meta.url)))

test('modules: [] 是显式空装配，不再展开默认引擎能力', () => {
  const explicit = resolvePresetModuleFacts(preset('anchored'))
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
