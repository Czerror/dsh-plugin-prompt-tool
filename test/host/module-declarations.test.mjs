/**
 * 声明面真值源：`module.yml` 的**顶层键存在性**。
 *
 * 真值源：`docs/superpowers/specs/2026-10-12-module-subject-design.md` §7.4／ADR-0014
 * ——键整个不存在＝没声明（`customTools: []` 算已声明）；解析失败是错误，
 * 不得降级成「没声明」（那会让损坏的定义变成静默可用）。
 * 断言落在公共接口（`moduleDeclarations` / 登记表）上；`declares` 只是测试本地别名。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isolatedHome } from '../fixtures/host-harness.mjs'

const { moduleRoot } = isolatedHome('pt-module-declarations-')
const { moduleDeclarations } =
  await import('../../src/host/module-declarations.ts')
/** 声明面判据只在 moduleDeclarations；这里保留测试可读的本地别名。 */
const declares = (dir, section) => moduleDeclarations(dir).has(section)
const { ModuleWriteError } = await import('../../src/host/module-write.ts')

function writeModule(id, body) {
  const dir = join(moduleRoot, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'module.yml'), `id: ${id}\n${body}`, 'utf8')
  return dir
}

test('顶层键整个不存在才算没声明；空值键算已声明', () => {
  const onlyRules = writeModule('declares-rules', 'modules: []\nrules: []\n')
  const emptyCustomTools = writeModule('declares-custom-tools', 'modules: []\ncustomTools: []\n')

  assert.deepEqual([...moduleDeclarations(onlyRules)].sort(), ['id', 'modules', 'rules'])
  assert.equal(declares(onlyRules, 'rules'), true)
  assert.equal(declares(onlyRules, 'customTools'), false, '键整个不存在＝没声明')

  assert.equal(declares(emptyCustomTools, 'customTools'), true, 'customTools: [] 算已声明')
  assert.equal(declares(emptyCustomTools, 'rules'), false, '没写的节照旧判没声明')
})

test('非法 YAML 抛既有错误，不返回空声明集', () => {
  const broken = writeModule('declares-broken', 'rules: [unclosed\n')
  assert.throws(() => moduleDeclarations(broken), (error) => {
    assert.ok(error instanceof ModuleWriteError, `既有错误类型，实际 ${error?.name}`)
    assert.equal(error.code, 'rules-invalid', '用定义校验那条链的既有错误码')
    return true
  }, '解析失败必须是错误，不能当成「没声明」')
})
