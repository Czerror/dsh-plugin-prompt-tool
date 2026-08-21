import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// removeUserPreset / listPresets 依赖 DSH_HOME（paths 模块加载时求值）。
// 本文件独立进程运行：先设临时 DSH_HOME 再动态 import lib。
const root = join(tmpdir(), `prompt-tool-user-presets-${process.pid}-${Date.now()}`)
process.env.DSH_HOME = root
const {
  cloneBuiltinPreset,
  hideBuiltinPreset,
  isPresetHidden,
  listPresets,
  removeUserPreset,
} = await import('../../lib/index.mjs')

const PRESETS_DIR = join(root, 'presets')

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

test('removeUserPreset：非法 id 与路径越界拒绝', () => {
  assert.equal(removeUserPreset('').ok, false)
  assert.equal(removeUserPreset('..').ok, false)
  assert.equal(removeUserPreset('a/b').ok, false)
  assert.equal(removeUserPreset('a\\b').ok, false)
  assert.equal(removeUserPreset('not-exists').ok, false)
  // 越界目标（resolve 后不在用户预设根内）拒绝。
  assert.equal(removeUserPreset('..\\..\\temp').ok, false)
})

test('listPresets：user 标记区分用户导入与包内置', () => {
  mkdirSync(join(PRESETS_DIR, 'user-only'), { recursive: true })
  writeFileSync(join(PRESETS_DIR, 'user-only', 'preset.yml'), 'id: user-only\nname: 用户\n', 'utf8')
  const presets = listPresets()
  const userOnly = presets.find((preset) => preset.id === 'user-only')
  assert.ok(userOnly !== undefined && userOnly.user === true, JSON.stringify(userOnly))
  const anchored = presets.find((preset) => preset.id === 'anchored')
  assert.ok(anchored !== undefined && anchored.user === false, JSON.stringify(anchored))
})

test('removeUserPreset：删除后 listPresets 不再列出', () => {
  mkdirSync(join(PRESETS_DIR, 'temp-preset'), { recursive: true })
  writeFileSync(join(PRESETS_DIR, 'temp-preset', 'preset.yml'), 'id: temp-preset\n', 'utf8')
  assert.ok(listPresets().some((preset) => preset.id === 'temp-preset'))
  removeUserPreset('temp-preset')
  assert.ok(!listPresets().some((preset) => preset.id === 'temp-preset'))
})

test('hideBuiltinPreset：内置预设从列表移除，插件目录保留，新建恢复', () => {
  // anchored 在包内 preset/（user=false 前置条件）。
  assert.ok(listPresets().some((preset) => preset.id === 'anchored' && preset.user === false))
  assert.deepEqual(hideBuiltinPreset('anchored'), { ok: true })
  assert.ok(isPresetHidden('anchored'), '应写入隐藏标记')
  assert.ok(!listPresets().some((preset) => preset.id === 'anchored'), '列表不应再含 anchored')
  // 新建（克隆）恢复：复制到用户目录 + 清除隐藏标记。
  assert.deepEqual(cloneBuiltinPreset('anchored'), { ok: true })
  assert.ok(!isPresetHidden('anchored'), '新建后隐藏标记应清除')
  const anchored = listPresets().find((preset) => preset.id === 'anchored')
  assert.ok(anchored !== undefined && anchored.user === true, '恢复后应为用户预设（可删除）')
  // 清理：删除用户副本，回退内置可见。
  assert.deepEqual(removeUserPreset('anchored'), { ok: true })
  assert.ok(listPresets().some((preset) => preset.id === 'anchored' && preset.user === false))
})

test('cloneBuiltinPreset：非内置/非法 id/已存在同名拒绝', () => {
  assert.equal(cloneBuiltinPreset('not-a-builtin').ok, false)
  assert.equal(cloneBuiltinPreset('a/b').ok, false)
  mkdirSync(join(PRESETS_DIR, 'ptc'), { recursive: true })
  writeFileSync(join(PRESETS_DIR, 'ptc', 'preset.yml'), 'id: ptc\n', 'utf8')
  assert.equal(cloneBuiltinPreset('ptc').ok, false, '用户目录已存在同名应拒绝')
  removeUserPreset('ptc')
})

test.after(() => {
  rmSync(root, { recursive: true, force: true })
  delete process.env.DSH_HOME
})
