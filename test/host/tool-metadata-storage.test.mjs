import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isolatedHome } from '../fixtures/host-harness.mjs'

const { moduleRoot } = isolatedHome('pt-tool-metadata-storage-')
const { readModuleRules, editModuleRules } = await import('../../src/host/module-rules.ts')

test('技能说明沿原规则CAS保存，空替文和未知用户数据保留，非法schema路径拒写', () => {
  const dir = join(moduleRoot, 'skill-descriptions')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'module.yml')
  writeFileSync(file, '# USER SKILL COMMENT\nid: skill-descriptions\nname: skills\nmodules: [rule-engine]\nuserMetadata: keep\nrules: []\n')
  const initial = readModuleRules(dir)
  const rule = { id: 'badge-description', enabled: false, then: [{ id: 'description', kind: 'assembly', target: { skillDescriptions: [
    { name: 'dsh-badge', match: 'KNOWN BADGE DESCRIPTION', text: '' },
  ] } }] }
  const saved = editModuleRules(dir, { expectedRevisions: initial.revisions, edits: [{ previousId: null, rule }] })
  assert.deepEqual(readModuleRules(dir).rules.find(entry => entry.id === rule.id), rule)
  const bytes = readFileSync(file, 'utf8')
  assert.match(bytes, /# USER SKILL COMMENT/)
  assert.match(bytes, /userMetadata: keep/)
  const invalid = structuredClone(rule)
  invalid.then[0].target.skillDescriptions[0].parameter = 'content'
  assert.throws(() => editModuleRules(dir, { expectedRevisions: saved.revisions, edits: [{ previousId: rule.id, rule: invalid }] }), /skillDescriptions/)
  assert.equal(readFileSync(file, 'utf8'), bytes)
  assert.throws(() => editModuleRules(dir, { expectedRevisions: initial.revisions, edits: [{ previousId: rule.id, rule }] }), error => error.code === 'rules-conflict')
  assert.equal(readFileSync(file, 'utf8'), bytes)
})
