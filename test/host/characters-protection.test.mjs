import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import fs, { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync, readdirSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { parseDocument } from 'yaml'
import * as characters from '../../src/host/characters.ts'

function setup(t) {
  const root = mkdtempSync(join(process.cwd(), 'pt-character-protection-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = root
  t.after(() => { if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous; rmSync(root, { recursive: true, force: true }) })
  return root
}
const source = [{ path: 'alice.json', content: JSON.stringify({ data: { name: 'Alice', description: 'hello' } }) }]

test('角色重导入保留记忆、未知文件和未提供的头像，读取失败不覆盖旧数据', t => {
  const root = setup(t)
  assert.equal(characters.importCharacterCard(root, source).ok, true)
  const dir = join(root, '.characters', 'alice')
  for (const [file, text] of [['memory.md', '  exact memory\r\n'], ['notes.txt', 'USER'], ['avatar.png', 'OLD AVATAR']]) writeFileSync(join(dir, file), text)
  const result = characters.importCharacterCard(root, source)
  assert.equal(result.ok, true, result.message)
  assert.equal(readFileSync(join(dir, 'memory.md'), 'utf8'), '  exact memory\r\n')
  assert.equal(readFileSync(join(dir, 'notes.txt'), 'utf8'), 'USER')
  assert.equal(readFileSync(join(dir, 'avatar.png'), 'utf8'), 'OLD AVATAR')
  rmSync(join(dir, 'memory.md'))
  mkdirSync(join(dir, 'memory.md'))
  assert.throws(() => characters.readCharacterMemory(root, 'alice'), /memory|directory|EISDIR|EPERM/i)
  const before = readFileSync(join(dir, 'converted.yml'), 'utf8')
  assert.equal(characters.importCharacterCard(root, source).ok, false)
  assert.equal(readFileSync(join(dir, 'converted.yml'), 'utf8'), before)
})

test('原生角色应用计数包含 texts 和控制配置，记忆同名普通配置不被覆盖或导出误删', t => {
  const root = setup(t)
  const spec = { id: 'alice', name: 'Alice', promptConfigs: [{ id: 'memory', text: 'ordinary text' }, { id: 'multi', texts: ['A', 'B'] }, { id: 'control', layer: 'agent-request', strategy: 'static', params: { patch: { temperature: 0.5 } } }] }
  const imported = characters.importCharacterCard(root, [{ path: 'converted.yml', content: JSON.stringify(spec) }])
  assert.equal(imported.ok, true, imported.message)
  mkdirSync(join(root, 'target'))
  writeFileSync(join(root, 'target', 'preset.yml'), 'id: target\nname: Target\nmodules: []\n')
  characters.appendCharacterMemory(root, 'alice', 'PRIVATE MEMORY')
  const applied = characters.applyCharacterToPreset(root, 'target', 'alice')
  assert.equal(applied.ok, true, applied.message)
  assert.equal(applied.count, 4)
  const file = join(root, 'target', 'preset.yml')
  const before = readFileSync(file, 'utf8')
  const doc = parseDocument(before)
  const configs = doc.toJS().promptConfigs
  assert.equal(configs.find(c => c.id === 'chara-alice-memory').text, 'ordinary text')
  assert.deepEqual(configs.find(c => c.id === 'chara-alice-multi').texts, ['A', 'B'])
  assert.equal(new Set(configs.map(c => c.id)).size, 4)
  const projected = characters.projectCharacterMemories(doc, {}, root)
  assert.equal(projected.excludedMemoryCount, 1)
  assert.deepEqual(projected.memoryConflicts, [])
  assert.doesNotMatch(String(projected.doc), /PRIVATE MEMORY/)
  assert.match(String(projected.doc), /ordinary text/)
  assert.equal(readFileSync(file, 'utf8'), before)
  characters.appendCharacterMemory(root, 'alice', 'SECOND MEMORY')
  assert.equal(characters.syncImportedCharacterMemory(root, 'target', 'alice').ok, true)
  const next = parseDocument(readFileSync(file, 'utf8')).toJS().promptConfigs
  assert.equal(next.find(c => c.id === 'chara-alice-memory').text, 'ordinary text')
  assert.equal(next.length, 4)
})

test('角色目录 junction 拒绝更新和记忆写入，链接目标保持原样', t => {
  const root = setup(t)
  const outside = join(root, 'outside')
  mkdirSync(outside)
  writeFileSync(join(outside, 'memory.md'), 'OUTSIDE')
  mkdirSync(join(root, '.characters'))
  symlinkSync(outside, join(root, '.characters', 'alice'), 'junction')
  assert.equal(characters.importCharacterCard(root, source).ok, false)
  assert.throws(() => characters.appendCharacterMemory(root, 'alice', 'BAD'), /链接|link/)
  assert.equal(readFileSync(join(outside, 'memory.md'), 'utf8'), 'OUTSIDE')
})

test('复制期间新增记忆导致拒绝交换，原目录保留追加内容', t => {
  const root = setup(t)
  assert.equal(characters.importCharacterCard(root, source).ok, true)
  characters.appendCharacterMemory(root, 'alice', 'OLD')
  const originalCopy = fs.cpSync
  const copy = mock.method(fs, 'cpSync', (...args) => {
    originalCopy(...args)
    characters.appendCharacterMemory(root, 'alice', 'CONCURRENT NOTE')
  })
  syncBuiltinESMExports()
  try {
    const result = characters.importCharacterCard(root, source)
    assert.equal(result.ok, false)
    assert.match(result.message, /改变/)
    assert.match(characters.readCharacterMemory(root, 'alice'), /CONCURRENT NOTE/)
    assert.deepEqual(readdirSync(join(root, '.characters')), ['alice'])
  } finally { copy.mock.restore(); syncBuiltinESMExports() }
})

test('交换失败恢复原目录，恢复失败保留备份并返回实际位置', t => {
  const root = setup(t)
  assert.equal(characters.importCharacterCard(root, source).ok, true)
  characters.appendCharacterMemory(root, 'alice', 'PRIVATE')
  const originalRename = fs.renameSync
  for (const breakRestore of [false, true]) {
    const rename = mock.method(fs, 'renameSync', (from, to) => {
      if (String(from).includes('.tmp-') || (breakRestore && String(from).includes('.bak-'))) throw new Error('injected rename failure')
      return originalRename(from, to)
    })
    syncBuiltinESMExports()
    try {
      const result = characters.importCharacterCard(root, source)
      assert.equal(result.ok, false)
      if (!breakRestore) assert.match(characters.readCharacterMemory(root, 'alice'), /PRIVATE/)
      else {
        const backup = readdirSync(join(root, '.characters')).find(name => name.includes('.bak-'))
        assert.ok(backup)
        assert.ok(result.message.includes(backup))
        assert.match(readFileSync(join(root, '.characters', backup, 'memory.md'), 'utf8'), /PRIVATE/)
      }
    } finally { rename.mock.restore(); syncBuiltinESMExports() }
  }
})

test('改过的记忆生成项需要显式选择；投影不修改源定义', t => {
  const root = setup(t)
  characters.importCharacterCard(root, source)
  mkdirSync(join(root, 'target'))
  writeFileSync(join(root, 'target', 'preset.yml'), 'id: target\nname: Target\nmodules: []\n')
  characters.appendCharacterMemory(root, 'alice', 'PRIVATE')
  characters.applyCharacterToPreset(root, 'target', 'alice')
  const doc = parseDocument(readFileSync(join(root, 'target', 'preset.yml'), 'utf8'))
  const configs = doc.toJS().promptConfigs
  const memory = configs.find(config => config.id === 'chara-alice-memory')
  memory.text += '\nEDITED'
  doc.set('promptConfigs', configs)
  const original = doc.toString()
  const result = characters.projectCharacterMemories(doc, {}, root)
  assert.deepEqual(result.memoryConflicts.map(item => item.id), ['chara-alice-memory'])
  assert.match(String(characters.projectCharacterMemories(doc, { 'chara-alice-memory': 'include' }, root).doc), /EDITED/)
  assert.doesNotMatch(String(characters.projectCharacterMemories(doc, { 'chara-alice-memory': 'exclude' }, root).doc), /PRIVATE/)
  assert.equal(doc.toString(), original)
})

test('安装成功但备份清理失败仍报告已安装并给出备份位置', t => {
  const root = setup(t)
  characters.importCharacterCard(root, source)
  const originalRemove = fs.rmSync
  const remove = mock.method(fs, 'rmSync', (path, ...args) => {
    if (String(path).includes('.bak-')) throw new Error('injected cleanup failure')
    return originalRemove(path, ...args)
  })
  syncBuiltinESMExports()
  try {
    const result = characters.importCharacterCard(root, source)
    assert.equal(result.ok, true)
    assert.match(result.warning, /已安装.*备份.*\.bak-/)
    assert.ok(readFileSync(join(root, '.characters', 'alice', 'converted.yml'), 'utf8'))
  } finally { remove.mock.restore(); syncBuiltinESMExports() }
})
