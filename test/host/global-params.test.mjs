/**
 * 全局层引擎参数（存储根 `config.yml` 的 `layerSettings`）的读写与优先级。
 *
 * seam：写盘产物语义 + 引擎参数的来源解析。
 * 真值源：用户裁定 2026-10-12——「模块未声明 ⇒ 回退为全局；模块显式值 ＞ 全局值」，
 * 判据是**该模块对这个参数有没有显式取值**（`false` 也算显式，不是「只有 true 才覆盖」）。
 */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const home = mkdtempSync(join(tmpdir(), 'pt-global-params-home-'))
process.env.DSH_HOME = home
const { storageRootOf } = await import('../../src/host/paths.ts')
const { readGlobalLayerSettings, writeGlobalLayerSettings } = await import('../../src/host/config-store.ts')
const { loadModuleSpec, resolveModuleParams } = await import('../../src/host/manifest.ts')

after(() => {
  rmSync(home, { recursive: true, force: true })
  delete process.env.DSH_HOME
})

const root = storageRootOf(home)
const modulesRoot = join(root, 'modules')
const configFile = join(root, 'config.yml')

function writeModule(id, body) {
  const dir = join(modulesRoot, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'module.yml'), body, 'utf8')
  return dir
}

test('全局层写盘：只动 config.yml 的 layerSettings，注释与 enabled 原样保留，空值删键', () => {
  mkdirSync(modulesRoot, { recursive: true })
  writeFileSync(configFile, '# 启用表注释\nschemaVersion: 3\nenabled:\n  - mod-a\n', 'utf8')
  writeGlobalLayerSettings(modulesRoot, { instructionHint: true })
  const text = readFileSync(configFile, 'utf8')
  assert.match(text, /# 启用表注释/, '顶层注释保留')
  assert.match(text, /enabled:\n {2}- mod-a/, 'enabled 原样保留')
  assert.match(text, /instructionHint: true/, '全局值落在 config.yml 的 layerSettings')
  assert.deepEqual(readGlobalLayerSettings(modulesRoot), { instructionHint: true })

  writeGlobalLayerSettings(modulesRoot, { instructionHint: '' })
  assert.deepEqual(readGlobalLayerSettings(modulesRoot), {}, '空值删键（回落默认）')
  assert.doesNotMatch(readFileSync(configFile, 'utf8'), /layerSettings/, '整节为空时不留空壳')
})

test('优先级：模块显式键（含 false）覆盖全局，模块没有该键才回退全局', () => {
  const base = { id: 'mod-a' }
  assert.equal(resolveModuleParams({ ...base, globalParams: { instructionHint: true } }, {}).instructionHint, true,
    '模块没有该键 ⇒ 用全局值')
  assert.equal(resolveModuleParams({ ...base, globalParams: { instructionHint: true }, layerSettings: { 'pre-step': { instructionHint: false } } }, {}).instructionHint, false,
    '模块显式 false 覆盖全局 true（存在即覆盖）')
  assert.equal(resolveModuleParams({ ...base, layerSettings: {} }, {}).instructionHint, undefined,
    '两处都没有 ⇒ 不出现该键，由引擎/行默认兜底')
})

test('loadModuleSpec：全局层进 spec.globalParams，但不并进 spec.params（未声明就是未声明）', () => {
  const dir = writeModule('mod-a', 'id: mod-a\nmodules: []\nrules: []\n')
  writeGlobalLayerSettings(modulesRoot, { instructionHint: true })
  const undeclared = loadModuleSpec(dir)
  assert.deepEqual(undeclared.globalParams, { instructionHint: true }, '全局层随存储根读入')
  assert.equal(undeclared.params, undefined, '模块没声明 params/layerSettings ⇒ spec.params 缺席（声明面事实不被全局层污染）')
  assert.equal(resolveModuleParams(undeclared, {}).instructionHint, true, '有效参数拿到全局值')

  writeModule('mod-a', 'id: mod-a\nmodules: []\nrules: []\nlayerSettings:\n  pre-step:\n    instructionHint: false\n')
  const declared = loadModuleSpec(dir)
  assert.deepEqual(declared.params, { instructionHint: false }, 'spec.params 只含模块自己写的键')
  assert.equal(resolveModuleParams(declared, {}).instructionHint, false, '模块显式 false 压住全局 true')
})
