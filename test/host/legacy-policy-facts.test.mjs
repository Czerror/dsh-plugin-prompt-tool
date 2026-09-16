import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stringify } from 'yaml'
import { isEngineCapabilityPresent, SUBAGENT_TOOL_POLICY_SKELETON } from '../../src/shared/engine-capabilities.ts'

const home = mkdtempSync(join(tmpdir(), 'pt-legacy-home-'))
process.env.DSH_HOME = home
const { createEngineCapabilityInPreset, loadPresetSpec, removeEngineCapabilityFromPreset, renderComposition, resolvePresetModuleFacts } = await import('../../src/host/manifest.ts')
test.after(() => rmSync(home, { recursive: true, force: true }))

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
