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
  mergeOccupiedPresetIds,
  removeUserPreset,
} = await import('../../lib/index.mjs')

const PRESETS_DIR = join(root, '.agent-presets')
const BUILTIN_IDS = ['cordis', 'minimal', 'ptc', 'standard']

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
  assert.equal(removeUserPreset('..\\..\\temp').ok, false)
})

test('ensurePresetSeed：首次种子化全部内置模板，删除后自动补建恢复', () => {
  const first = ensurePresetSeed()
  assert.ok(first.created.length >= BUILTIN_IDS.length, `首次应复制全部内置（实际 ${first.created.length}）`)
  for (const id of [...BUILTIN_IDS, 'custom']) {
    assert.ok(existsSync(join(PRESETS_DIR, id, 'preset.yml')), `${id} 应种子化`)
  }
  // 二次调用幂等：全部存在时不重复复制。
  assert.deepEqual(ensurePresetSeed().created, [])
  // 用户/迁移误删后：下次种子化自动补建（幂等恢复，不再永久消失）。
  assert.deepEqual(removeUserPreset('ptc'), { ok: true })
  const restored = ensurePresetSeed()
  assert.ok(restored.created.includes('ptc'), '删除的 ptc 应被补建恢复')
  assert.ok(existsSync(join(PRESETS_DIR, 'ptc', 'preset.yml')), 'ptc 应已恢复')
})

test('listPresets：全部来自用户目录（种子化后内置模板即为用户预设）', () => {
  const presets = listPresets()
  for (const id of ['cordis', 'minimal', 'ptc', 'standard']) {
    const preset = presets.find((entry) => entry.id === id)
    assert.ok(preset !== undefined && preset.user === true, `${id} 应为用户目录预设`)
  }
  assert.ok(!presets.some((preset) => preset.id.startsWith('.')), '点前缀目录（.engine/.bak）不列出')
})

test('listPresets：prompt-tool 兼容快照仅供旧会话 resolve，不进入普通选择列表', () => {
  mkdirSync(join(PRESETS_DIR, 'prompt-tool'), { recursive: true })
  writeFileSync(join(PRESETS_DIR, 'prompt-tool', 'preset.yml'),
    'id: prompt-tool\nname: Prompt Tool（旧会话兼容）\n', 'utf8')
  assert.ok(!listPresets().some((preset) => preset.id === 'prompt-tool'))
})

test('cloneBuiltinPreset：非内置/非法 id/用户目录已存在同名拒绝', () => {
  assert.equal(cloneBuiltinPreset('not-a-builtin').ok, false)
  assert.equal(cloneBuiltinPreset('a/b').ok, false)
  assert.equal(cloneBuiltinPreset('standard').ok, false, '种子化后用户目录已存在 standard，应拒绝')
  assert.equal(cloneBuiltinPreset('anchored').ok, false, 'anchored 已下线，不再是内置模板')
})

test('cloneBuiltinPreset：删除后可新建还原', () => {
  // 前一个测试把 ptc 补建回来了，先删再验还原路径。
  removeUserPreset('ptc')
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

test('listPresets：不可渲染预设标记 renderable=false；包内同名可回退则 true', () => {
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
    // 种子化 minimal 副本可渲染；包内同名模板可作为回退源。
    const minimal = presets.find((preset) => preset.id === 'minimal')
    assert.ok(minimal, '种子化 minimal 在列表')
    assert.equal(minimal.renderable, true, '包内同名模板可回退 → 可渲染')
  } finally {
    rmSync(broken, { recursive: true, force: true })
  }
})

test('ensurePresetSeed：与宿主内置重名的模板改用安全 id，不产生被遮蔽目录', () => {
  const safeRoot = mkdtempSync(join(tmpdir(), 'pt-seed-safe-'))
  try {
    const occupied = new Set(['standard', 'minimal', 'ptc'])
    const { created } = ensurePresetSeed(safeRoot, occupied)
    for (const id of ['pt-standard', 'pt-minimal', 'pt-ptc', 'cordis', 'custom']) {
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

test('ensurePresetSeed：占用集合缺省（空集）时保持旧语义，模板原名不变', () => {
  const plainRoot = mkdtempSync(join(tmpdir(), 'pt-seed-plain-'))
  try {
    const { created } = ensurePresetSeed(plainRoot)
    assert.ok(created.includes('standard'), '空占用集合下仍按模板原名种子化')
    assert.ok(existsSync(join(plainRoot, 'standard', 'preset.yml')))
  } finally {
    rmSync(plainRoot, { recursive: true, force: true })
  }
})

test('cloneBuiltinPreset：撞名落到安全 id、重复新建递增，未撞名保持原名', () => {
  const cloneRoot = mkdtempSync(join(tmpdir(), 'pt-clone-safe-'))
  try {
    const occupied = new Set(['standard'])
    const safe = cloneBuiltinPreset('standard', false, cloneRoot, occupied)
    assert.equal(safe.ok, true)
    assert.equal(safe.ok && safe.id, 'pt-standard')
    assert.ok(existsSync(join(cloneRoot, 'pt-standard', 'preset.yml')))
    // 安全目标已存在：非 autoSuffix 拒绝，autoSuffix 在安全 id 上递增。
    assert.equal(cloneBuiltinPreset('standard', false, cloneRoot, occupied).ok, false)
    const second = cloneBuiltinPreset('standard', true, cloneRoot, occupied)
    assert.equal(second.ok && second.id, 'pt-standard-2')
    // 未撞名模板不受占用集合影响。
    const plain = cloneBuiltinPreset('cordis', false, cloneRoot, occupied)
    assert.equal(plain.ok && plain.id, 'cordis')
  } finally {
    rmSync(cloneRoot, { recursive: true, force: true })
  }
})

test('ensurePresetSeed：官方保留名表生效，创造模式模板（cordis）落 pt-cordis 且 id 收口', () => {
  const reserveRoot = mkdtempSync(join(tmpdir(), 'pt-seed-reserve-'))
  try {
    const { created } = ensurePresetSeed(reserveRoot, mergeOccupiedPresetIds())
    for (const id of ['pt-cordis', 'pt-standard', 'pt-minimal', 'pt-ptc']) {
      assert.ok(created.includes(id), `${id} 应种子化（实际：${created.join(',')}）`)
    }
    assert.equal(existsSync(join(reserveRoot, 'cordis')), false, '裸 cordis 不得生成（与官方创造模式同名）')
    // 目录名与 preset.yml 的 id 收口一致。
    for (const id of ['pt-cordis', 'pt-standard', 'pt-minimal', 'pt-ptc']) {
      assert.match(readFileSync(join(reserveRoot, id, 'preset.yml'), 'utf8'), new RegExp(`^id: ${id}$`, 'm'), `${id} 的 id 应等于目录名`)
    }
    // 未撞名模板的 id 保持原样。
    assert.match(readFileSync(join(reserveRoot, 'custom', 'preset.yml'), 'utf8'), /^id: custom$/m)
  } finally {
    rmSync(reserveRoot, { recursive: true, force: true })
  }
})

test('cloneBuiltinPreset：保留名表下创造模式模板落 pt-cordis', () => {
  const reserveCloneRoot = mkdtempSync(join(tmpdir(), 'pt-clone-reserve-'))
  try {
    const result = cloneBuiltinPreset('cordis', false, reserveCloneRoot, mergeOccupiedPresetIds())
    assert.equal(result.ok && result.id, 'pt-cordis')
    assert.match(readFileSync(join(reserveCloneRoot, 'pt-cordis', 'preset.yml'), 'utf8'), /^id: pt-cordis$/m)
  } finally {
    rmSync(reserveCloneRoot, { recursive: true, force: true })
  }
})
