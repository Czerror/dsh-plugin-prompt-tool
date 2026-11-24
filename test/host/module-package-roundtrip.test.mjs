import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import fs, { existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isolatedHome } from '../fixtures/host-harness.mjs'

const { home, moduleRoot } = isolatedHome('pt-package-roundtrip-')
const { moduleImportPreview, installModulePackage, exportModulePackage, expandModuleSource } = await import('../../src/host/module-package.ts')
const { ensureModuleSlices, materializeModuleDefinition, assertModuleDefinitionFormat, loadModuleDefinition, readRulesDir, validateModuleDefinitionText } = await import('../../src/host/module-slices.ts')
const { editModuleRules, readModuleRules } = await import('../../src/host/module-rules.ts')
const { duplicateUserModule } = await import('../../src/host/module-catalog.ts')
const { decodeAssetFile } = await import('../../src/host/import-source.ts')
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
const state = dir => readdirSync(dir).sort()

test('模块包往返导出已提交规则、导入以完整定义为准，素材和变量保持', async () => {
  const id = 'roundtrip-source', dir = fixture(id)
  mkdirSync(join(dir, 'assets'))
  writeFileSync(join(dir, 'assets', 'notice.txt'), 'PACKAGED TEMPLATE')
  const spec = source(id, { rules: [{
    ...rule('hello', 'TOP'), if: { scope: { audience: 'main' } },
    then: [...rule('hello', 'TOP').then, { id: 'identity', kind: 'persona', stripDefaultIdentity: 'harness' }],
    else: [{ if: { scope: { audience: 'subagent' } }, then: [{ id: 'nested', kind: 'inject-text', config: { templateFile: './assets/notice.txt' } }],
      else: [{ id: 'fallback', kind: 'inject-text', config: { templateFile: './assets/notice.txt' } }] }],
  }] })
  writeFileSync(join(dir, 'module.yml'), '# owner comment\n' + JSON.stringify(spec))
  materializeModuleDefinition(dir)
  const read = readModuleRules(dir)
  spec.rules[0].then[0].config.text = 'COMMITTED'
  editModuleRules(dir, { expectedRevisions: read.revisions, edits: [{ previousId: 'hello', rule: spec.rules[0] }] })
  writeFileSync(join(dir, 'module.yml'), 'BROKEN EXCHANGE SOURCE')
  writeFileSync(join(dir, 'rules', 'orphan.yml'), 'FORGED SLICE')
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
  assert.equal(readFileSync(join(dir, 'rules', 'orphan.yml'), 'utf8'), 'FORGED SLICE')
  assert.equal(readFileSync(join(dir, 'module.yml'), 'utf8'), 'BROKEN EXCHANGE SOURCE')
  const copy = duplicateUserModule(id, moduleRoot)
  assert.equal(copy.ok, true, JSON.stringify(copy))
  const copiedDefinition = await exportModulePackage(moduleRoot, { id: copy.id, mode: 'definition' })
  assert.match(copiedDefinition.content, /COMMITTED/)
  assert.equal(readFileSync(join(moduleRoot, copy.id, 'memory.md'), 'utf8'), 'PRIVATE MEMORY')
  writeFileSync(join(dir, 'assets', 'notice.txt'), 'NEW TEMPLATE')
  await assert.rejects(exportModulePackage(moduleRoot, { id, mode: 'zip', expectedRevision: preview.revision }), { code: 'module-preview-stale' })
  preview = await exportModulePackage(moduleRoot, { id, mode: 'zip', preview: true })
  const definition = await exportModulePackage(moduleRoot, { id, mode: 'definition' })
  assert.match(definition.content, /owner comment/)
  assert.match(definition.content, /COMMITTED/)
  assert.doesNotMatch(definition.content, /BROKEN EXCHANGE SOURCE|FORGED SLICE/)
  const exported = await exportModulePackage(moduleRoot, { id, mode: 'zip', expectedRevision: preview.revision })
  const files = await expandModuleSource([{ path: 'module.zip', content: exported.content, encoding: 'base64' }])
  assert.deepEqual(files.map(file => file.path).sort(), ['assets/notice.txt', 'module.yml'])
  const plain = await install(files, 'plain-copy')
  const drifted = [...files, { path: 'rules/hello.yml', content: 'id: forged\ndo: []\n' }, { path: 'rules/_settings.yml', content: 'rules: {}\n' }, { path: 'rules/variables.yml', content: 'owner: INJECTED\n' }, { path: 'rules/_commit.json', content: '{}' }, { path: 'rules/.objects/forged.yml', content: 'FORGED OBJECT' }]
  const beforeInput = JSON.stringify(drifted)
  const attached = await install(drifted, 'slice-copy')
  assert.equal(JSON.stringify(drifted), beforeInput, '入站切片从未反向覆盖来源定义或源对象')
  for (const id of [plain.id, attached.id]) {
    const copied = join(moduleRoot, id)
    const restored = readRulesDir(copied)
    assert.equal(restored.contents[0].id, 'hello')
    assert.deepEqual(restored.contents[0].then, spec.rules[0].then)
    assert.deepEqual(restored.contents[0].else, spec.rules[0].else)
    assert.equal(restored.settings.hello.enabled, false)
    assert.equal(restored.settings.hello.order, 40)
    assert.deepEqual(restored.variables, { owner: 'Mia' })
    assert.equal(restored.variablesEnabled, false)
    assert.equal(readFileSync(join(copied, 'assets', 'notice.txt'), 'utf8'), 'NEW TEMPLATE')
    assert.equal(existsSync(join(copied, 'memory.md')), false)
    assert.equal(existsSync(join(copied, 'agent.cordis.yml')), false)
    assert.match((await exportModulePackage(moduleRoot, { id, mode: 'definition' })).content, /owner comment/)
  }
  const manifest = { version: 1, definition: 'module.yml', files: Object.fromEntries(files.map(file => [file.path, createHash('sha256').update(decodeAssetFile(file)).digest('hex')])) }
  const withManifest = [...files, { path: 'prompt-tool-package.json', content: JSON.stringify(manifest) }]
  await assert.rejects(expandModuleSource([...withManifest, { path: 'extra.txt', content: 'undeclared' }]), /集合/)
  await assert.rejects(expandModuleSource(withManifest.map(file => file.path === 'assets/notice.txt' ? { ...file, content: 'TAMPERED', encoding: 'utf8' } : file)), /摘要/)
})

test('安装完整定义后可从提交记录读回原始声明和有序规则切片', async () => {
  const id = 'committed-source'
  const definition = '# original comment\nid: committed-source\nname: committed-source\nmodules: []\nvariables: {}\nvariablesEnabled: false\nconfigOrder: { second: 2, first: 2, future: 9 }\nunknown: &metadata { owner: Mia }\nother: *metadata\nrules:\n  - ' + JSON.stringify(rule('second', 'SECOND')) + '\n  - ' + JSON.stringify(rule('first', 'FIRST')) + '\n'
  await install([{ path: 'module.yml', content: definition }], id)
  const dir = join(moduleRoot, id, 'rules')
  const commit = JSON.parse(readFileSync(join(dir, '_commit.json'), 'utf8'))
  const readObject = (digest) => {
    const content = readFileSync(join(dir, '.objects', digest), 'utf8')
    assert.equal(createHash('sha256').update(content).digest('hex'), digest)
    return content
  }
  assert.equal(commit.version, 1)
  assert.equal(commit.moduleId, id)
  assert.deepEqual(commit.declaredKeys, ['id', 'name', 'modules', 'variables', 'variablesEnabled', 'configOrder', 'unknown', 'other', 'rules'])
  assert.deepEqual(commit.ruleIds, ['second', 'first'])
  const { parse } = await import('yaml')
  assert.deepEqual(parse(readObject(commit.exportBase)), parse(definition))
  assert.match(readObject(commit.exportBase), /original comment/)
  assert.match(readObject(commit.exportBase), /other: \*metadata/)
  assert.deepEqual(parse(readObject(commit.inputs)), {
    id, name: id, modules: [], variables: {}, variablesEnabled: false, configOrder: { second: 2, first: 2, future: 9 },
    unknown: { owner: 'Mia' }, other: { owner: 'Mia' },
  })
  for (const id of commit.ruleIds) assert.equal(parse(readObject(commit.members[id + '.yml'])).id, id)

  const overwrite = [{ path: 'module.yml', content: definition.replace('rules:', 'metadataText: &body SECOND\nrules:').replace('"SECOND"', '*body') }]
  assert.throws(() => moduleImportPreview(moduleRoot, overwrite, { targetId: id, overwrite: true }),
    error => error.code === 'shared-alias' && /metadataText → rules/.test(error.message))
  assert.deepEqual(JSON.parse(readFileSync(join(dir, '_commit.json'), 'utf8')), commit)
  for (const id of commit.ruleIds) assert.equal(parse(readObject(commit.members[id + '.yml'])).id, id)
})

test('同名包内模板回退只接受缺失资产，用户覆盖和包内变更使缓存失效', () => {
  const packageRoot = join(home, 'packaged-modules')
  const sourcePackageRoot = resolve(fileURLToPath(new URL('../../src/modules/', import.meta.url)))
  const id = 'asset-fallback'
  const dir = fixture(id, source(id, { rules: [rule('hello', 'SOURCE', { templateFile: './assets/notice.json' })] }))
  const packaged = join(packageRoot, id)
  mkdirSync(join(packaged, 'assets'), { recursive: true })
  const packageDefinition = join(packaged, 'module.yml')
  writeFileSync(packageDefinition, JSON.stringify({ id }))
  const packageAsset = join(packaged, 'assets', 'notice.json')
  writeFileSync(packageAsset, '"PACKAGE"')

  // 包目录解析到临时夹具，后续模板路径与文件内容仍由真实文件系统检查。
  for (const name of ['existsSync', 'lstatSync', 'realpathSync']) {
    const original = fs[name]
    mock.method(fs, name, (path, ...args) => original(
      typeof path === 'string' && resolve(path) === sourcePackageRoot ? packageRoot : path, ...args))
  }
  syncBuiltinESMExports()
  try {
    writeFileSync(packageDefinition, JSON.stringify({ id: 'other-module' }))
    assert.throws(() => materializeModuleDefinition(dir), /身份不匹配/)
    writeFileSync(packageDefinition, JSON.stringify({ id }))
    materializeModuleDefinition(dir)
    const fallback = ensureModuleSlices(dir)
    assertModuleDefinitionFormat(dir)
    mkdirSync(join(dir, 'assets'))
    const localAsset = join(dir, 'assets', 'notice.json')
    writeFileSync(localAsset, '')
    assert.throws(() => validateModuleDefinitionText(dir, fallback.text, {}, fallback), { code: 'rules-conflict' })
    assert.throws(() => loadModuleDefinition(dir), /not valid JSON/)

    writeFileSync(localAsset, '"USER"')
    writeFileSync(packageDefinition, JSON.stringify({ id: 'other-module' }))
    const override = ensureModuleSlices(dir)
    assertModuleDefinitionFormat(dir)
    writeFileSync(packageDefinition, JSON.stringify({ id }))
    rmSync(localAsset)
    assert.throws(() => validateModuleDefinitionText(dir, override.text, {}, override), { code: 'rules-conflict' })
    ensureModuleSlices(dir)
    assertModuleDefinitionFormat(dir)
    writeFileSync(packageAsset, 'INVALID')
    assert.throws(() => loadModuleDefinition(dir), /not valid JSON/)

    writeFileSync(packageAsset, '"PACKAGE"')
    ensureModuleSlices(dir)
    assertModuleDefinitionFormat(dir)
    rmdirSync(join(dir, 'assets'))
    symlinkSync(join(packaged, 'assets'), join(dir, 'assets'), 'junction')
    assert.throws(() => loadModuleDefinition(dir), /包含链接/)
  } finally { mock.restoreAll(); syncBuiltinESMExports() }
})

test('模块私有 data/ 不随包导出；覆盖安装旧数据优先，包内只补缺失', async () => {
  const id = 'data-keep', dir = fixture(id)
  mkdirSync(join(dir, 'data'))
  writeFileSync(join(dir, 'data', 'ledger.jsonl'), 'OLD LEDGER\n')
  materializeModuleDefinition(dir)
  writeFileSync(join(dir, 'module.yml'), 'BROKEN EXCHANGE SOURCE')

  const preview = await exportModulePackage(moduleRoot, { id, mode: 'zip', preview: true })
  const exported = await exportModulePackage(moduleRoot, { id, mode: 'zip', expectedRevision: preview.revision })
  const files = await expandModuleSource([{ path: 'module.zip', content: exported.content, encoding: 'base64' }])
  assert.deepEqual(files.map(file => file.path).sort(), ['module.yml'], 'data/ 不随包分享')

  const packaged = [
    { path: 'module.yml', content: JSON.stringify(source('data-keep')) },
    { path: 'data/ledger.jsonl', content: '{"type":"packaged"}\n' },
    { path: 'data/new.txt', content: 'PACKAGED NEW' },
  ]
  const overwritePreview = moduleImportPreview(moduleRoot, packaged, { targetId: 'data-keep', overwrite: true })
  await installModulePackage(moduleRoot, packaged, { ...credentials(overwritePreview), overwrite: true })
  assert.equal(readFileSync(join(moduleRoot, 'data-keep', 'data', 'ledger.jsonl'), 'utf8'), 'OLD LEDGER\n', '旧账本不被覆盖')
  assert.equal(readFileSync(join(moduleRoot, 'data-keep', 'data', 'new.txt'), 'utf8'), 'PACKAGED NEW', '包内只补缺失')
})

test('覆盖安装拒绝 data/ 内的链接', async () => {
  const id = 'data-link', dir = fixture(id)
  mkdirSync(join(moduleRoot, '..', 'outside-data-link'), { recursive: true })
  mkdirSync(join(dir, 'data'))
  symlinkSync(join(moduleRoot, '..', 'outside-data-link'), join(dir, 'data', 'linked'), 'junction')
  const files = [{ path: 'module.yml', content: JSON.stringify(source(id)) }]
  await assert.rejects(async () => {
    const preview = moduleImportPreview(moduleRoot, files, { targetId: id, overwrite: true })
    await installModulePackage(moduleRoot, files, { ...credentials(preview), overwrite: true })
  }, /链接|link/)
})
