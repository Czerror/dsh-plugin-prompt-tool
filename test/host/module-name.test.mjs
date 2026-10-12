import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { isolatedHome } from '../fixtures/host-harness.mjs'

const { moduleRoot } = isolatedHome('pt-module-name-')
const { readModuleName, writeModuleName, ModuleNameError } = await import('../../src/host/module-name.ts')

function fixture(id) {
  const dir = join(moduleRoot, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'module.yml'), `# keep this note\nid: ${id}\nname: Old Name\nunknown: keep\nmodules: []\nrules: []\n`)
  return dir
}

test('模块名称读写保留未知字段并只改变 name', () => {
  const dir = fixture('blank')
  const before = readModuleName(dir)
  assert.equal(before.name, 'Old Name')
  const saved = writeModuleName(dir, { name: 'New Name', expectedRevision: before.revision, expectedModuleId: 'blank' })
  const source = parse(readFileSync(join(dir, 'module.yml'), 'utf8'))
  assert.equal(saved.name, 'New Name')
  assert.equal(source.id, 'blank')
  assert.equal(source.unknown, 'keep')
  assert.deepEqual(source.rules, [])
  assert.match(readFileSync(join(dir, 'module.yml'), 'utf8'), /# keep this note/)
  assert.deepEqual(parse(readFileSync(join(dir, 'module.yml'), 'utf8')), { id: 'blank', name: 'New Name', unknown: 'keep', modules: [], rules: [] })
  assert.equal(writeModuleName(dir, { name: 'New Name', expectedRevision: saved.revision, expectedModuleId: 'blank' }).revision, saved.revision, '同名保存不改变定义版本')
})

test('模块名称拒绝过期版本、身份不一致和非法名称', () => {
  const dir = fixture('rejected')
  const current = readModuleName(dir)
  const before = readFileSync(join(dir, 'module.yml'), 'utf8')
  assert.throws(() => writeModuleName(dir, { name: 'Stale', expectedRevision: '0'.repeat(64), expectedModuleId: 'rejected' }), (error) => error instanceof ModuleNameError && error.code === 'module-name-conflict' && error.status === 409)
  assert.throws(() => writeModuleName(dir, { name: 'Wrong id', expectedRevision: current.revision, expectedModuleId: 'other' }), (error) => error instanceof ModuleNameError && error.code === 'module-subject-conflict')
  for (const name of [' ', 'a'.repeat(129), 42]) {
    assert.throws(() => writeModuleName(dir, { name, expectedRevision: current.revision, expectedModuleId: 'rejected' }), ModuleNameError)
  }
  assert.equal(readFileSync(join(dir, 'module.yml'), 'utf8'), before)
  assert.deepEqual(readdirSync(dir), ['module.yml'], '拒绝请求不物化切片或写其他文件')
})
