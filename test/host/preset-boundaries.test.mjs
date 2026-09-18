import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { parse } from 'yaml'

const home = mkdtempSync(join(process.cwd(), 'pt-preset-boundaries-'))
process.env.DSH_HOME = home
const { writePreset } = await import('../../src/host/write-preset.ts')
const { duplicateUserPreset, cloneBuiltinPreset, listPresets, resolvePresetDir, removeUserPreset, parseImportedPresetId } = await import('../../src/host/manifest.ts')
test.after(() => rmSync(home, { recursive: true, force: true }))

function preset(root, id, definition = `id: ${id}\nmodules: []\n`) {
  const dir = join(root, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'preset.yml'), definition)
  return dir
}

test('writer 保留正文、二进制、自有 engine 和兄弟目录，仅重写已知引擎配置路径', () => {
  const root = mkdtempSync(join(home, 'writer-'))
  const dir = preset(root, 'own', 'id: own\ncomposition: ./source.yml\n')
  mkdirSync(join(dir, 'engine'))
  const body = '正文 ./engine/private.mjs ../prompt-configs\r\n'
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0])
  writeFileSync(join(dir, 'preset.md'), body)
  writeFileSync(join(dir, 'agents.md'), '自有正文')
  writeFileSync(join(dir, 'cover.png'), png)
  writeFileSync(join(dir, 'engine/private.mjs'), 'export default {}')
  writeFileSync(join(dir, 'source.yml'), '- id: private\n  name: ./engine/private.mjs\n  config:\n    text: ./engine/private.mjs ../prompt-configs\n- id: prompt-config-engine\n  name: ./engine/prompt-config-engine.mjs\n  config:\n    configsDir: ../prompt-configs\n    text: ./engine/private.mjs ../prompt-configs\n')
  const sibling = preset(root, 'sibling')
  mkdirSync(join(sibling, 'engine'))
  writeFileSync(join(sibling, 'engine/owned.mjs'), 'SIBLING')
  writePreset('', { presetDir: root, presetTemplate: 'own', presetOrder: 5, promptConfigs: [] })
  assert.equal(readFileSync(join(dir, 'preset.md'), 'utf8'), body)
  assert.equal(readFileSync(join(dir, 'agents.md'), 'utf8'), '自有正文')
  assert.deepEqual(readFileSync(join(dir, 'cover.png')), png)
  assert.equal(readFileSync(join(sibling, 'engine/owned.mjs'), 'utf8'), 'SIBLING')
  assert.equal(readFileSync(join(dir, 'engine/private.mjs'), 'utf8'), 'export default {}')
  const rows = parse(readFileSync(join(dir, 'agent.cordis.yml'), 'utf8'))
  assert.equal(rows[0].name, './engine/private.mjs')
  assert.equal(rows[0].config.text, './engine/private.mjs ../prompt-configs')
  assert.equal(rows[1].name, '../.engine/prompt-config-engine.mjs')
  assert.equal(rows[1].config.configsDir, '../own/prompt-configs')
  assert.equal(rows[1].config.text, './engine/private.mjs ../prompt-configs')
})

test('隔离候选使用最终 ID，但不改目标、共享引擎与来源；失败清理暂存', () => {
  const root = mkdtempSync(join(home, 'candidate-'))
  const target = preset(root, 'final', 'id: final\nmodules: []\n# OLD\n')
  const source = preset(root, 'incoming', '# SOURCE\nid: incoming\nmodules: [prompt-config-engine]\nunknown: keep\n')
  mkdirSync(join(root, '.engine'))
  writeFileSync(join(root, '.engine/sentinel'), 'SHARED')
  const old = readFileSync(join(target, 'preset.yml'), 'utf8')
  const original = readFileSync(join(source, 'preset.yml'), 'utf8')
  const candidate = writePreset('', { presetDir: root, presetTemplate: 'incoming', outputId: 'final', sourceDir: source, materializeOnly: true, presetOrder: 5, promptConfigs: [] })
  assert.equal(readFileSync(join(target, 'preset.yml'), 'utf8'), old)
  assert.equal(readFileSync(join(source, 'preset.yml'), 'utf8'), original)
  assert.deepEqual(readdirSync(join(root, '.engine')), ['sentinel'])
  assert.equal(parse(readFileSync(join(candidate, 'preset.yml'), 'utf8')).id, 'final')
  assert.match(readFileSync(join(candidate, 'preset.yml'), 'utf8'), /# SOURCE/)
  const rows = parse(readFileSync(join(candidate, 'agent.cordis.yml'), 'utf8'))
  assert.equal(rows[0].config.configsDir, '../final/prompt-configs')
  rmSync(candidate, { recursive: true })
  assert.throws(() => writePreset('', { presetDir: root, presetTemplate: 'incoming', sourceDir: source, materializeOnly: true, presetOrder: 5, promptConfigs: [{ id: '../invalid' }] }))
  assert.deepEqual(readdirSync(root).sort(), ['.engine', 'final', 'incoming'])
})

test('复制同步定义与受管引用身份并保留注释、未知字段、来源字节', () => {
  const root = mkdtempSync(join(home, 'copy-'))
  const original = '# 保留注释\nid: source # 身份\nmodules: []\nunknown:\n  nested: value\n'
  const source = preset(root, 'source', original)
  writeFileSync(join(source, 'agent.cordis.yml'), '- id: prompt-config-engine\n  name: ../.engine/prompt-config-engine.mjs\n  config:\n    configsDir: ../source/prompt-configs\n    text: ../source/prompt-configs\n')
  const result = duplicateUserPreset('source', root)
  assert.deepEqual(result, { ok: true, id: 'source-copy' })
  const copied = readFileSync(join(root, result.id, 'preset.yml'), 'utf8')
  assert.equal(parse(copied).id, result.id)
  assert.deepEqual(parse(copied).unknown, { nested: 'value' })
  assert.match(copied, /# 保留注释/)
  assert.match(copied, /# 身份/)
  assert.equal(readFileSync(join(source, 'preset.yml'), 'utf8'), original)
  const rows = parse(readFileSync(join(root, result.id, 'agent.cordis.yml'), 'utf8'))
  assert.equal(rows[0].config.configsDir, '../source-copy/prompt-configs')
  assert.equal(rows[0].config.text, '../source/prompt-configs')
  assert.equal(cloneBuiltinPreset('pt-custom', false, root).ok, true)
  assert.equal(cloneBuiltinPreset('pt-custom', true, root).id, 'pt-custom-2')
  assert.equal(parse(readFileSync(join(root, 'pt-custom-2/preset.yml'), 'utf8')).id, 'pt-custom-2')
})

test('合法 ID、定义身份和真实路径一致；路径、链接与大小写不能跨边界', () => {
  const root = mkdtempSync(join(home, 'identity-'))
  preset(root, 'valid')
  preset(root, 'wrong', 'id: valid\nmodules: []\n')
  preset(root, 'Upper')
  const outside = preset(home, 'outside')
  symlinkSync(outside, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.deepEqual(listPresets(root).map(({ id }) => id), ['valid'])
  for (const id of ['Upper', '../outside', 'wrong', 'linked', '.engine']) {
    assert.equal(duplicateUserPreset(id, root).ok, false, id)
    assert.equal(removeUserPreset(id, root).ok, false, id)
    assert.throws(() => resolvePresetDir(id, root), undefined, id)
  }
  assert.equal(existsSync(join(outside, 'preset.yml')), true)
  assert.throws(() => parseImportedPresetId('id: Upper\n', 'fallback'))
  assert.throws(() => parseImportedPresetId('id: ../escape\n', 'fallback'))
  assert.equal(parseImportedPresetId('name: no-id\n', 'fallback'), 'fallback')
  mkdirSync(join(root, 'valid/assets'))
  symlinkSync(outside, join(root, 'valid/assets/linked'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal(duplicateUserPreset('valid', root).ok, false)
})

test('复制交换被占用时拒绝安装，来源不变且没有原地覆盖或暂存残留', (t) => {
  const root = mkdtempSync(join(home, 'rename-'))
  const source = preset(root, 'source')
  const before = readFileSync(join(source, 'preset.yml'))
  const rename = fs.renameSync
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === join(root, 'source-copy')) throw Object.assign(new Error('occupied'), { code: 'EPERM' })
    return rename(from, to)
  })
  syncBuiltinESMExports()
  try {
    assert.equal(duplicateUserPreset('source', root).ok, false)
    assert.deepEqual(readFileSync(join(source, 'preset.yml')), before)
    assert.deepEqual(readdirSync(root), ['source'])
  } finally {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  }
})

test('自有同名引擎不被共享引擎接管，链接预设根和文件读取失败拒绝', (t) => {
  const root = mkdtempSync(join(home, 'owned-engine-'))
  const dir = preset(root, 'own', 'id: own\ncomposition: ./agent.cordis.yml\n')
  mkdirSync(join(dir, 'engine'))
  writeFileSync(join(dir, 'engine/prompt-config-engine.mjs'), 'OWN ENGINE')
  writeFileSync(join(dir, 'agent.cordis.yml'), '- id: prompt-config-engine\n  name: ./engine/prompt-config-engine.mjs\n  config:\n    configsDir: ../prompt-configs\n')
  const candidate = writePreset('', { presetDir: root, presetTemplate: 'own', materializeOnly: true, presetOrder: 5, promptConfigs: [] })
  assert.equal(parse(readFileSync(join(candidate, 'agent.cordis.yml'), 'utf8'))[0].name, './engine/prompt-config-engine.mjs')
  assert.equal(readFileSync(join(candidate, 'engine/prompt-config-engine.mjs'), 'utf8'), 'OWN ENGINE')
  rmSync(candidate, { recursive: true })
  const linkedRoot = join(home, 'root-link')
  symlinkSync(root, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => resolvePresetDir('own', linkedRoot), /普通目录/)
  const read = fs.readFileSync
  t.mock.method(fs, 'readFileSync', (file, ...args) => {
    if (file === join(dir, 'preset.yml')) throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
    return read(file, ...args)
  })
  syncBuiltinESMExports()
  try {
    assert.throws(() => resolvePresetDir('own', root), /permission denied/)
    assert.equal(duplicateUserPreset('own', root).ok, false)
    assert.equal(existsSync(join(root, 'own-copy')), false)
  } finally {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  }
})
