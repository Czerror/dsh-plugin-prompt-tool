import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parse } from 'yaml'
import { previewSoulUpgrade } from '../../src/host/soul-upgrade.ts'
import { readSoulUpgradePreview } from '../../src/host/soul-upgrade.ts'
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isolatedHome } from '../fixtures/host-harness.mjs'
import { registerModuleImportTools } from '../../src/runtime/module-import-tools.ts'
const { moduleRoot } = isolatedHome('pt-soul-upgrade-')

const baseline = `id: soul
variables: { ledger_open: '0', ledger_seq: '0', plan_step: '' }
rules:
  - id: soul-ledger-open
    enabled: true
    if: { variable: { key: ledger_open, op: gt, value: '0' } }
    then: [{ id: inject, kind: inject-text, config: { order: 126, text: 旧收口文案 } }]
  - id: soul-check
    enabled: true
    if: { manifest: { ok: false } }
    then: [{ id: inject, kind: inject-text, config: { order: 247, text: 旧检查文案 } }]
`
const seed = baseline.replace("variables: { ledger_open: '0', ledger_seq: '0', plan_step: '' }", "variables: { plan_step: '' }").replace("if: { variable: { key: ledger_open, op: gt, value: '0' } }", 'if: { soul: { pending: true } }').replace('旧收口文案', '新完整收口文案').replace('旧检查文案', '新完整检查文案')

test('Soul升级只预览完整目标规则，保留用户启停顺序活变量未知字段与注释', () => {
  const source = '# 用户注释\n' + baseline.replace("plan_step: ''", 'plan_step: 正在执行').replace('enabled: true', 'enabled: false\n    userExtension: KEEP').replace('order: 126', 'order: 999') + 'custom: KEEP\n'
  const result = previewSoulUpgrade(source, baseline, seed)
  assert.equal(result.status, 'ready')
  assert.deepEqual(result.conflicts, [])
  assert.equal(result.changes.length, 4)
  const value = parse(result.candidate)
  assert.deepEqual(value.variables, { plan_step: '正在执行' })
  assert.equal(value.rules[0].enabled, false)
  assert.equal(value.rules[0].then[0].config.order, 999)
  assert.equal(value.rules[0].then[0].config.text, '新完整收口文案')
  assert.equal(value.rules[0].userExtension, 'KEEP')
  assert.equal(value.custom, 'KEEP')
  assert.ok(result.candidate.startsWith('# 用户注释\n'))
  assert.equal(previewSoulUpgrade(result.candidate, baseline, seed).changes.length, 0)
})

test('Soul升级拒绝用户规则行为更改和外部旧变量引用，不生成半份候选', () => {
  for (const source of [baseline.replace('旧收口文案', '用户改过的纪律'), baseline + 'custom: "{{ledger_seq}}"\n', baseline + 'another: { variable: { key: ledger_open } }\n']) {
    const result = previewSoulUpgrade(source, baseline, seed)
    assert.equal(result.status, 'conflict')
    assert.equal(result.candidate, null)
    assert.ok(result.conflicts.length)
  }
  assert.throws(() => previewSoulUpgrade('rules: [', baseline, seed), /YAML/)
})

test('Soul升级保留目标内部注释和未知配置，并拒绝同rules或跨字段共享alias', () => {
  const source = baseline.replace('text: 旧收口文案', 'text: 旧收口文案, extension: KEEP').replace('    if: { variable:', '    # 条件注释\n    if: { variable:').replace('    then: [{ id: inject', '    # 动作注释\n    then: [{ id: inject')
  const result = previewSoulUpgrade(source, baseline, seed)
  assert.equal(result.status, 'ready')
  assert.match(result.candidate, /条件注释/)
  assert.match(result.candidate, /动作注释/)
  assert.equal(parse(result.candidate).rules[0].then[0].config.extension, 'KEEP')
  const internal = baseline.replace('    then: [{ id: inject, kind: inject-text, config: { order: 126, text: 旧收口文案 } }]', '    then:\n      - id: inject\n        kind: inject-text\n        config:\n          # 配置内部注释\n          order: 126\n          text: 旧收口文案 # 标量注释')
  const kept = previewSoulUpgrade(internal, baseline, seed)
  assert.match(kept.candidate, /配置内部注释/)
  assert.match(kept.candidate, /标量注释/)
  const aliasedConfig = baseline + 'moduleConfigs:\n  retrieval: &retrieval { enabled: true }\ncustomConfig: *retrieval\n'
  const configuredSeed = seed + 'moduleConfigs:\n  retrieval: { synonymsFile: assets/terms.json }\n'
  assert.throws(() => previewSoulUpgrade(aliasedConfig, baseline, configuredSeed), /共享引用/)
  for (const suffix of ['custom: *shared\n', '  - id: unrelated\n    then: *shared\n']) {
    const alias = baseline.replace('    then: [{ id: inject', '    then: &shared [{ id: inject') + suffix
    assert.throws(() => previewSoulUpgrade(alias, baseline, seed), /共享引用/)
  }
})

test('Soul真实种子升级提供内容版本与正式导入说明且不写盘', async t => {
  const dir = join(moduleRoot, 'soul')
  mkdirSync(dir, { recursive: true })
  const original = readFileSync(new URL('../fixtures/soul-legacy-module.yml', import.meta.url), 'utf8')
  writeFileSync(join(dir, 'module.yml'), original)
  cpSync(new URL('../../modules/soul/assets', import.meta.url), join(dir, 'assets'), { recursive: true })
  mkdirSync(join(dir, 'data'), { recursive: true })
  writeFileSync(join(dir, 'data/private.txt'), 'PRIVATE LEDGER')
  writeFileSync(join(dir, 'assets/custom.bin'), Buffer.from([0, 255, 128]))
  writeFileSync(join(dir, 'memory.md'), 'PRIVATE MEMORY')
  mkdirSync(join(dir, 'skills'), { recursive: true })
  writeFileSync(join(dir, 'skills/owned.md'), 'PRIVATE SKILL')
  const result = await readSoulUpgradePreview(dir)
  assert.equal(result.status, 'ready')
  assert.equal(typeof result.expectedRevision, 'string')
  assert.match(result.apply, /module_import/)
  assert.equal(readFileSync(join(dir, 'module.yml'), 'utf8'), original)
  assert.ok(result.files.some(file => file.path === 'assets/custom.bin'))
  const candidate = parse(result.candidate)
  assert.equal(candidate.moduleConfigs.retrieval.synonymsFile, 'assets/retrieval-synonyms.json')
  assert.deepEqual(candidate.moduleConfigs['soul-maintenance'].pressureThresholds, [0.45, 0.6, 0.8])
  assert.equal(candidate.moduleConfigs['generation-recovery'].maxCycleChars, 512)
  const tools = new Map()
  let rebuilt = 0
  const ctx = { tools: { register: tool => { tools.set(tool.name, tool); return () => tools.delete(tool.name) } }, inject: (_deps, callback) => ({ dispose: callback(ctx) }) }
  const off = registerModuleImportTools(ctx, { root: moduleRoot, rebuild: async id => { assert.equal(id, 'soul'); rebuilt++ } })
  t.after(off)
  const execute = args => tools.get('module_import').execute(args, { signal: new AbortController().signal })
  const request = { files: result.files, targetId: 'soul', overwrite: true }
  const preview = await execute(request)
  await execute({ ...request, preview: false, expectedSourceDigest: preview.sourceDigest, expectedPreviewRevision: preview.previewRevision })
  assert.equal(rebuilt, 1)
  assert.equal(readFileSync(join(dir, 'data/private.txt'), 'utf8'), 'PRIVATE LEDGER')
  assert.equal(readFileSync(join(dir, 'memory.md'), 'utf8'), 'PRIVATE MEMORY')
  assert.equal(readFileSync(join(dir, 'skills/owned.md'), 'utf8'), 'PRIVATE SKILL')
  assert.deepEqual(readFileSync(join(dir, 'assets/custom.bin')), Buffer.from([0, 255, 128]))
  assert.equal((await readSoulUpgradePreview(dir)).changes.length, 0)
  const upgraded = readFileSync(join(dir, 'module.yml'), 'utf8')
  writeFileSync(join(dir, 'assets/retrieval-synonyms.json'), '[["用户","自己的词表"]]')
  const words = await readSoulUpgradePreview(dir)
  assert.equal(words.status, 'conflict')
  assert.equal(words.candidate, null)
  assert.ok(words.conflicts.some(conflict => conflict.includes('近义表')))
  cpSync(new URL('../../modules/soul/assets/retrieval-synonyms.json', import.meta.url), join(dir, 'assets/retrieval-synonyms.json'))
  const customized = readFileSync(join(dir, 'module.yml'), 'utf8').replace('maxCycleChars: 512', 'maxCycleChars: 257')
  writeFileSync(join(dir, 'module.yml'), customized)
  assert.equal((await readSoulUpgradePreview(dir)).status, 'conflict')
  writeFileSync(join(dir, 'module.yml'), original.replace('    if:\n      manifest:\n        ok: false', '    if: { variable: { key: check_failed, op: eq, value: yes } }'))
  const check = await readSoulUpgradePreview(dir)
  assert.equal(check.status, 'conflict')
  assert.ok(check.conflicts.some(conflict => conflict.startsWith('soul-check:')))
  assert.ok(upgraded.includes('pressureThresholds'))
})
