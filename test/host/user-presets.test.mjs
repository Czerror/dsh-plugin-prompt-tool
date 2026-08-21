import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// removeUserPreset / ensurePresetSeed / listPresets / cloneBuiltinPreset 依赖 DSH_HOME
// （paths 模块加载时求值）。本文件独立进程运行：先设临时 DSH_HOME 再动态 import lib。
const root = join(tmpdir(), `prompt-tool-user-presets-${process.pid}-${Date.now()}`)
process.env.DSH_HOME = root
const {
  cloneBuiltinPreset,
  ensurePresetSeed,
  listPresets,
  removeUserPreset,
} = await import('../../lib/index.mjs')

const PRESETS_DIR = join(root, 'presets')
const BUILTIN_IDS = ['anchored', 'creative', 'liangshen', 'minimal', 'ptc', 'standard']

test('removeUserPreset：删除用户预设目录', () => {
  mkdirSync(join(PRESETS_DIR, 'foo'), { recursive: true })
  writeFileSync(join(PRESETS_DIR, 'foo', 'preset.yml'), 'id: foo\nname: Foo\n', 'utf8')
  const result = removeUserPreset('foo')
  assert.deepEqual(result, { ok: true })
  assert.equal(existsSync(join(PRESETS_DIR, 'foo')), false)
})

test('removeUserPreset：.bak 备份目录可删除（垃圾清理）', () => {
  mkdirSync(join(PRESETS_DIR, '.foo.bak-mt12345'), { recursive: true })
  writeFileSync(join(PRESETS_DIR, '.foo.bak-mt12345', 'preset.yml'), 'id: foo\n', 'utf8')
  assert.deepEqual(removeUserPreset('.foo.bak-mt12345'), { ok: true })
  assert.equal(existsSync(join(PRESETS_DIR, '.foo.bak-mt12345')), false)
})

test('removeUserPreset：同时清理生成目录同名子预设', () => {
  const genDir = join(root, 'generated')
  mkdirSync(join(genDir, 'foo'), { recursive: true })
  writeFileSync(join(genDir, 'foo', 'preset.yml'), 'id: foo\n', 'utf8')
  mkdirSync(join(PRESETS_DIR, 'foo'), { recursive: true })
  writeFileSync(join(PRESETS_DIR, 'foo', 'preset.yml'), 'id: foo\n', 'utf8')
  assert.deepEqual(removeUserPreset('foo', genDir), { ok: true })
  assert.equal(existsSync(join(PRESETS_DIR, 'foo')), false)
  assert.equal(existsSync(join(genDir, 'foo')), false, '生成目录同名子预设应一并清理')
})

test('removeUserPreset：仅生成目录存在（孤儿残留）时删除成功并清理', () => {
  const genDir = join(root, 'generated-orphan')
  mkdirSync(join(genDir, 'orphan'), { recursive: true })
  writeFileSync(join(genDir, 'orphan', 'preset.yml'), 'id: orphan\n', 'utf8')
  assert.deepEqual(removeUserPreset('orphan', genDir), { ok: true })
  assert.equal(existsSync(join(genDir, 'orphan')), false, '生成目录孤儿应清理')
  // 两处都不存在仍报不存在（回归）。
  assert.equal(removeUserPreset('not-exists', genDir).ok, false)
})

test('removeUserPreset：非法 id 与路径越界拒绝', () => {
  assert.equal(removeUserPreset('').ok, false)
  assert.equal(removeUserPreset('..').ok, false)
  assert.equal(removeUserPreset('a/b').ok, false)
  assert.equal(removeUserPreset('a\\b').ok, false)
  assert.equal(removeUserPreset('not-exists').ok, false)
  assert.equal(removeUserPreset('..\\..\\temp').ok, false)
})

test('ensurePresetSeed：首次种子化全部内置模板，.seeded 后不重复且删除不复活', () => {
  const first = ensurePresetSeed()
  assert.ok(first.created.length >= BUILTIN_IDS.length, `首次应复制全部内置（实际 ${first.created.length}）`)
  for (const id of [...BUILTIN_IDS, 'custom']) {
    assert.ok(existsSync(join(PRESETS_DIR, id, 'preset.yml')), `${id} 应种子化`)
  }
  // 二次调用不重复复制。
  assert.deepEqual(ensurePresetSeed().created, [])
  // 用户删除后不自动复活（种子化只在首次执行）。
  assert.deepEqual(removeUserPreset('ptc'), { ok: true })
  ensurePresetSeed()
  assert.equal(existsSync(join(PRESETS_DIR, 'ptc')), false, '删除后种子化不应自动复活')
})

test('listPresets：全部来自用户目录（种子化后内置模板即为用户预设）', () => {
  const presets = listPresets()
  for (const id of ['anchored', 'creative', 'liangshen', 'minimal', 'standard']) {
    const preset = presets.find((entry) => entry.id === id)
    assert.ok(preset !== undefined && preset.user === true, `${id} 应为用户目录预设`)
  }
  assert.ok(!presets.some((preset) => preset.id === 'ptc'), 'ptc 已删除不应列出')
})

test('cloneBuiltinPreset：非内置/非法 id/用户目录已存在同名拒绝', () => {
  assert.equal(cloneBuiltinPreset('not-a-builtin').ok, false)
  assert.equal(cloneBuiltinPreset('a/b').ok, false)
  assert.equal(cloneBuiltinPreset('anchored').ok, false, '种子化后用户目录已存在 anchored，应拒绝')
})

test('cloneBuiltinPreset：删除后可新建还原', () => {
  assert.equal(existsSync(join(PRESETS_DIR, 'ptc')), false)
  const cloned = cloneBuiltinPreset('ptc')
  assert.equal(cloned.ok, true)
  assert.equal(cloned.ok && cloned.id, 'ptc')
  assert.ok(existsSync(join(PRESETS_DIR, 'ptc', 'preset.yml')), 'ptc 应还原到用户目录')
  assert.ok(listPresets().some((preset) => preset.id === 'ptc' && preset.user === true))
})

test('cloneBuiltinPreset：autoSuffix 自定义预设重名自动递增', () => {
  // custom 已种子化存在：autoSuffix 应生成 custom-2。
  const cloned = cloneBuiltinPreset('custom', true)
  assert.equal(cloned.ok, true)
  assert.equal(cloned.ok && cloned.id, 'custom-2')
  assert.ok(existsSync(join(PRESETS_DIR, 'custom-2', 'preset.yml')), 'custom-2 应创建')
  assert.ok(listPresets().some((preset) => preset.id === 'custom-2' && preset.user === true))
  // 非 autoSuffix 同名仍拒绝。
  assert.equal(cloneBuiltinPreset('custom').ok, false)
  removeUserPreset('custom-2')
})

test('removeUserPreset：删除后 listPresets 不再列出', () => {
  mkdirSync(join(PRESETS_DIR, 'temp-preset'), { recursive: true })
  writeFileSync(join(PRESETS_DIR, 'temp-preset', 'preset.yml'), 'id: temp-preset\n', 'utf8')
  assert.ok(listPresets().some((preset) => preset.id === 'temp-preset'))
  removeUserPreset('temp-preset')
  assert.ok(!listPresets().some((preset) => preset.id === 'temp-preset'))
})

test.after(() => {
  rmSync(root, { recursive: true, force: true })
  delete process.env.DSH_HOME
})
