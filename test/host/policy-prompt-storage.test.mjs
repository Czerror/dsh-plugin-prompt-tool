import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isolatedHome } from '../fixtures/host-harness.mjs'

const { moduleRoot } = isolatedHome('pt-policy-prompt-storage-')
const { readModuleRules, editModuleRules } = await import('../../src/host/module-rules.ts')

/**
 * 模块定义夹具：原内容模块已移出仓库（存档在本地知识库）。本文件只验证替句保存的 CAS 与互斥事务，
 * 所以自带一份最小定义：一条同组替句规则 + 一对互斥旁路规则。
 */
const policyDefinition = ['# USER COMMENT', 'id: policy-fixture', 'name: policy fixture', 'modules: [rule-engine]', 'rules:',
  '  - id: approval-ask-guidance', '    enabled: true', '    then:',
  '      - id: ask', '        kind: assembly', '        target:', '          contexts:', '            replace:',
  '              - name: approval:policy', '                match: ORIGINAL', '                text: REPLACEMENT',
  '  - id: approval-never-guidance', '    enabled: true', '    group: approval-never-guidance', '    exclusive: true', '    then:',
  '      - id: never', '        kind: assembly', '        target:', '          contexts:', '            replace:',
  '              - name: approval:policy', '                match: ORIGINAL', '                text: REPLACEMENT',
  '  - id: approval-never-bypass-guidance', '    enabled: false', '    group: approval-never-guidance', '    exclusive: true', '    then:',
  '      - id: bypass', '        kind: assembly', '        target:', '          contexts:', '            replace:',
  '              - name: approval:policy', '                match: ORIGINAL', '                text: REPLACEMENT', ''].join('\n') + '\n'

test('替句原文沿普通规则版本写盘，非法原文拒写且审批文案复用原互斥事务', () => {
  const dir = join(moduleRoot, 'policy-fixture')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'module.yml')
  writeFileSync(file, policyDefinition)
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

test('工具说明沿原规则CAS保存空替文与参数名，非法匹配拒写保留原定义', () => {
  const dir = join(moduleRoot, 'tool-descriptions')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'module.yml')
  writeFileSync(file, '# USER TOOL COMMENT\nid: tool-descriptions\nname: tools\nmodules: [rule-engine]\nrules: []\n')
  const initial = readModuleRules(dir)
  const rule = { id: 'description', enabled: false, then: [{ id: 'description', kind: 'assembly', target: { toolDescriptions: [
    { name: 'pwsh', parameter: 'sandbox_permissions', match: 'KNOWN ORIGINAL', text: '' },
  ] } }] }
  const saved = editModuleRules(dir, { expectedRevisions: initial.revisions, edits: [{ previousId: null, rule }] })
  assert.deepEqual(readModuleRules(dir).rules.find(entry => entry.id === rule.id), rule)
  const bytes = readFileSync(file, 'utf8')
  assert.match(bytes, /# USER TOOL COMMENT/)
  for (const match of ['', null, 2]) {
    const invalid = structuredClone(rule)
    invalid.then[0].target.toolDescriptions[0].match = match
    assert.throws(() => editModuleRules(dir, { expectedRevisions: saved.revisions, edits: [{ previousId: rule.id, rule: invalid }] }), /toolDescriptions.*match/)
    assert.equal(readFileSync(file, 'utf8'), bytes)
  }
  assert.throws(() => editModuleRules(dir, { expectedRevisions: initial.revisions, edits: [{ previousId: rule.id, rule }] }), error => error.code === 'rules-conflict')
})
