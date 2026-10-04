import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import fs, { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { parse } from 'yaml'
import { isolatedHome } from '../fixtures/host-harness.mjs'

const { moduleRoot } = isolatedHome('pt-package-roundtrip-')
const { moduleImportPreview, installModulePackage, exportModulePackage, expandModuleSource } = await import('../../src/host/module-package.ts')
const { ensureModuleSlices, readRulesDir } = await import('../../src/host/module-storage.ts')
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
const state = dir => ({ definition: readFileSync(join(dir, 'module.yml'), 'utf8'), files: readdirSync(dir).sort() })

test('模块包往返以完整定义为准，漂移切片只在候选重建，素材和变量保持', async () => {
  const id = 'roundtrip-source', dir = fixture(id)
  mkdirSync(join(dir, 'assets'))
  writeFileSync(join(dir, 'assets', 'notice.txt'), 'PACKAGED TEMPLATE')
  const spec = source(id, { rules: [rule('hello', undefined, { templateFile: './assets/notice.txt' })] })
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
    assert.equal(restored.contents[0].then[0].config.templateFile, './assets/notice.txt')
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
  assert.equal((await expandModuleSource(withManifest)).length, files.length)
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
  const provenance = fixture('provenance-source')
  const privateId = 'module-provenance-source-memory'
  fixture('provenance-owner', source('provenance-owner', {
    rules: [rule(privateId, 'POTENTIAL PRIVATE')], configOrder: { [privateId]: 0 },
    meta: { importedCharacters: ['provenance-source'] },
  }))
  const unresolved = await exportModulePackage(moduleRoot, { id: 'provenance-owner', mode: 'definition', preview: true })
  assert.deepEqual(unresolved.memoryConflicts.map(item => item.id), [privateId])
  writeFileSync(join(provenance, 'module.yml'), JSON.stringify(source('provenance-source', { rules: [rule('memory', 'ORDINARY SOURCE')], configOrder: { memory: 0 } })))
  await assert.rejects(exportModulePackage(moduleRoot, { id: 'provenance-owner', mode: 'definition', expectedRevision: unresolved.revision }), error => error.code === 'module-preview-stale', '实际分享来源证明变化使旧确认失效')
})
