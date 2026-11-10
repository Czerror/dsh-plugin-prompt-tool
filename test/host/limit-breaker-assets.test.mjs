import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseDocument } from 'yaml'
import { isolatedHome, tempDir } from '../fixtures/host-harness.mjs'

isolatedHome('pt-limit-assets-')
const { cloneBuiltinModule, duplicateUserModule, ensureModuleSeed } = await import('../../src/host/module-catalog.ts')
const { readModuleRules, editModuleRules } = await import('../../src/host/module-rules.ts')
const { readModuleFile } = await import('../../src/host/module-files.ts')
const { compileRules } = await import('../../engine/rule-spec.mjs')
const { rulePromptConfigOptions } = await import('../../src/host/module-slices.ts')
const { moduleImportPreview, installModulePackage, exportModulePackage, expandModuleSource } = await import('../../src/host/module-package.ts')
const { enabledModuleIds, setModuleEnabled } = await import('../../src/host/config-store.ts')
function fixture() {
  const root = join(tempDir('pt-limit-assets-root-'), 'modules')
  mkdirSync(root)
  assert.equal(cloneBuiltinModule('limit-breaker', false, root).ok, true)
  return { root, dir: join(root, 'limit-breaker') }
}

test('核心来源目录保留66稳定身份，未验证条目无动作且拒绝启用', () => {
  const { dir } = fixture()
  const snapshot = readModuleRules(dir)
  const core = snapshot.rules.filter(rule => rule.id.startsWith('purge-'))
  assert.equal(core.length, 66)
  assert.equal(new Set(core.map(rule => rule.source.id)).size, 66)
  assert.ok(core.every(rule => rule.enabled === false && rule.id === `purge-${rule.source.id}`))
  const pending = core.filter(rule => !['purge-4', 'purge-25'].includes(rule.id))
  assert.ok(pending.every(rule => rule.then.length === 0 && rule.name.includes('未验证')))
  assert.deepEqual(core.map(rule => rule.source.id).sort((a, b) => a - b), [1, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 22, 23, 24, 25, 26, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 40, 43, 47, 48, 51, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 70, 71, 72, 73, 74, 75, 76, 77, 87, 88, 89, 93, 94])
  assert.throws(() => editModuleRules(dir, { expectedRevisions: snapshot.revisions, activateRuleId: 'purge-1' }), /未验证|尚无可执行动作/)
  assert.deepEqual(readModuleRules(dir), snapshot, '拒绝启用不改定义或版本')
})

test('内置默认正文经公共文件读取保持25128字节与固定来源哈希', () => {
  const { dir } = fixture()
  const asset = JSON.parse(readModuleFile(dir, 'assets/prompts/default-prompt-inject.json').content)
  assert.equal(Buffer.byteLength(asset.text), 25128)
  assert.equal(createHash('sha256').update(asset.text).digest('hex'), '1757f1774457b448323ba036ec177c3c638d2a6dc97c9aa8ca2a1cc3e07528bc')
  const spec = readModuleRules(dir)
  const rule = spec.rules.find(rule => rule.id === 'source-default-prompt-inject')
  const compiled = compileRules([rule], { moduleId: 'limit-breaker', promptConfigOptions: rulePromptConfigOptions(dir) })
  assert.deepEqual(compiled[0].actions[0].compiledConfig.texts, [asset.text], 'JSON wrapper不成为注入正文')
})

test('来源目录只放宽显式关闭且有合法来源的空then，未验证不能绕过其它校验', () => {
  const source = { format: 'dsh-purge', id: 1, name: 'WORKSPACE_CONTEXT_INTRO', path: 'lib/patches/prompt.mjs', commit: '126caa2c99297223a7e0e87e604aecfc802f396e' }
  const rule = { id: 'purge-1', enabled: false, source, then: [] }
  assert.deepEqual(compileRules([rule])[0].actions, [])
  for (const value of [{ ...rule, source: undefined }, { ...rule, enabled: undefined }, { ...rule, enabled: true }, { ...rule, source: { ...source, id: 0 } }, { ...rule, if: { unknown: true } }, { ...rule, then: [{ id: 'bad', kind: 'unknown' }] }]) {
    assert.throws(() => compileRules([value]))
  }
  const { dir } = fixture(), snapshot = readModuleRules(dir)
  const dangling = { ...rule, if: { anchor: { keys: ['x'], after: { action: 'missing' } } } }
  const files = ['module.yml', ...readdirSync(join(dir, 'rules')).sort().map(file => 'rules/' + file)]
  const bytes = () => files.map(file => readFileSync(join(dir, file)))
  const before = bytes()
  assert.throws(() => editModuleRules(dir, { expectedRevisions: snapshot.revisions, edits: [{ previousId: 'purge-1', rule: dangling }] }), /unknown after action missing/)
  assert.deepEqual(bytes(), before, '悬空引用在提交前拒绝，定义和全部规则切片零写盘')
  assert.deepEqual(readModuleRules(dir), snapshot)
  assert.throws(() => compileRules([dangling]), /unknown after action missing/)
})

test('来源资产用户覆盖优先，空文件不回退，读取失败明确拒绝', () => {
  const { dir } = fixture()
  const rule = readModuleRules(dir).rules.find(rule => rule.id === 'source-default-prompt-inject')
  const texts = () => compileRules([rule], { moduleId: 'limit-breaker', promptConfigOptions: rulePromptConfigOptions(dir) })[0].actions[0].compiledConfig.texts
  mkdirSync(join(dir, 'assets', 'prompts'), { recursive: true })
  const file = join(dir, 'assets', 'prompts', 'default-prompt-inject.json')
  writeFileSync(file, JSON.stringify({ text: 'USER\r\nBODY' }))
  assert.deepEqual(texts(), ['USER\r\nBODY'])
  writeFileSync(file, JSON.stringify({ text: '' }))
  assert.deepEqual(texts(), [])
  writeFileSync(file, '')
  assert.throws(texts, /JSON|json/, '空JSON不是缺失，不能回退包内')
  writeFileSync(file, Buffer.from([0xff]))
  assert.throws(() => readModuleFile(dir, 'assets/prompts/default-prompt-inject.json'), /UTF-8|utf-8|encoded/i)
  assert.throws(texts, /JSON|json/)
})

test('完整来源资产按分类保真，复制另存及ZIP往返独立维护，用户修改不被补种覆盖', async () => {
  const { root, dir } = fixture()
  const manifest = JSON.parse(readModuleFile(dir, 'assets/manifest.json').content)
  assert.equal(manifest.sources.length, 69)
  assert.equal(manifest.texts.length, 18)
  for (const entry of [...manifest.sources.map(entry => ({ ...entry, path: entry.asset })), ...manifest.texts]) {
    const asset = JSON.parse(readModuleFile(dir, entry.path).content)
    assert.equal(Buffer.byteLength(asset.text), entry.bytes, entry.path)
    assert.equal(createHash('sha256').update(asset.text).digest('hex'), entry.sha256, entry.path)
  }
  const catalog = JSON.parse(readModuleFile(dir, 'assets/source-catalog.json').content)
  assert.equal(catalog.entries.length, 86)
  assert.deepEqual(catalog.entries.filter(entry => entry.category === 'native-restore').map(entry => entry.id).sort((a, b) => a - b), [2, 3, 21, 50, 69, 80, 90])
  assert.deepEqual(catalog.entries.filter(entry => entry.category === 'peripheral-or-compat').map(entry => entry.id).sort((a, b) => a - b), [38, 39, 42, 45, 46, 49, 52, 78, 82, 83, 84, 91, 92])
  assert.ok(catalog.entries.filter(entry => entry.category !== 'core-candidate').every(entry => entry.owner === null && entry.ruleId === null))
  assert.equal(JSON.parse(readModuleFile(dir, 'assets/patches-86.json').content).patches.length, 86)
  const fixed = JSON.parse(readModuleFile(dir, 'assets/fixed-source-manifest.json').content)
  assert.equal(fixed.files, 499)
  assert.equal(fixed.bytes, 7189573)
  for (const entry of manifest.sources) assert.deepEqual(fixed.entries.find(source => source.path === entry.path), Object.fromEntries(Object.entries(entry).filter(([key]) => key !== 'asset')))
  const index = JSON.parse(readModuleFile(dir, 'assets/source-index.json').content)
  for (const entry of [...index.dynamic, ...index.declarations]) assert.ok(manifest.sources.some(source => source.path === entry.file))
  const file = join(dir, 'module.yml')
  const doc = parseDocument(readFileSync(file, 'utf8'))
  doc.set('userExtension', { retain: true })
  writeFileSync(file, doc.toString())
  mkdirSync(join(dir, 'assets', 'prompts'), { recursive: true })
  writeFileSync(join(dir, 'assets', 'prompts', 'default-prompt-inject.json'), JSON.stringify({ text: 'USER\r\nBODY' }))
  writeFileSync(join(dir, 'assets', 'user.txt'), 'USER PRIVATE ASSET')
  const original = readFileSync(file, 'utf8')
  ensureModuleSeed(root)
  assert.equal(readFileSync(file, 'utf8'), original)
  assert.equal(readModuleFile(dir, 'assets/user.txt').content, 'USER PRIVATE ASSET')
  assert.deepEqual(duplicateUserModule('limit-breaker', root), { ok: true, id: 'limit-breaker-copy' })
  const copied = join(root, 'limit-breaker-copy')
  assert.equal(JSON.parse(readModuleFile(copied, 'assets/prompts/default-prompt-inject.json').content).text, 'USER\r\nBODY')
  assert.equal(JSON.parse(readModuleFile(copied, 'assets/prompts/runtime/RETRY_NUDGE.json').content).sha256, '2361f6cd70addf9522dda3734f30ef89bcecb4560ad353c4280992654568c161')
  const exported = await exportModulePackage(root, { id: 'limit-breaker-copy', mode: 'zip' })
  const files = await expandModuleSource([{ path: 'copied.zip', content: exported.content, encoding: 'base64' }])
  const preview = moduleImportPreview(root, files, { targetId: 'portable' })
  const installed = await installModulePackage(root, files, { targetId: 'portable', expectedSourceDigest: preview.sourceDigest, expectedPreviewRevision: preview.previewRevision })
  assert.equal(installed.id, 'portable')
  const restored = readModuleRules(join(root, 'portable'))
  assert.deepEqual(restored.rules, readModuleRules(copied).rules)
  assert.deepEqual(parseDocument(readFileSync(join(root, 'portable', 'module.yml'), 'utf8')).toJS().userExtension, { retain: true })
  for (const entry of manifest.sources) assert.deepEqual(readModuleFile(join(root, 'portable'), entry.asset), readModuleFile(copied, entry.asset))
  assert.equal(readModuleFile(join(root, 'portable'), 'assets/user.txt').content, 'USER PRIVATE ASSET')
  const sameId = await exportModulePackage(root, { id: 'limit-breaker', mode: 'zip' })
  const provided = await expandModuleSource([{ path: 'builtin.zip', content: sameId.content, encoding: 'base64' }])
  assert.deepEqual(provided.map(file => file.path).sort(), ['assets/prompts/default-prompt-inject.json', 'assets/user.txt', 'module.yml'])
  assert.deepEqual(enabledModuleIds(root), [])
  setModuleEnabled(root, 'limit-breaker', true)
  setModuleEnabled(root, 'portable', true)
  setModuleEnabled(root, 'limit-breaker', false)
  setModuleEnabled(root, 'limit-breaker', false)
  assert.deepEqual(enabledModuleIds(root), ['portable'], '启停只改变本模块的参与集合')
  assert.equal(readFileSync(file, 'utf8'), original)
})
