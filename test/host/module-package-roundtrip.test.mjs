import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import fs, { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { parse, parseDocument } from 'yaml'
import { isolatedHome } from '../fixtures/host-harness.mjs'

const { moduleRoot } = isolatedHome('pt-package-roundtrip-')
const { moduleImportPreview, installModulePackage, exportModulePackage, expandModuleSource } = await import('../../src/host/module-package.ts')
const { ensureModuleSlices, readRulesDir } = await import('../../src/host/module-slices.ts')
const { decodeAssetFile } = await import('../../src/host/import-source.ts')
const { mergeModuleIntoModule, removeMergedModule } = await import('../../src/host/characters.ts')
const { ruleInjections } = await import('../../src/host/rule-content.ts')
const { mergeStModulesWithReport } = await import('../../src/host/sillytavern.ts')
const rule = (id, text, extra = {}) => ({ id, enabled: false, then: [{ id: 'inject', kind: 'inject-text', config: { text, ...extra } }] })
const source = (id, extra = {}) => ({ id, name: id, modules: [], rules: [rule('hello', 'SOURCE')], variables: { owner: 'Mia' }, variablesEnabled: false, configOrder: { hello: 40 }, ...extra })
function fixture(id, value = source(id)) {
  const dir = join(moduleRoot, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'module.yml'), '# owner comment\n' + JSON.stringify(value))
  return dir
}
const credentials = preview => ({ targetId: preview.summary.targetId, overwrite: preview.summary.exists, expectedSourceDigest: preview.sourceDigest, expectedPreviewRevision: preview.previewRevision })
async function install(files, targetId) {
  const preview = moduleImportPreview(moduleRoot, files, { targetId })
  return installModulePackage(moduleRoot, files, credentials(preview))
}
const state = dir => ({ definition: readFileSync(join(dir, 'module.yml'), 'utf8'), files: readdirSync(dir).sort() })

test('完整分支模块并入、导出读回与重复并入保留原始载荷和稳定身份', async () => {
  const origin = 'branch-source', target = 'branch-target'
  const leaf = (id, config) => ({ id, kind: 'inject-text', config })
  const branch = {
    id: 'branches', enabled: false, if: { scope: { audience: 'main' } },
    then: [
      leaf('top', { id: 'explicit-top', text: 'TOP' }),
      { if: { scope: { audience: 'main' } }, then: [leaf('nested', { text: 'NESTED' })],
        else: [leaf('nested-else', { text: 'NESTED ELSE', params: { custom: { untouched: true } } })] },
    ],
    else: [leaf('fallback', { id: null, text: 'ELSE' })],
  }
  fixture(origin, source(origin, { rules: [branch], configOrder: { branches: 10 }, variablesEnabled: true }))
  const targetDir = fixture(target)
  const annotated = parseDocument(readFileSync(join(targetDir, 'module.yml'), 'utf8'))
  annotated.getIn(['rules', 0, 'then', 0, 'config', 'text'], true).comment = ' target rule comment'
  writeFileSync(join(targetDir, 'module.yml'), annotated.toString())
  const own = parse(readFileSync(join(targetDir, 'module.yml'), 'utf8')).rules[0]
  const expected = {
    ...branch, id: 'module-branch-source-branches',
    then: [
      leaf('top', { id: 'module-branch-source-explicit-top', text: 'TOP' }),
      { if: { scope: { audience: 'main' } }, then: [leaf('nested', { text: 'NESTED' })],
        else: [leaf('nested-else', { text: 'NESTED ELSE', params: { custom: { untouched: true } } })] },
    ],
    else: [leaf('fallback', { id: null, text: 'ELSE' })],
  }
  const applied = mergeModuleIntoModule(moduleRoot, target, origin)
  assert.equal(applied.ok, true, applied.message)
  const once = parse(readFileSync(join(targetDir, 'module.yml'), 'utf8'))
  assert.deepEqual(once.variables, { owner: 'Mia' }, '变量提升到模块真值且保留现有值')
  assert.deepEqual(once.rules, [own, expected], '并入只映射显式身份与变量，不写回编译默认值或展开条件')
  assert.match(readFileSync(join(targetDir, 'module.yml'), 'utf8'), /target rule comment/)
  assert.deepEqual(ruleInjections([once.rules[1]]).map(({ config }) => config.id), [
    'module-branch-source-explicit-top', 'rule:module-branch-source-branches:nested',
    'rule:module-branch-source-branches:nested-else', 'rule:module-branch-source-branches:fallback',
  ])
  assert.equal(mergeModuleIntoModule(moduleRoot, target, origin).ok, true)
  assert.deepEqual(parse(readFileSync(join(targetDir, 'module.yml'), 'utf8')).rules, once.rules)
  const exported = await exportModulePackage(moduleRoot, { id: target, mode: 'zip' })
  const files = await expandModuleSource([{ path: 'module.zip', content: exported.content, encoding: 'base64' }])
  const restored = await install(files, 'branch-copy')
  const copied = readFileSync(join(moduleRoot, restored.id, 'module.yml'), 'utf8')
  assert.deepEqual(parse(copied).rules, once.rules)
  assert.match(copied, /owner comment/)
  assert.match(copied, /target rule comment/)
  assert.equal(removeMergedModule(moduleRoot, target, origin).ok, true)
  assert.deepEqual(parse(readFileSync(join(targetDir, 'module.yml'), 'utf8')).rules, [own])
  assert.match(readFileSync(join(targetDir, 'module.yml'), 'utf8'), /target rule comment/)
  const imported = source(origin, { rules: [branch], configOrder: { branches: 10 }, variablesEnabled: true })
  const merged = mergeStModulesWithReport([imported, imported])
  assert.deepEqual([...merged.idMap.values()].map(ids => ids.get(0)), ['branches', 'branches-2'])
  assert.deepEqual(merged.spec.variables, { owner: 'Mia' })
  assert.equal(merged.spec.rules[0].then[0].config.variables, undefined)
  assert.deepEqual(ruleInjections(merged.spec.rules).map(({ config }) => config.id), [
    'explicit-top', 'rule:branches:nested', 'rule:branches:nested-else', 'rule:branches:fallback',
    'explicit-top-2', 'rule:branches-2:nested', 'rule:branches-2:nested-else', 'rule:branches-2:fallback',
  ])
  assert.ok(moduleImportPreview(moduleRoot, [{ path: 'module.yml', content: JSON.stringify(merged.spec) }], {}).prepared)
  assert.deepEqual(imported.rules, [branch], '导入组合不修改来源规则')
  assert.throws(() => mergeStModulesWithReport([imported, { ...imported, variables: { owner: 'OTHER' } }]), /模块变量 owner.*不同值/)
})

test('模块包往返以完整定义为准，漂移切片只在候选重建，素材和变量保持', async () => {
  const id = 'roundtrip-source', dir = fixture(id)
  mkdirSync(join(dir, 'assets'))
  writeFileSync(join(dir, 'assets', 'notice.txt'), 'PACKAGED TEMPLATE')
  const spec = source(id, { rules: [{
    ...rule('hello', 'TOP'), if: { scope: { audience: 'main' } },
    else: [{ if: { scope: { audience: 'subagent' } }, then: [{ id: 'nested', kind: 'inject-text', config: { templateFile: './assets/notice.txt' } }],
      else: [{ id: 'fallback', kind: 'inject-text', config: { templateFile: './assets/notice.txt' } }] }],
  }] })
  writeFileSync(join(dir, 'module.yml'), '# owner comment\n' + JSON.stringify(spec))
  ensureModuleSlices(dir)
  writeFileSync(join(dir, 'rules', 'hello.yml'), 'FORGED SLICE')
  writeFileSync(join(dir, 'memory.md'), 'PRIVATE MEMORY')
  const before = state(dir)
  const writes = []
  for (const name of ['writeFileSync', 'mkdirSync', 'rmSync', 'rmdirSync', 'renameSync']) mock.method(fs, name, (...args) => { writes.push(name); throw new Error('预览写盘：' + args[0]) })
  syncBuiltinESMExports()
  let preview
  try { preview = await exportModulePackage(moduleRoot, { id, mode: 'zip', preview: true }) }
  finally { mock.restoreAll(); syncBuiltinESMExports() }
  assert.deepEqual(writes, [])
  assert.deepEqual(state(dir), before)
  assert.equal(readFileSync(join(dir, 'rules', 'hello.yml'), 'utf8'), 'FORGED SLICE')
  const exported = await exportModulePackage(moduleRoot, { id, mode: 'zip', expectedRevision: preview.revision })
  const files = await expandModuleSource([{ path: 'module.zip', content: exported.content, encoding: 'base64' }])
  assert.deepEqual(files.map(file => file.path).sort(), ['assets/notice.txt', 'module.yml'])
  const plain = await install(files, 'plain-copy')
  const drifted = [...files, { path: 'rules/hello.yml', content: 'id: forged\ndo: []\n' }, { path: 'rules/_settings.yml', content: 'rules: {}\n' }, { path: 'rules/variables.yml', content: 'owner: INJECTED\n' }]
  const beforeInput = JSON.stringify(drifted)
  const attached = await install(drifted, 'slice-copy')
  assert.equal(JSON.stringify(drifted), beforeInput, '入站切片从未反向覆盖来源定义或源对象')
  for (const id of [plain.id, attached.id]) {
    const copied = join(moduleRoot, id)
    const restored = readRulesDir(copied)
    assert.equal(restored.contents[0].id, 'hello')
    assert.deepEqual(restored.contents[0].else, spec.rules[0].else)
    assert.equal(restored.settings.hello.enabled, false)
    assert.equal(restored.settings.hello.order, 40)
    assert.deepEqual(restored.variables, { owner: 'Mia' })
    assert.equal(restored.variablesEnabled, false)
    assert.equal(readFileSync(join(copied, 'assets', 'notice.txt'), 'utf8'), 'PACKAGED TEMPLATE')
    assert.equal(existsSync(join(copied, 'memory.md')), false)
    assert.equal(existsSync(join(copied, 'agent.cordis.yml')), false)
    assert.match(readFileSync(join(copied, 'module.yml'), 'utf8'), /owner comment/)
  }
  const manifest = { version: 1, definition: 'module.yml', files: Object.fromEntries(files.map(file => [file.path, createHash('sha256').update(decodeAssetFile(file)).digest('hex')])) }
  const withManifest = [...files, { path: 'prompt-tool-package.json', content: JSON.stringify(manifest) }]
  await assert.rejects(expandModuleSource([...withManifest, { path: 'extra.txt', content: 'undeclared' }]), /集合/)
  await assert.rejects(expandModuleSource(withManifest.map(file => file.path === 'assets/notice.txt' ? { ...file, content: 'TAMPERED', encoding: 'utf8' } : file)), /摘要/)
})

test('语义无效源在预览、安装、导出共同拒绝，模板预览只读取上传文件', async () => {
  mkdirSync(moduleRoot, { recursive: true })
  const invalid = [
    { rules: [{ id: 'hello', then: [{ id: 'x', kind: 'not-an-action' }] }] },
    { rules: [rule('variables', 'RESERVED')] },
    { configOrder: { hello: -1 } },
    { variables: { owner: 1 } },
    { variablesEnabled: 'false' },
    { rules: [{ ...rule('hello', 'TOP'), if: { scope: { audience: 'main' } }, else: [{ id: 'inject', kind: 'inject-text', config: { text: 'DUPLICATE' } }] }] },
    { rules: [{ ...rule('hello', 'TOP', { id: 'same-config' }), if: { scope: { audience: 'main' } }, else: [{ id: 'other', kind: 'inject-text', config: { id: 'same-config', text: 'DUPLICATE' } }] }] },
  ]
  for (const [index, extra] of invalid.entries()) {
    const id = 'invalid-' + index, spec = source(id, extra)
    const dir = fixture(id, spec), before = state(dir)
    const files = [{ path: 'module.yml', content: JSON.stringify(spec) }]
    assert.throws(() => moduleImportPreview(moduleRoot, files, { targetId: id }))
    await assert.rejects(installModulePackage(moduleRoot, files, { targetId: id, overwrite: true, expectedSourceDigest: '0'.repeat(64), expectedPreviewRevision: '0'.repeat(64) }))
    for (const mode of ['definition', 'zip']) await assert.rejects(exportModulePackage(moduleRoot, { id, mode, preview: true }))
    assert.deepEqual(state(dir), before)
    assert.equal(existsSync(join(dir, 'rules')), false)
  }
  const id = 'template-preview', dir = fixture(id)
  writeFileSync(join(dir, 'secret.txt'), 'REAL TARGET MUST NOT FILL UPLOAD')
  const candidate = source(id, { rules: [rule('hello', undefined, { templateFile: './secret.txt' })] })
  const files = [{ path: 'module.yml', content: JSON.stringify(candidate) }]
  assert.throws(() => moduleImportPreview(moduleRoot, files, { targetId: id }), /缺失|missing|资源/)
  files.push({ path: 'secret.txt', content: 'UPLOAD CONTENT' })
  const before = state(dir)
  const writes = []
  for (const name of ['writeFileSync', 'mkdirSync', 'rmSync', 'rmdirSync', 'renameSync']) mock.method(fs, name, () => { writes.push(name); throw new Error('预览不得写盘') })
  syncBuiltinESMExports()
  try { assert.ok(moduleImportPreview(moduleRoot, files, { targetId: id }).prepared) }
  finally { mock.restoreAll(); syncBuiltinESMExports() }
  assert.deepEqual(writes, [])
  assert.deepEqual(state(dir), before)
  candidate.rules[0].then[0].config.templateFile = '../outside.txt'
  assert.throws(() => moduleImportPreview(moduleRoot, [{ path: 'module.yml', content: JSON.stringify(candidate) }], { targetId: id }), /外部|越界|资源/)
  const nestedSource = fixture('nested-external', source('nested-external', { rules: [{
    ...rule('hello', 'TOP'), if: { scope: { audience: 'main' } },
    else: [{ if: { scope: { audience: 'subagent' } }, then: [{ id: 'external', kind: 'inject-text', config: { text: 'EXTERNAL', params: { file: '../private.md' } } }] }],
  }] }))
  const sourceBefore = state(nestedSource), targetBefore = state(dir)
  const rejected = mergeModuleIntoModule(moduleRoot, id, 'nested-external')
  assert.equal(rejected.ok, false)
  assert.match(rejected.message, /params\.file.*外部文件/)
  assert.deepEqual(state(nestedSource), sourceBefore)
  assert.deepEqual(state(dir), targetBefore)
})

test('不分享的切片和记忆不读、不影响导出版本；定义模式可携缺附件告警', async () => {
  const id = 'excluded-assets', dir = fixture(id)
  ensureModuleSlices(dir)
  writeFileSync(join(dir, 'memory.md'), 'PRIVATE')
  writeFileSync(join(dir, 'agent.cordis.yml'), 'OLD')
  const originalRead = fs.readFileSync
  const read = mock.method(fs, 'readFileSync', (file, ...args) => {
    const path = String(file).replaceAll('\\', '/')
    if (path.startsWith(dir.replaceAll('\\', '/') + '/rules/') || path.endsWith('/memory.md') || path.endsWith('/agent.cordis.yml')) throw new Error('不可读取非分享内容')
    return originalRead(file, ...args)
  })
  syncBuiltinESMExports()
  let preview
  try { preview = await exportModulePackage(moduleRoot, { id, mode: 'zip', preview: true }) }
  finally { read.mock.restore(); syncBuiltinESMExports() }
  writeFileSync(join(dir, 'rules', 'hello.yml'), 'DRIFT')
  writeFileSync(join(dir, 'memory.md'), 'NEW PRIVATE')
  const downloaded = await exportModulePackage(moduleRoot, { id, mode: 'zip', expectedRevision: preview.revision })
  assert.equal(downloaded.revision, preview.revision)
  const missing = 'missing-template'
  fixture(missing, source(missing, { rules: [rule('hello', undefined, { templateFile: './absent.txt' })] }))
  const definition = await exportModulePackage(moduleRoot, { id: missing, mode: 'definition' })
  assert.equal(parse(definition.content).rules[0].then[0].config.templateFile, './absent.txt')
  assert.ok(definition.warnings.some(warning => warning.includes('absent.txt')))
  const blocked = await exportModulePackage(moduleRoot, { id: missing, mode: 'zip', preview: true })
  assert.ok(blocked.blockers.some(warning => warning.includes('absent.txt')))
  await assert.rejects(exportModulePackage(moduleRoot, { id: missing, mode: 'zip' }), /absent.txt/)
  fixture('provenance-source')
  const privateId = 'module-provenance-source-memory'
  fixture('provenance-owner', source('provenance-owner', {
    rules: [rule(privateId, 'POTENTIAL PRIVATE')], configOrder: { [privateId]: 0 },
    meta: { importedCharacters: ['provenance-source'] },
  }))
  const privateFile = join(moduleRoot, 'provenance-owner', 'module.yml')
  const original = readFileSync(privateFile, 'utf8')
  for (const mode of ['definition', 'zip']) await assert.rejects(exportModulePackage(moduleRoot, { id: 'provenance-owner', mode }), /私有记忆|显式转换/, '来源不明的私有记忆不得进入任何分享包')
  assert.equal(readFileSync(privateFile, 'utf8'), original, '拒绝导出不改用户定义')
})
