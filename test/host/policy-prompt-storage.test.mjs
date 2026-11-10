import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isolatedHome } from '../fixtures/host-harness.mjs'

const { moduleRoot } = isolatedHome('pt-policy-prompt-storage-')
const { readModuleRules, editModuleRules } = await import('../../src/host/module-rules.ts')

test('替句原文沿普通规则版本写盘，非法原文拒写且审批文案复用原互斥事务', () => {
  const dir = join(moduleRoot, 'limit-breaker')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'module.yml')
  writeFileSync(file, '# USER COMMENT\n' + readFileSync(new URL('../../modules/limit-breaker/module.yml', import.meta.url), 'utf8'))
  const initial = readModuleRules(dir)
  const current = initial.rules.find(rule => rule.id === 'approval-ask-guidance')
  const changed = structuredClone(current)
  changed.then[0].target.contexts.replace[0].match = 'USER ORIGINAL'
  changed.then[0].target.contexts.replace[0].text = 'USER REPLACEMENT'
  let saved = editModuleRules(dir, { expectedRevisions: initial.revisions, edits: [{ previousId: current.id, rule: changed }] })
  assert.deepEqual(readModuleRules(dir).rules.find(rule => rule.id === current.id), changed)
  const bytes = readFileSync(file, 'utf8')
  assert.match(bytes, /# USER COMMENT/)
  for (const match of ['', null, 2]) {
    const invalid = structuredClone(changed)
    invalid.then[0].target.contexts.replace[0].match = match
    assert.throws(() => editModuleRules(dir, { expectedRevisions: saved.revisions, edits: [{ previousId: current.id, rule: invalid }] }), /replace.*match/)
    assert.equal(readFileSync(file, 'utf8'), bytes)
  }
  assert.throws(() => editModuleRules(dir, { expectedRevisions: initial.revisions, edits: [{ previousId: current.id, rule: current }] }), error => error.code === 'rules-conflict')
  for (const id of ['approval-never-guidance', 'approval-never-bypass-guidance']) saved = editModuleRules(dir, {
    expectedRevisions: saved.revisions, activateRuleId: id,
  })
  assert.deepEqual(saved.rules.filter(rule => rule.group === 'approval-never-guidance').map(rule => [rule.id, rule.enabled]), [
    ['approval-never-guidance', false], ['approval-never-bypass-guidance', true],
  ])
})
