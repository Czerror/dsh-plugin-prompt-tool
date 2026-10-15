/**
 * `readModuleFacts` 的直测：模块事实读取的唯一入口。
 *
 * 断言停在入口自己的 interface 上（id 与绝对目录两种 `target` 形态、`editable` 的目录判据、
 * 定义不可解析时抛出），不经过 `/meta`、`/describe` 或装配等远端路径——那是另一个 seam 的面。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isolatedHome, fixtureRule } from '../fixtures/host-harness.mjs'

const { moduleRoot } = isolatedHome('pt-module-facts-')
const { packageModulesDir, readModuleFacts } = await import('../../src/host/manifest.ts')

/** 用户模块：在隔离的模块根下写一份最小定义（与 `userModulesDir()` 同根）。 */
function userModule(id, rules = []) {
  const dir = join(moduleRoot, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'module.yml'), JSON.stringify({ id, modules: ['rule-engine'], rules }))
  return dir
}

test('readModuleFacts：id 与绝对目录两种形态读到同一份事实，用户根内 editable 为真', () => {
  const dir = userModule('alpha', [fixtureRule({ id: 'card', text: 'A' })])
  const byId = readModuleFacts('alpha')
  const byDir = readModuleFacts(dir)
  assert.deepEqual(byId, byDir, '两种 target 形态同源')
  assert.equal(byId.editable, true, '用户模块根之下＝目录可写')
  assert.equal(byId.sourceMode, 'explicit')
  assert.equal(byId.effectiveModules?.includes('rule-engine'), true, '声明的模块如实进入装配集合')
})

test('readModuleFacts：包内模板目录可读但 editable 为假（system 目录只读）', () => {
  const facts = readModuleFacts(join(packageModulesDir(), 'ponytail'))
  assert.equal(facts.editable, false, '包内目录不在用户模块根下')
  assert.equal(facts.sourceMode, 'explicit')
  assert.equal(facts.effectiveModules?.includes('ponytail') !== undefined, true)
})

test('readModuleFacts：定义不可解析时抛出，入口不做软失败', () => {
  const dir = join(moduleRoot, 'broken')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'module.yml'), 'rules: [')
  assert.throws(() => readModuleFacts('broken'), Error, '损坏模块由调用方决定软硬，入口不吞')
})
