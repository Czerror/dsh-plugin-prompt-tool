import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

const PRESETS_DIR = join(root, '.agent-presets')
const BUILTIN_IDS = ['pt-cordis', 'pt-minimal', 'pt-ptc', 'pt-standard']

test('removeUserPreset：删除用户预设目录', () => {
  mkdirSync(join(PRESETS_DIR, 'foo'), { recursive: true })
  writeFileSync(join(PRESETS_DIR, 'foo', 'preset.yml'), 'id: foo\nname: Foo\n', 'utf8')
  const result = removeUserPreset('foo')
  assert.deepEqual(result, { ok: true })
  assert.equal(existsSync(join(PRESETS_DIR, 'foo')), false)
})

test('removeUserPreset：公共删除入口不能清理隐藏备份目录', () => {
  mkdirSync(join(PRESETS_DIR, '.foo.bak-mt12345'), { recursive: true })
  writeFileSync(join(PRESETS_DIR, '.foo.bak-mt12345', 'preset.yml'), 'id: foo\n', 'utf8')
  assert.equal(removeUserPreset('.foo.bak-mt12345').ok, false)
  assert.equal(existsSync(join(PRESETS_DIR, '.foo.bak-mt12345')), true)
})

test('removeUserPreset：非法 id 与路径越界拒绝', () => {
  assert.equal(removeUserPreset('').ok, false)
  assert.equal(removeUserPreset('..').ok, false)
  assert.equal(removeUserPreset('a/b').ok, false)
  assert.equal(removeUserPreset('a\\b').ok, false)
  assert.equal(removeUserPreset('not-exists').ok, false)
  assert.equal(removeUserPreset('..\\..\\temp').ok, false)
})

test('ensurePresetSeed：首次种子化全部内置模板，删除后自动补建恢复', () => {
  const first = ensurePresetSeed()
  assert.ok(first.created.length >= BUILTIN_IDS.length, `首次应复制全部内置（实际 ${first.created.length}）`)
  for (const id of [...BUILTIN_IDS, 'pt-custom']) {
    assert.ok(existsSync(join(PRESETS_DIR, id, 'preset.yml')), `${id} 应种子化`)
  }
  // 二次调用幂等：全部存在时不重复复制。
  assert.deepEqual(ensurePresetSeed().created, [])
  // 用户/迁移误删后：下次种子化自动补建（幂等恢复，不再永久消失）。
  assert.deepEqual(removeUserPreset('pt-ptc'), { ok: true })
  const restored = ensurePresetSeed()
  assert.deepEqual(restored.created, ['pt-ptc'], '只补建删除的目录')
  assert.ok(existsSync(join(PRESETS_DIR, 'pt-ptc', 'preset.yml')), 'ptc 应已恢复')
})

test('listPresets：全部来自用户目录（种子化后内置模板即为用户预设）', () => {
  const presets = listPresets()
  for (const id of BUILTIN_IDS) {
    const preset = presets.find((entry) => entry.id === id)
    assert.ok(preset !== undefined && preset.user === true, `${id} 应为用户目录预设`)
  }
  assert.ok(!presets.some((preset) => preset.id.startsWith('.')), '点前缀目录（.engine/.bak）不列出')
})

test('listPresets：prompt-tool 目录遵循普通身份规则，不再特殊隐藏', () => {
  mkdirSync(join(PRESETS_DIR, 'prompt-tool'), { recursive: true })
  writeFileSync(join(PRESETS_DIR, 'prompt-tool', 'preset.yml'),
    'id: prompt-tool\nname: Prompt Tool（旧会话兼容）\n', 'utf8')
  assert.ok(listPresets().some((preset) => preset.id === 'prompt-tool'))
})

test('cloneBuiltinPreset：非内置/非法 id/用户目录已存在同名拒绝', () => {
  assert.equal(cloneBuiltinPreset('not-a-builtin').ok, false)
  assert.equal(cloneBuiltinPreset('a/b').ok, false)
  assert.equal(cloneBuiltinPreset('pt-standard').ok, false, '已有同名用户目录应拒绝')
  assert.equal(cloneBuiltinPreset('anchored').ok, false, 'anchored 已下线，不再是内置模板')
})

test('cloneBuiltinPreset：删除后可新建还原', () => {
  // 前一个测试把 ptc 补建回来了，先删再验还原路径。
  removeUserPreset('pt-ptc')
  assert.equal(existsSync(join(PRESETS_DIR, 'pt-ptc')), false)
  const cloned = cloneBuiltinPreset('pt-ptc')
  assert.equal(cloned.ok, true)
  assert.equal(cloned.ok && cloned.id, 'pt-ptc')
  assert.ok(existsSync(join(PRESETS_DIR, 'pt-ptc', 'preset.yml')), 'ptc 应还原到用户目录')
  assert.ok(listPresets().some((preset) => preset.id === 'pt-ptc' && preset.user === true))
})

test('cloneBuiltinPreset：autoSuffix 自定义预设重名自动递增', () => {
  // custom 已种子化存在：autoSuffix 应生成 custom-2。
  const cloned = cloneBuiltinPreset('pt-custom', true)
  assert.equal(cloned.ok, true)
  assert.equal(cloned.ok && cloned.id, 'pt-custom-2')
  assert.ok(existsSync(join(PRESETS_DIR, 'pt-custom-2', 'preset.yml')), '递增副本应创建')
  assert.ok(listPresets().some((preset) => preset.id === 'pt-custom-2' && preset.user === true))
  // 非 autoSuffix 同名仍拒绝。
  assert.equal(cloneBuiltinPreset('pt-custom').ok, false)
  removeUserPreset('pt-custom-2')
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

test('listPresets：可渲染性只由当前目录的组合源决定', () => {
  ensurePresetSeed()
  // 纯元数据 + 无组合文件 + 包内无同名模板 → 真不可用
  const broken = join(PRESETS_DIR, 'my-broken-preset')
  mkdirSync(broken, { recursive: true })
  writeFileSync(join(broken, 'preset.yml'), 'id: my-broken-preset\nname: 坏预设\n', 'utf8')
  try {
    const presets = listPresets()
    const bad = presets.find((preset) => preset.id === 'my-broken-preset')
    assert.ok(bad, '坏预设仍可列出（UI 展示并灰显，不再哑弹）')
    assert.equal(bad.renderable, false, '无组合源且包内无同名 → 不可渲染')
    // 完整种子副本可渲染，但删除组合源后不可借包内同名模板补齐。
    const minimal = presets.find((preset) => preset.id === 'pt-minimal')
    assert.ok(minimal, '种子化 minimal 在列表')
    assert.equal(minimal.renderable, true, '完整种子副本可渲染')
    const partialRoot = mkdtempSync(join(tmpdir(), 'pt-incomplete-seed-'))
    try {
      mkdirSync(join(partialRoot, 'pt-minimal'))
      writeFileSync(join(partialRoot, 'pt-minimal', 'preset.yml'), 'id: pt-minimal\nname: 部分定义\n')
      assert.equal(listPresets(partialRoot)[0].renderable, false)
    } finally { rmSync(partialRoot, { recursive: true, force: true }) }
  } finally {
    rmSync(broken, { recursive: true, force: true })
  }
})

test('ensurePresetSeed：直接同名复制包内 pt 目录，不产生裸名目录', () => {
  const safeRoot = mkdtempSync(join(tmpdir(), 'pt-seed-safe-'))
  try {
    const { created } = ensurePresetSeed(safeRoot)
    for (const id of [...BUILTIN_IDS, 'pt-custom']) {
      assert.ok(created.includes(id), `${id} 应种子化（实际：${created.join(',')}）`)
      assert.ok(existsSync(join(safeRoot, id, 'preset.yml')), `${id} 目录应存在`)
    }
    for (const id of ['standard', 'minimal', 'ptc']) {
      assert.equal(existsSync(join(safeRoot, id)), false, `${id} 不应生成被遮蔽目录`)
    }
  } finally {
    rmSync(safeRoot, { recursive: true, force: true })
  }
})

test('ensurePresetSeed：缺省参数直接按包内 pt 名称种子化', () => {
  const plainRoot = mkdtempSync(join(tmpdir(), 'pt-seed-plain-'))
  try {
    const { created } = ensurePresetSeed(plainRoot)
    assert.ok(created.includes('pt-standard'))
    assert.ok(existsSync(join(plainRoot, 'pt-standard', 'preset.yml')))
  } finally {
    rmSync(plainRoot, { recursive: true, force: true })
  }
})

test('cloneBuiltinPreset：直接同名复制，重复新建递增', () => {
  const cloneRoot = mkdtempSync(join(tmpdir(), 'pt-clone-safe-'))
  try {
    const safe = cloneBuiltinPreset('pt-standard', false, cloneRoot)
    assert.equal(safe.ok, true)
    assert.equal(safe.ok && safe.id, 'pt-standard')
    assert.ok(existsSync(join(cloneRoot, 'pt-standard', 'preset.yml')))
    // 安全目标已存在：非 autoSuffix 拒绝，autoSuffix 在安全 id 上递增。
    assert.equal(cloneBuiltinPreset('pt-standard', false, cloneRoot).ok, false)
    const second = cloneBuiltinPreset('pt-standard', true, cloneRoot)
    assert.equal(second.ok && second.id, 'pt-standard-2')
    // 未撞名模板不受占用集合影响。
    const plain = cloneBuiltinPreset('pt-cordis', false, cloneRoot)
    assert.equal(plain.ok && plain.id, 'pt-cordis')
  } finally {
    rmSync(cloneRoot, { recursive: true, force: true })
  }
})

test('ensurePresetSeed：包内定义 id 与复制目录一致', () => {
  const reserveRoot = mkdtempSync(join(tmpdir(), 'pt-seed-reserve-'))
  try {
    const { created } = ensurePresetSeed(reserveRoot)
    for (const id of ['pt-cordis', 'pt-standard', 'pt-minimal', 'pt-ptc']) {
      assert.ok(created.includes(id), `${id} 应种子化（实际：${created.join(',')}）`)
    }
    assert.equal(existsSync(join(reserveRoot, 'cordis')), false, '裸 cordis 不得生成（与官方创造模式同名）')
    // 目录名与 preset.yml 的 id 收口一致。
    for (const id of ['pt-cordis', 'pt-standard', 'pt-minimal', 'pt-ptc']) {
      assert.match(readFileSync(join(reserveRoot, id, 'preset.yml'), 'utf8'), new RegExp(`^id: ${id}$`, 'm'), `${id} 的 id 应等于目录名`)
    }
    // 未撞名模板的 id 保持原样。
    assert.match(readFileSync(join(reserveRoot, 'pt-custom', 'preset.yml'), 'utf8'), /^id: pt-custom$/m)
  } finally {
    rmSync(reserveRoot, { recursive: true, force: true })
  }
})

test('cloneBuiltinPreset：创造模式直接复制 pt-cordis', () => {
  const reserveCloneRoot = mkdtempSync(join(tmpdir(), 'pt-clone-reserve-'))
  try {
    const result = cloneBuiltinPreset('pt-cordis', false, reserveCloneRoot)
    assert.equal(result.ok && result.id, 'pt-cordis')
    assert.match(readFileSync(join(reserveCloneRoot, 'pt-cordis', 'preset.yml'), 'utf8'), /^id: pt-cordis$/m)
  } finally {
    rmSync(reserveCloneRoot, { recursive: true, force: true })
  }
})
