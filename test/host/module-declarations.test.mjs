/**
 * 声明面真值源：`module.yml` 的**顶层键存在性**。
 *
 * 真值源：`docs/superpowers/specs/2026-10-12-module-subject-design.md` §7.4／ADR-0014
 * ——键整个不存在＝没声明（`customTools: []` 算已声明）；解析失败是错误，
 * 不得降级成「没声明」（那会让损坏的定义变成静默可用）。
 * 断言落在公共接口（`moduleDeclarations` / `moduleDeclares` / 登记表）上。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { isolatedHome } from '../fixtures/host-harness.mjs'

const { moduleRoot } = isolatedHome('pt-module-declarations-')
const { moduleDeclarations, moduleDeclares, DECLARED_SECTIONS } =
  await import('../../src/host/module-declarations.ts')
const { ModuleRulesError } = await import('../../src/host/module-storage.ts')

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
  assert.equal(moduleDeclares(onlyRules, 'rules'), true)
  assert.equal(moduleDeclares(onlyRules, 'customTools'), false, '键整个不存在＝没声明')

  assert.equal(moduleDeclares(emptyCustomTools, 'customTools'), true, 'customTools: [] 算已声明')
  assert.equal(moduleDeclares(emptyCustomTools, 'rules'), false, '没写的节照旧判没声明')
})

test('登记表：模块类端点各要哪个节，全局类端点不登记', () => {
  assert.deepEqual(DECLARED_SECTIONS.customTools, ['customTools'])
  assert.deepEqual(DECLARED_SECTIONS.persona, ['persona'])
  assert.deepEqual(DECLARED_SECTIONS.subagentToolPolicy, ['subagentToolPolicy'])
  assert.deepEqual(DECLARED_SECTIONS.subagentToolPolicyPreview, ['subagentToolPolicy'])
  assert.deepEqual(DECLARED_SECTIONS.moduleVariables, ['variables', 'variablesEnabled'], '任一存在即算已声明')
  assert.deepEqual(DECLARED_SECTIONS.paramOverrides, ['params', 'layerSettings'], '任一存在即算已声明')
  assert.deepEqual(DECLARED_SECTIONS.rules, ['rules'])
  assert.deepEqual(DECLARED_SECTIONS.moduleCapability, ['modules'])
  for (const key of ['charactersImport', 'moduleMerge', 'moduleUnmerge', 'bootstrap', 'describe',
    'promptConfigs', 'moduleDelete', 'mutate', 'meta', 'moduleConfigOrder']) {
    assert.equal(key in DECLARED_SECTIONS, false, `${key} 读写的是定义本身、全局段或不过归属门，不登记声明面`)
  }
})

test('非法 YAML 抛既有错误，不返回空声明集', () => {
  const broken = writeModule('declares-broken', 'rules: [unclosed\n')
  assert.throws(() => moduleDeclarations(broken), (error) => {
    assert.ok(error instanceof ModuleRulesError, `既有错误类型，实际 ${error?.name}`)
    assert.equal(error.code, 'rules-invalid', '用定义校验那条链的既有错误码')
    return true
  }, '解析失败必须是错误，不能当成「没声明」')
})

test('随包分发的四个真实模块：只声明 rules／modules，工具、人设、策略、变量与参数都未声明', () => {
  const bundled = fileURLToPath(new URL('../../modules/', import.meta.url))
  for (const id of ['ponytail', 'skill-surface', 'tool-surface', 'superpowers']) {
    const declared = moduleDeclarations(join(bundled, id))
    assert.equal(declared.has('rules'), true, `${id} 声明 rules`)
    assert.equal(declared.has('modules'), true, `${id} 声明 modules`)
    for (const section of ['customTools', 'persona', 'subagentToolPolicy', 'variables', 'variablesEnabled', 'params', 'layerSettings']) {
      assert.equal(declared.has(section), false, `${id} 未声明 ${section}（对应端点会 400 module-not-declared）`)
    }
  }
})
