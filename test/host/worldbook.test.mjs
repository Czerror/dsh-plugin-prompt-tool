import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse, stringify } from 'yaml'

test('世界书更新与删除只修改目标注入动作，保留同卡条件、兄弟动作、排序和未知模块字段', async t => {
  const home = mkdtempSync(join(process.cwd(), 'pt-worldbook-rules-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(() => { if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous; rmSync(home, { recursive: true, force: true }) })
  const { listWorldBookEntries, upsertWorldBookEntry, deleteWorldBookEntry } = await import('../../src/host/worldbook.ts')
  const directory = join(home, 'modules', 'target'), file = join(directory, 'module.yml')
  mkdirSync(directory, { recursive: true })
  const content = { id: 'lore', name: 'Castle', layer: 'pre-step', strategy: 'world-book', position: 'before-all', order: 100, text: 'OLD LORE', params: { constant: true } }
  const sibling = { id: 'request', kind: 'request-params', patch: { maxTokens: 512 }, modelScope: 'all' }
  const when = { text: { subject: 'userMessage', keys: ['castle'] } }
  const definition = { id: 'target', name: 'Target', modules: [], rules: [{ id: 'lore-and-request', name: 'Mixed actions', layer: 'pre-step', enabled: true, if: when, then: [{ id: 'book', kind: 'inject-text', config: content }, sibling] }], configOrder: { 'lore-and-request': 40 }, customFuture: { keep: 'module-owned' } }
  writeFileSync(file, '# KEEP MODULE COMMENT\n' + stringify(definition))
  assert.deepEqual(listWorldBookEntries(directory).map(entry => [entry.id, entry.text, entry.enabled]), [['lore', 'OLD LORE', true]])

  assert.equal(upsertWorldBookEntry(directory, { ...content, text: 'UPDATED LORE' }), 1)
  const updated = parse(readFileSync(file, 'utf8'))
  assert.equal(updated.rules.length, 1)
  assert.equal(updated.rules[0].id, 'lore-and-request')
  assert.deepEqual(updated.rules[0].if, when)
  assert.deepEqual(updated.rules[0].then[1], sibling)
  assert.deepEqual(updated.rules[0].then[0], { id: 'book', kind: 'inject-text', config: { ...content, text: 'UPDATED LORE' } })
  assert.deepEqual(updated.configOrder, { 'lore-and-request': 40 })
  assert.deepEqual(updated.customFuture, { keep: 'module-owned' })
  assert.match(readFileSync(file, 'utf8'), /KEEP MODULE COMMENT/)
  assert.equal(updated.promptConfigs, undefined)
  assert.equal(updated.triggers, undefined)

  assert.equal(deleteWorldBookEntry(directory, 'lore'), 0)
  const remaining = parse(readFileSync(file, 'utf8'))
  assert.deepEqual(remaining.rules, [{ ...definition.rules[0], then: [sibling] }])
  assert.deepEqual(remaining.configOrder, { 'lore-and-request': 40 })
  assert.deepEqual(listWorldBookEntries(directory), [])
  const beforeRejectedDelete = readFileSync(file, 'utf8')
  assert.throws(() => deleteWorldBookEntry(directory, 'lore'), /不存在/)
  assert.equal(readFileSync(file, 'utf8'), beforeRejectedDelete)
})
