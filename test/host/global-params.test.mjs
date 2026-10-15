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
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const home = mkdtempSync(join(tmpdir(), 'pt-global-params-home-'))
process.env.DSH_HOME = home
const { storageRootOf } = await import('../../src/host/paths.ts')
const { readGlobalLayerSettings, readGlobalLayerSettingsSafe, setModuleEnabled, writeGlobalLayerSettings } = await import('../../src/host/config-store.ts')
const { listBuiltinTemplates, loadModuleSpec, packageModulesDir, resolveModuleDir, resolveModuleParams } = await import('../../src/host/manifest.ts')

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

test('全局层删键：空父层连壳回收（双层不留 `pre-step: {}`），层键缺失时幂等不抛', () => {
  // ① 双层：删掉某层最后一个键 ⇒ 该层壳一起消失，另一层与注释保留、磁盘上没有空映射。
  writeFileSync(configFile, '# 双层注释\nschemaVersion: 3\nenabled:\n  - mod-a\nlayerSettings:\n  pre-step:\n    instructionHint: true\n  agent-request:\n    modelTemperature: 0.5\n', 'utf8')
  writeGlobalLayerSettings(modulesRoot, { instructionHint: '' })
  const text = readFileSync(configFile, 'utf8')
  assert.deepEqual(readGlobalLayerSettings(modulesRoot), { modelTemperature: 0.5 }, '只剩另一层')
  assert.doesNotMatch(text, /pre-step/, '空层壳被回收（`deleteIn` 不清空父层，shared-alias 守卫会因此拒写）')
  assert.doesNotMatch(text, /\{\}/, '磁盘上没有空的层映射')
  assert.match(text, /# 双层注释/, '顶层注释保留')

  // ② 层键整体缺失：删一个不存在的层的键 ⇒ 不抛、不写、幂等（`deleteIn` 直接抛的旧形态是 bug）。
  writeFileSync(configFile, '# 只有一层\nschemaVersion: 3\nenabled:\n  - mod-a\n', 'utf8')
  const before = readFileSync(configFile, 'utf8')
  assert.doesNotThrow(() => writeGlobalLayerSettings(modulesRoot, { modelTemperature: '' }), '层键缺失时删键不抛')
  assert.equal(readFileSync(configFile, 'utf8'), before, '无处可删就原样不动')
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

test('YAML 空值键归一为未声明：模块 `instructionHint:`（null）不遮蔽全局值', () => {
  const dir = writeModule('mod-null', 'id: mod-null\nmodules: []\nrules: []\nlayerSettings:\n  pre-step:\n    instructionHint:\n')
  writeGlobalLayerSettings(modulesRoot, { instructionHint: true })
  const spec = loadModuleSpec(dir)
  assert.deepEqual(spec.params, {}, 'null 键不进 spec.params（视为未声明，不是显式取值）')
  assert.equal(resolveModuleParams(spec, {}).instructionHint, true, '全局值生效')
})

test('全局兜底：用户目录被删、回落到包内同名模板的模块照样拿全局值；包内模板不继承', () => {
  writeGlobalLayerSettings(modulesRoot, { instructionHint: true })
  // 启用表里有 ponytail，但用户目录不存在 ⇒ resolveModuleDir 回落到包内同名模板。
  setModuleEnabled(modulesRoot, 'ponytail', true)
  const fallbackDir = resolveModuleDir('ponytail', modulesRoot)
  assert.ok(fallbackDir.startsWith(resolve(packageModulesDir())), '确实回落到包内目录')
  assert.deepEqual(loadModuleSpec(fallbackDir).globalParams, { instructionHint: true },
    '启用表声明过的 id 照旧认全局层（否则「模块未声明 ⇒ 回退全局」对它静默失效）')
  // 样本换成任一未启用的包内模板：blank 已改为引擎内组装的模板，包内不再有它的目录。
  const other = listBuiltinTemplates().find((template) => template.id !== 'ponytail')?.id
  assert.ok(other !== undefined, '包内应当还有 ponytail 之外的内置模板')
  const unlisted = resolveModuleDir(other, modulesRoot)
  assert.ok(unlisted.startsWith(resolve(packageModulesDir())), '未启用的包内模板仍在包内')
  assert.equal(loadModuleSpec(unlisted).globalParams, undefined,
    '不在启用表里的包内模板不继承全局层（克隆/导入不会把全局值烘进新模块定义）')
})

test('全局层坏掉是软失败：装配不抛（按「无全局层」继续），读路径给出诊断', () => {
  const dir = writeModule('mod-typo', 'id: mod-typo\nmodules: []\nrules: []\n')
  // 层名笔误（pre-step-typo 不是合法插入点）：形状校验会抛。
  writeFileSync(configFile, 'schemaVersion: 3\nenabled:\n  - mod-typo\nlayerSettings:\n  pre-step-typo:\n    instructionHint: true\n', 'utf8')
  assert.doesNotThrow(() => loadModuleSpec(dir), '装配路径（prepareAssembly 无捕获）不得因全局层笔误而抛')
  assert.equal(loadModuleSpec(dir).globalParams, undefined, '按「无全局层」继续')
  const safe = readGlobalLayerSettingsSafe(modulesRoot)
  assert.deepEqual(safe.params, {}, '软失败读回空参数')
  assert.match(safe.error, /pre-step-typo/, '诊断点出笔误的层名')
  assert.throws(() => writeGlobalLayerSettings(modulesRoot, { instructionHint: true }),
    (error) => error.code === 'module-layer-settings-invalid', '写路径仍响亮拒绝，不覆盖坏文件')
})
