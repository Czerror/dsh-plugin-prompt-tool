import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { isolatedHome } from '../fixtures/host-harness.mjs'

const { moduleRoot } = isolatedHome('pt-module-rules-')
const { readModuleRules, editModuleRules } = await import('../../src/host/module-rules.ts')
const { loadModuleSpec, resolveModuleFacts } = await import('../../src/host/manifest.ts')
const rule = (id, extra = {}) => ({ id, layer: 'agent-request', do: [{ id: 'request', kind: 'request-params', patch: { maxTokens: 512 } }], ...extra })
function fixture(id, rules) {
  const dir = join(moduleRoot, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'module.yml'), '# user comment\n' + JSON.stringify({ id, modules: [], unknown: { keep: true }, rules, configOrder: Object.fromEntries(rules.map((item, i) => [item.id, i * 10])) }))
  return dir
}

test('规则局部事务：改名和删除同步序号，显式启用原子关闭同组，保留其他定义', () => {
  const dir = fixture('edit', [rule('a', { group: 'g', exclusive: true }), rule('b', { group: 'g', enabled: false }), rule('c')])
  writeFileSync(join(dir, 'module.yml'), [
    '# user comment', 'id: edit', 'modules: []', 'unknown: { keep: true }',
    'rules:',
    '  - id: a', '    group: g', '    exclusive: true', '    do:',
    '      - { id: request, kind: request-params, patch: { maxTokens: 512 } }',
    '  - id: b # identity comment', '    name: Before # name comment', '    group: g', '    enabled: false',
    '    do:', '      - id: request # action comment', '        kind: request-params', '        patch:', '          maxTokens: 512 # value comment',
    '  - id: c', '    do:', '      - { id: request, kind: request-params, patch: { maxTokens: 512 } }',
    'configOrder:', '  a: 0', '  b: 10 # order comment', '  c: 20', '',
  ].join('\n'))
  const initial = readModuleRules(dir)
  const updated = editModuleRules(dir, { expectedRevision: initial.revision, edits: [{ previousId: 'b', rule: { ...initial.rules[1], id: 'renamed', name: 'After' } }, { previousId: 'c', rule: null }], activateRuleId: 'renamed' })
  assert.deepEqual(updated.rules.map(item => [item.id, item.enabled]), [['a', false], ['renamed', true]])
  const text = readFileSync(join(dir, 'module.yml'), 'utf8')
  const data = parse(text)
  assert.deepEqual(data.configOrder, { a: 0, renamed: 10 })
  assert.deepEqual(data.unknown, { keep: true })
  assert.match(text, /# user comment/)
  for (const comment of ['identity comment', 'name comment', 'action comment', 'value comment', 'order comment']) assert.ok(text.includes('# ' + comment), `改名保留 ${comment}`)
  assert.equal(Object.hasOwn(data, 'promptConfigs'), false)
  assert.ok(resolveModuleFacts(loadModuleSpec(dir), dir).effectiveModules.includes('rule-engine'), '模块事实如实报告规则的隐式执行入口')
  assert.notEqual(updated.revision, initial.revision)
})

test('规则拒绝：版本过期、重复身份、坏动作与未显式解决的互斥均不写盘', () => {
  const dir = fixture('reject', [rule('a', { group: 'g', exclusive: true }), rule('b', { group: 'g', enabled: false })])
  const initial = readModuleRules(dir)
  const before = readFileSync(join(dir, 'module.yml'), 'utf8')
  for (const request of [
    { expectedRevision: '0'.repeat(64), edits: [] },
    { edits: [{ previousId: null, rule: rule('a') }] },
    { edits: [{ previousId: 'a', rule: { ...rule('a'), do: [{ id: 'broken', kind: 'missing' }] } }] },
    { edits: [{ previousId: 'b', rule: rule('b', { group: 'g', enabled: true }) }] },
    { edits: [{ previousId: 'missing', rule: null }] },
  ]) assert.throws(() => editModuleRules(dir, { expectedRevision: initial.revision, ...request }))
  assert.equal(readFileSync(join(dir, 'module.yml'), 'utf8'), before)
  const file = join(dir, 'module.yml')
  writeFileSync(file, JSON.stringify({ id: 'reject', modules: [], rules: [null] }))
  assert.throws(() => readModuleRules(dir), error => error.status === 400 && error.code === 'rules-invalid', '坏结构在读取面明确拒绝')
  const future = { id: 'future', when: { futurePredicate: { custom: true } }, do: [{ id: 'future-action', kind: 'future-kind', opaque: { custom: true } }] }
  writeFileSync(file, JSON.stringify({ id: 'reject', modules: [], rules: [future] }))
  assert.deepEqual(readModuleRules(dir).rules, [future], '未知语义保持原样，供JSON修复而非静默删掉')
  const aliased = 'id: reject\nmodules: []\nrules:\n  - id: a\n    name: &shared Before\n    do:\n      - { id: request, kind: request-params, patch: { maxTokens: 512 } }\nunknown: *shared\n'
  writeFileSync(file, aliased)
  const aliasSnapshot = readModuleRules(dir)
  for (const validateOnly of [true, false]) assert.throws(() => editModuleRules(dir, { expectedRevision: aliasSnapshot.revision, validateOnly, edits: [{ previousId: 'a', rule: { ...aliasSnapshot.rules[0], name: 'After' } }] }), /YAML.*引用/, '共享别名不允许局部编辑改变其他定义')
  assert.equal(readFileSync(file, 'utf8'), aliased, '别名拒绝保持原文件字节')
})

test('规则边界：仅校验与无改动幂等，旧来源显式要求离线迁移', () => {
  const dir = fixture('check', [rule('a')])
  const initial = readModuleRules(dir)
  const before = readFileSync(join(dir, 'module.yml'), 'utf8')
  const checked = editModuleRules(dir, { expectedRevision: initial.revision, edits: [{ previousId: null, rule: rule('b') }], validateOnly: true })
  assert.equal(checked.rules.length, 2)
  assert.equal(checked.revision, initial.revision)
  assert.deepEqual(editModuleRules(dir, { expectedRevision: initial.revision, edits: [] }), initial)
  assert.equal(readFileSync(join(dir, 'module.yml'), 'utf8'), before)
  writeFileSync(join(dir, 'module.yml'), 'id: check\nmodules: []\npromptConfigs: []\n')
  assert.throws(() => readModuleRules(dir), error => error.code === 'rules-migration-required')
  writeFileSync(join(dir, 'module.yml'), 'id: check\nmodules: []\nrules: []\nlayerSettings:\n  agent-request:\n    modelTemperature: 0.5\n')
  assert.throws(() => readModuleRules(dir), error => error.code === 'rules-migration-required', '规则表存在也不能藏旧模型参数')
})
