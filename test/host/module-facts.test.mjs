import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { loadPresetSpec, resolvePresetModuleFacts, validateCustomToolIdentities } from '../../lib/index.mjs'

const preset = (id) => loadPresetSpec(fileURLToPath(new URL(`../../preset/${id}/`, import.meta.url)))

test('模块事实区分显式 modules 与 modules:[] fallback', () => {
  const explicit = resolvePresetModuleFacts(preset('minimal'))
  assert.equal(explicit.sourceMode, 'explicit')
  assert.ok(explicit.effectiveModules.includes('bootstrap-filesystem'))
  assert.ok(explicit.rowIds.includes('str-replace-editor'), '嵌套编辑器 row 必须被收集')

  const fallback = resolvePresetModuleFacts(preset('custom'))
  assert.equal(fallback.sourceMode, 'fallback')
  assert.deepEqual(fallback.declaredModules, [])
  assert.ok(fallback.effectiveModules.includes('tool-bootstrap'))
})

test('能力事实覆盖 module key 与 nested/alias row id', () => {
  const facts = resolvePresetModuleFacts(preset('minimal'))
  assert.ok(facts.effectiveModules.includes('official-persistent-shell'))
  assert.ok(facts.rowIds.includes('persistent-shell'))
  assert.ok(facts.rowIds.includes('fs-local'))
  assert.ok(facts.rowIds.includes('str-replace-editor'))
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
