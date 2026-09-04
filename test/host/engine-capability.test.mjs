import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parse as parseYaml } from 'yaml'
import { createEngineCapabilityInPreset } from '../../lib/index.mjs'

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
