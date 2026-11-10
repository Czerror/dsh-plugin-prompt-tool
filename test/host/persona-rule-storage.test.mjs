import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { isolatedHome } from '../fixtures/host-harness.mjs'

const { moduleRoot } = isolatedHome('pt-persona-rule-storage-')
const { readModuleRules, editModuleRules } = await import('../../src/host/module-rules.ts')
const { parse } = await import('yaml')
const { readStorageConfig, setModuleEnabled } = await import('../../src/host/config-store.ts')

test('旧人设定义和来源配置明确拒绝，用户文件保持原字节', () => {
  const dir = join(moduleRoot, 'legacy-persona')
  mkdirSync(dir, { recursive: true })
  const definition = join(dir, 'module.yml')
  const original = 'id: legacy-persona\nmodules: []\nrules: []\npersona: { main: { prefix: OLD } }\n'
  writeFileSync(definition, original)
  assert.throws(() => readModuleRules(dir), /persona.*退役.*手工重建/)
  assert.equal(readFileSync(definition, 'utf8'), original)
  const config = join(dirname(moduleRoot), 'config.yml')
  const selection = 'schemaVersion: 3\nenabled: []\npersonaSources: { main: legacy-persona }\n'
  writeFileSync(config, selection)
  assert.throws(() => readStorageConfig(moduleRoot), /personaSources.*退役.*手工重建/)
  assert.throws(() => setModuleEnabled(moduleRoot, 'legacy-persona', true), /personaSources.*退役.*手工重建/)
  assert.equal(readFileSync(config, 'utf8'), selection)
})

test('人设动作通过普通规则事务保存三态，陈旧规则版本拒绝且不改另一条规则', () => {
  const dir = join(moduleRoot, 'rule-persona')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'module.yml')
  const identity = { id: 'identity', then: [{ id: 'persona', kind: 'persona', prefix: '', complete: false, includeRuntimeContext: false }] }
  const peer = { id: 'peer', then: [{ id: 'request', kind: 'request-params', patch: { maxTokens: 12 } }] }
  writeFileSync(file, '# retained\n' + JSON.stringify({ id: 'rule-persona', modules: [], rules: [identity, peer] }))
  const initial = readModuleRules(dir)
  const changed = { ...identity, then: [{ ...identity.then[0], suffix: 'TAIL', stripDefaultIdentity: 'harness' }] }
  const saved = editModuleRules(dir, { expectedRevisions: initial.revisions, edits: [{ previousId: identity.id, rule: changed }] })
  assert.deepEqual(saved.rules, [changed, peer])
  const bytes = readFileSync(file, 'utf8')
  assert.deepEqual(parse(bytes), { id: 'rule-persona', modules: [], rules: [changed, peer], configOrder: { identity: 0, peer: 10 } })
  assert.match(bytes, /# retained/)
  assert.throws(() => editModuleRules(dir, { expectedRevisions: initial.revisions, edits: [{ previousId: identity.id, rule: identity }] }), error => error.code === 'rules-conflict')
  assert.equal(readFileSync(file, 'utf8'), bytes)
  assert.throws(() => editModuleRules(dir, { expectedRevisions: saved.revisions, edits: [{ previousId: identity.id, rule: { ...changed, then: [{ ...changed.then[0], stripDefaultIdentity: 'all' }] } }] }), /stripDefaultIdentity/)
  assert.equal(readFileSync(file, 'utf8'), bytes, '非法身份目标不写完整定义')
  for (const target of [['preset'], ['harness']]) {
    assert.throws(() => editModuleRules(dir, { expectedRevisions: saved.revisions, edits: [{ previousId: identity.id, rule: { ...changed, then: [{ ...changed.then[0], stripDefaultIdentity: target }] } }] }), /stripDefaultIdentity/)
    assert.equal(readFileSync(file, 'utf8'), bytes, '数组目标不得写完整定义')
  }
  for (const instructionsMaxBytes of [0, -1, 1.5, '65536', Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => editModuleRules(dir, { expectedRevisions: saved.revisions, edits: [{ previousId: identity.id, rule: { ...changed, then: [{ ...changed.then[0], instructionsMaxBytes }] } }] }), /instructionsMaxBytes/)
    assert.equal(readFileSync(file, 'utf8'), bytes, '非法预算不写完整定义')
  }
})
