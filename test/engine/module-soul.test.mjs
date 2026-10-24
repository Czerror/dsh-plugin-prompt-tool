import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { compileRules } from '../../engine/rule-spec.mjs'
import { rulePromptConfigOptions } from '../../src/host/module-slices.ts'
import { runModuleManifest } from '../../src/host/module-manifest.ts'
import { MODULE_TOOL_CAPABILITIES, MODULE_TOOL_NAMES } from '../../src/shared/engine-capabilities.ts'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const moduleDir = join(repoRoot, 'modules', 'soul')
const spec = parse(readFileSync(join(moduleDir, 'module.yml'), 'utf8'))

test('soul 模块：规则编译、模板存在与变量声明', () => {
  const rules = compileRules(spec.rules, {
    moduleId: 'soul', variables: spec.variables, variablesEnabled: spec.variablesEnabled,
    promptConfigOptions: rulePromptConfigOptions(moduleDir),
  })
  assert.deepEqual(rules.map(rule => rule.id).sort(), [
    'soul-check', 'soul-core', 'soul-core-sub', 'soul-echo', 'soul-layers', 'soul-ledger',
    'soul-ledger-open', 'soul-plan', 'soul-post-compaction', 'soul-scaffold', 'soul-tick', 'soul-vital',
  ])
  for (const file of ['criteria.md', 'core-hard.md', 'layers.md', 'echo.md', 'vital.md', 'ledger.md']) {
    assert.ok(readFileSync(join(moduleDir, 'assets', file), 'utf8').length > 0)
  }
  assert.ok(Object.values(spec.variables).every(value => typeof value === 'string'))
  for (const name of ['module-file-tools', 'module-manifest-tools', 'module-variable-tools']) {
    assert.ok(spec.modules.includes(name), name)
    assert.ok(existsSync(join(repoRoot, 'engine', 'compositions', 'source', 'local', name + '.yml')), `组合行 ${name}`)
  }
  assert.equal(MODULE_TOOL_CAPABILITIES[MODULE_TOOL_NAMES.manifest], 'module-manifest-tools')
  assert.equal(MODULE_TOOL_CAPABILITIES[MODULE_TOOL_NAMES.fileRead], 'module-file-tools')
})

test('soul 模块：manifest 的 next/check 只读，不建目录', () => {
  const next = runModuleManifest(moduleDir, 'next')
  assert.equal(next.ok, false)
  assert.deepEqual(next.entries, [{ kind: 'dir', path: 'data/10-宪章' }])
  const checked = runModuleManifest(moduleDir, 'check')
  assert.equal(checked.ok, false)
  assert.equal(checked.entries[0].path, 'data/02-墨.jsonl')
  assert.equal(checked.entries[0].error, '文件不存在')
})
