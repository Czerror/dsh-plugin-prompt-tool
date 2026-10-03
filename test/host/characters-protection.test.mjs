import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import fs, { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync, readdirSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { parseDocument } from 'yaml'
import * as characters from '../../src/host/characters.ts'
import { ruleInjections } from '../../src/host/rule-content.ts'

/** 每例独立存储根。两种语义：`storageRoot` 是存储根，角色卡库落在 `<storageRoot>/.characters`；
 *  characters API 的 `moduleRoot` 形参是**模块根** `<storageRoot>/modules`——角色卡库是它的兄弟，
 *  由 `charactersDir` 从 `dirname(moduleRoot)` 推出。 */
function setup(t) {
  const storageRoot = mkdtempSync(join(process.cwd(), 'pt-character-protection-'))
  const moduleRoot = join(storageRoot, 'modules')
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = storageRoot
  t.after(() => { if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous; rmSync(storageRoot, { recursive: true, force: true }) })
  mkdirSync(moduleRoot, { recursive: true })
  return { storageRoot, moduleRoot }
}
const source = [{ path: 'alice.json', content: JSON.stringify({ data: { name: 'Alice', description: 'hello' } }) }]
const textRule = (id, config) => ({ id, layer: 'pre-step', do: [{ id: 'inject', kind: 'inject-text', config: { id, layer: 'pre-step', ...config } }] })

test('角色重导入保留记忆、未知文件和未提供的头像，读取失败不覆盖旧数据', t => {
  const { storageRoot, moduleRoot } = setup(t)
  assert.equal(characters.importCharacterCard(moduleRoot, source).ok, true)
  const dir = join(storageRoot, '.characters', 'alice')
  for (const [file, text] of [['memory.md', '  exact memory\r\n'], ['notes.txt', 'USER'], ['avatar.png', 'OLD AVATAR']]) writeFileSync(join(dir, file), text)
  const result = characters.importCharacterCard(moduleRoot, source)
  assert.equal(result.ok, true, result.message)
  assert.equal(readFileSync(join(dir, 'memory.md'), 'utf8'), '  exact memory\r\n')
  assert.equal(readFileSync(join(dir, 'notes.txt'), 'utf8'), 'USER')
  assert.equal(readFileSync(join(dir, 'avatar.png'), 'utf8'), 'OLD AVATAR')
  rmSync(join(dir, 'memory.md'))
  mkdirSync(join(dir, 'memory.md'))
  assert.throws(() => characters.readCharacterMemory(moduleRoot, 'alice'), /memory|directory|EISDIR|EPERM/i)
  const before = readFileSync(join(dir, 'converted.yml'), 'utf8')
  assert.equal(characters.importCharacterCard(moduleRoot, source).ok, false)
  assert.equal(readFileSync(join(dir, 'converted.yml'), 'utf8'), before)
})

test('原生角色应用计数包含 texts 和控制配置，记忆同名普通配置不被覆盖或导出误删', t => {
  const { moduleRoot } = setup(t)
  const spec = { id: 'alice', name: 'Alice', rules: [textRule('memory', { text: 'ordinary text' }), textRule('multi', { texts: ['A', 'B'] }), { id: 'control', layer: 'agent-request', do: [{ id: 'request', kind: 'request-params', patch: { temperature: 0.5 }, modelScope: 'all' }] }] }
  const imported = characters.importCharacterCard(moduleRoot, [{ path: 'converted.yml', content: JSON.stringify(spec) }])
  assert.equal(imported.ok, true, imported.message)
  mkdirSync(join(moduleRoot, 'target'), { recursive: true })
  writeFileSync(join(moduleRoot, 'target', 'module.yml'), 'id: target\nname: Target\nmodules: []\n')
  characters.appendCharacterMemory(moduleRoot, 'alice', 'PRIVATE MEMORY')
  const applied = characters.applyCharacterToPreset(moduleRoot, 'target', 'alice')
  assert.equal(applied.ok, true, applied.message)
  assert.equal(applied.count, 4)
  const file = join(moduleRoot, 'target', 'module.yml')
  const before = readFileSync(file, 'utf8')
  const doc = parseDocument(before)
  const rules = doc.toJS().rules
  const configs = ruleInjections(rules).map(({ config }) => config)
  assert.equal(configs.find(c => c.id === 'module-alice-memory').text, 'ordinary text')
  assert.deepEqual(configs.find(c => c.id === 'module-alice-multi').texts, ['A', 'B'])
  assert.equal(new Set(rules.map(rule => rule.id)).size, 4)
  assert.deepEqual(rules.find(rule => rule.id === 'module-alice-control').do, [{ id: 'request', kind: 'request-params', patch: { temperature: 0.5 }, modelScope: 'all' }])
  const projected = characters.projectCharacterMemories(doc, {}, moduleRoot)
  assert.equal(projected.excludedMemoryCount, 1)
  assert.deepEqual(projected.memoryConflicts, [])
  assert.doesNotMatch(String(projected.doc), /PRIVATE MEMORY/)
  assert.match(String(projected.doc), /ordinary text/)
  assert.equal(readFileSync(file, 'utf8'), before)
  characters.appendCharacterMemory(moduleRoot, 'alice', 'SECOND MEMORY')
  assert.equal(characters.syncImportedCharacterMemory(moduleRoot, 'target', 'alice').ok, true)
  const next = parseDocument(readFileSync(file, 'utf8')).toJS().rules
  assert.equal(ruleInjections(next).find(({ config }) => config.id === 'module-alice-memory').config.text, 'ordinary text')
  assert.equal(next.length, 4)
})

test('角色目录 junction 拒绝更新和记忆写入，链接目标保持原样', t => {
  const { storageRoot, moduleRoot } = setup(t)
  const outside = join(storageRoot, 'outside')
  mkdirSync(outside)
  writeFileSync(join(outside, 'memory.md'), 'OUTSIDE')
  mkdirSync(join(storageRoot, '.characters'))
  symlinkSync(outside, join(storageRoot, '.characters', 'alice'), 'junction')
  assert.equal(characters.importCharacterCard(moduleRoot, source).ok, false)
  assert.throws(() => characters.appendCharacterMemory(moduleRoot, 'alice', 'BAD'), /链接|link/)
  assert.equal(readFileSync(join(outside, 'memory.md'), 'utf8'), 'OUTSIDE')
})

test('复制期间新增记忆导致拒绝交换，原目录保留追加内容', t => {
  const { storageRoot, moduleRoot } = setup(t)
  assert.equal(characters.importCharacterCard(moduleRoot, source).ok, true)
  characters.appendCharacterMemory(moduleRoot, 'alice', 'OLD')
  const originalCopy = fs.cpSync
  const copy = mock.method(fs, 'cpSync', (...args) => {
    originalCopy(...args)
    characters.appendCharacterMemory(moduleRoot, 'alice', 'CONCURRENT NOTE')
  })
  syncBuiltinESMExports()
  try {
    const result = characters.importCharacterCard(moduleRoot, source)
    assert.equal(result.ok, false)
    assert.match(result.message, /改变/)
    assert.match(characters.readCharacterMemory(moduleRoot, 'alice'), /CONCURRENT NOTE/)
    assert.deepEqual(readdirSync(join(storageRoot, '.characters')), ['alice'])
  } finally { copy.mock.restore(); syncBuiltinESMExports() }
})

test('交换失败恢复原目录，恢复失败保留备份并返回实际位置', t => {
  const { storageRoot, moduleRoot } = setup(t)
  assert.equal(characters.importCharacterCard(moduleRoot, source).ok, true)
  characters.appendCharacterMemory(moduleRoot, 'alice', 'PRIVATE')
  const originalRename = fs.renameSync
  for (const breakRestore of [false, true]) {
    const rename = mock.method(fs, 'renameSync', (from, to) => {
      if (String(from).includes('.tmp-') || (breakRestore && String(from).includes('.bak-'))) throw new Error('injected rename failure')
      return originalRename(from, to)
    })
    syncBuiltinESMExports()
    try {
      const result = characters.importCharacterCard(moduleRoot, source)
      assert.equal(result.ok, false)
      if (!breakRestore) assert.match(characters.readCharacterMemory(moduleRoot, 'alice'), /PRIVATE/)
      else {
        const backup = readdirSync(join(storageRoot, '.characters')).find(name => name.includes('.bak-'))
        assert.ok(backup)
        assert.ok(result.message.includes(backup))
        assert.match(readFileSync(join(storageRoot, '.characters', backup, 'memory.md'), 'utf8'), /PRIVATE/)
      }
    } finally { rename.mock.restore(); syncBuiltinESMExports() }
  }
})

test('改过的记忆生成项需要显式选择；投影不修改源定义', t => {
  const { moduleRoot } = setup(t)
  characters.importCharacterCard(moduleRoot, source)
  mkdirSync(join(moduleRoot, 'target'), { recursive: true })
  writeFileSync(join(moduleRoot, 'target', 'module.yml'), 'id: target\nname: Target\nmodules: []\n')
  characters.appendCharacterMemory(moduleRoot, 'alice', 'PRIVATE')
  characters.applyCharacterToPreset(moduleRoot, 'target', 'alice')
  const doc = parseDocument(readFileSync(join(moduleRoot, 'target', 'module.yml'), 'utf8'))
  const rules = doc.toJS().rules
  const memory = rules.find(rule => rule.id === 'module-alice-memory')
  memory.do.find(action => action.kind === 'inject-text').config.text += '\nEDITED'
  doc.set('rules', rules)
  const original = doc.toString()
  const result = characters.projectCharacterMemories(doc, {}, moduleRoot)
  assert.deepEqual(result.memoryConflicts.map(item => item.id), ['module-alice-memory'])
  assert.match(String(characters.projectCharacterMemories(doc, { 'module-alice-memory': 'include' }, moduleRoot).doc), /EDITED/)
  assert.doesNotMatch(String(characters.projectCharacterMemories(doc, { 'module-alice-memory': 'exclude' }, moduleRoot).doc), /PRIVATE/)
  assert.equal(doc.toString(), original)
})

test('安装成功但备份清理失败仍报告已安装并给出备份位置', t => {
  const { storageRoot, moduleRoot } = setup(t)
  characters.importCharacterCard(moduleRoot, source)
  const originalRemove = fs.rmSync
  const remove = mock.method(fs, 'rmSync', (path, ...args) => {
    if (String(path).includes('.bak-')) throw new Error('injected cleanup failure')
    return originalRemove(path, ...args)
  })
  syncBuiltinESMExports()
  try {
    const result = characters.importCharacterCard(moduleRoot, source)
    assert.equal(result.ok, true)
    assert.match(result.warning, /已安装.*备份.*\.bak-/)
    assert.ok(readFileSync(join(storageRoot, '.characters', 'alice', 'converted.yml'), 'utf8'))
  } finally { remove.mock.restore(); syncBuiltinESMExports() }
})

test('并入前缀统一为 module-，历史的 chara- 条目仍按前缀撤销（不迁移、不留孤儿）', t => {
  const { moduleRoot } = setup(t)
  const spec = { id: 'alice', name: 'Alice', rules: [textRule('intro', { text: 'HELLO' })] }
  assert.equal(characters.importCharacterCard(moduleRoot, [{ path: 'converted.yml', content: JSON.stringify(spec) }]).ok, true)
  mkdirSync(join(moduleRoot, 'target'), { recursive: true })
  const file = join(moduleRoot, 'target', 'module.yml')
  writeFileSync(file, 'id: target\nname: Target\nmodules: []\n')

  const applied = characters.applyCharacterToPreset(moduleRoot, 'target', 'alice')
  assert.equal(applied.ok, true, applied.message)
  const afterApply = readFileSync(file, 'utf8')
  assert.match(afterApply, /module-alice-intro/, '新并入的条目必须写 module- 前缀')

  // 模拟用户既有数据：前缀改回历史的 chara-（老数据不迁移，读取端必须两种都认）
  writeFileSync(file, afterApply.replaceAll('module-alice-', 'chara-alice-'))
  assert.match(readFileSync(file, 'utf8'), /chara-alice-intro/)

  const removed = characters.removeCharacterFromPreset(moduleRoot, 'target', 'alice')
  assert.equal(removed.ok, true, removed.message)
  const afterRemove = readFileSync(file, 'utf8')
  assert.doesNotMatch(afterRemove, /chara-alice-intro/, '历史前缀的条目必须被撤销，否则留下撤不掉的孤儿')
  assert.doesNotMatch(afterRemove, /module-alice-intro/)
})
