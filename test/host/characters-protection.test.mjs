import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import fs, { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync, readdirSync, existsSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { parseDocument } from 'yaml'
import * as characters from '../../src/host/characters.ts'
import * as memory from '../../src/host/module-memory.ts'

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
const textRule = (id, text) => ({ id, layer: 'pre-step', then: [{ id: 'inject', kind: 'inject-text', config: { id, layer: 'pre-step', text } }] })
const overwrite = { targetId: 'alice', overwrite: true }

test('角色导入直接生成普通模块；重导入默认另存，显式覆盖保留记忆、未知资产和头像', async t => {
  const { storageRoot, moduleRoot } = setup(t)
  const imported = await characters.importCharacterCard(moduleRoot, source)
  assert.equal(imported.ok, true, imported.message)
  assert.equal(imported.id, 'alice')
  const dir = join(moduleRoot, 'alice')
  const spec = parseDocument(readFileSync(join(dir, 'module.yml'), 'utf8')).toJS()
  assert.ok(spec.rules.length > 0)
  assert.equal(spec.meta?.importedCharacters, undefined)
  assert.equal(spec.meta?.characterModules, undefined)
  assert.equal(existsSync(join(storageRoot, '.characters')), false)
  assert.equal(readFileSync(join(dir, 'card.json'), 'utf8'), source[0].content)
  for (const [file, text] of [['memory.md', '  exact memory\r\n'], ['notes.txt', 'USER'], ['avatar.png', 'OLD AVATAR']]) writeFileSync(join(dir, file), text)
  const another = await characters.importCharacterCard(moduleRoot, source)
  assert.equal(another.ok, true, another.message)
  assert.equal(another.id, 'alice-copy')
  const result = await characters.importCharacterCard(moduleRoot, source, overwrite)
  assert.equal(result.ok, true, result.message)
  assert.equal(readFileSync(join(dir, 'memory.md'), 'utf8'), '  exact memory\r\n')
  assert.equal(readFileSync(join(dir, 'notes.txt'), 'utf8'), 'USER')
  assert.equal(readFileSync(join(dir, 'avatar.png'), 'utf8'), 'OLD AVATAR')
  assert.doesNotMatch(readFileSync(join(dir, 'module.yml'), 'utf8'), /exact memory/)
})

test('模块记忆读取失败或目录链接时拒绝覆盖，旧数据和链接目标不变', async t => {
  const { storageRoot, moduleRoot } = setup(t)
  assert.equal((await characters.importCharacterCard(moduleRoot, source)).ok, true)
  const dir = join(moduleRoot, 'alice')
  mkdirSync(join(dir, 'memory.md'))
  const before = readFileSync(join(dir, 'module.yml'), 'utf8')
  const failed = await characters.importCharacterCard(moduleRoot, source, overwrite)
  assert.equal(failed.ok, false)
  assert.equal(readFileSync(join(dir, 'module.yml'), 'utf8'), before)
  const outside = join(storageRoot, 'outside')
  mkdirSync(outside)
  writeFileSync(join(outside, 'memory.md'), 'OUTSIDE')
  symlinkSync(outside, join(moduleRoot, 'linked'), 'junction')
  const linked = await characters.importCharacterCard(moduleRoot, source, { targetId: 'linked', overwrite: true })
  assert.equal(linked.ok, false)
  assert.throws(() => memory.appendModuleMemory(join(moduleRoot, 'linked'), 'BAD'), /链接|link/)
  assert.equal(readFileSync(join(outside, 'memory.md'), 'utf8'), 'OUTSIDE')
})

test('保留资产期间追加记忆触发版本拒绝，原模块保留追加内容', async t => {
  const { moduleRoot } = setup(t)
  assert.equal((await characters.importCharacterCard(moduleRoot, source)).ok, true)
  const dir = join(moduleRoot, 'alice')
  memory.appendModuleMemory(dir, 'OLD')
  const beforeEntries = readdirSync(moduleRoot).sort()
  const originalCopy = fs.cpSync
  const copy = mock.method(fs, 'cpSync', (...args) => {
    originalCopy(...args)
    memory.appendModuleMemory(dir, 'CONCURRENT NOTE')
  })
  syncBuiltinESMExports()
  try {
    const result = await characters.importCharacterCard(moduleRoot, source, overwrite)
    assert.equal(result.ok, false, result.message)
    assert.match(memory.readModuleMemory(dir), /CONCURRENT NOTE/)
    assert.deepEqual(readdirSync(moduleRoot).sort(), beforeEntries, '失败的覆盖导入不产生新增模块目录')
  } finally { copy.mock.restore(); syncBuiltinESMExports() }
})

test('交换失败恢复原模块，恢复失败保留备份并返回实际位置', async t => {
  const { moduleRoot } = setup(t)
  assert.equal((await characters.importCharacterCard(moduleRoot, source)).ok, true)
  const dir = join(moduleRoot, 'alice')
  memory.appendModuleMemory(dir, 'PRIVATE')
  const originalRename = fs.renameSync
  for (const breakRestore of [false, true]) {
    const rename = mock.method(fs, 'renameSync', (from, to) => {
      if (String(to) === dir && (!String(from).endsWith('previous') || breakRestore)) throw new Error('injected rename failure')
      return originalRename(from, to)
    })
    syncBuiltinESMExports()
    try {
      const result = await characters.importCharacterCard(moduleRoot, source, overwrite)
      assert.equal(result.ok, false)
      if (!breakRestore) assert.match(memory.readModuleMemory(dir), /PRIVATE/)
      else {
        const stage = readdirSync(moduleRoot).find(name => name.startsWith('.import-'))
        assert.ok(stage)
        assert.ok(result.message.includes(stage))
        assert.match(readFileSync(join(moduleRoot, stage, 'previous', 'memory.md'), 'utf8'), /PRIVATE/)
      }
    } finally { rename.mock.restore(); syncBuiltinESMExports() }
  }
})

test('通用模块并入：单一来源登记，记忆不注入', t => {
  const { moduleRoot } = setup(t)
  for (const [id, rules] of [['alice', [textRule('intro', 'HELLO')]], ['target', [textRule('own', 'OWN')]]]) {
    mkdirSync(join(moduleRoot, id))
    writeFileSync(join(moduleRoot, id, 'module.yml'), JSON.stringify({ id, name: id, modules: [], rules }))
  }
  memory.appendModuleMemory(join(moduleRoot, 'alice'), 'PRIVATE')
  const target = join(moduleRoot, 'target', 'module.yml')
  assert.equal(characters.mergeModuleIntoModule(moduleRoot, 'target', 'alice').count, 1)
  const merged = parseDocument(readFileSync(target, 'utf8')).toJS()
  assert.deepEqual(merged.rules.map(rule => rule.id), ['own', 'module-alice-intro'])
  assert.equal(merged.meta.mergedModules.alice.active, true)
  assert.equal(merged.meta.importedCharacters, undefined)
  assert.equal(merged.meta.characterModules, undefined)
  assert.doesNotMatch(JSON.stringify(merged), /PRIVATE/)
})
