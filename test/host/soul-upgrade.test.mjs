import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parse } from 'yaml'
import { previewSoulUpgrade } from '../../src/host/soul-upgrade.ts'

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

