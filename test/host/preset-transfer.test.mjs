import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { join } from 'node:path'
import { syncBuiltinESMExports } from 'node:module'
import { Readable } from 'node:stream'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { ZipWriter, Uint8ArrayWriter, Uint8ArrayReader } from '@zip.js/zip.js'
import { parse } from 'yaml'

const home = fs.mkdtempSync(join(process.cwd(), 'pt-transfer-'))
process.env.DSH_HOME = home
const { expandPresetSource, presetImportPreview, installPresetPackage, exportPresetPackage } = await import('../../src/host/preset-package.ts')
const { unpackZip, MAX_ASSET_BYTES } = await import('../../src/host/asset-archive.ts')
const { createAssetSources } = await import('../../src/host/asset-sources.ts')
const { importCharacterCard, appendCharacterMemory, applyCharacterToPreset } = await import('../../src/host/characters.ts')
const { duplicateUserPreset } = await import('../../src/host/manifest.ts')
test.after(() => fs.rmSync(home, { recursive: true, force: true }))
const root = () => fs.mkdtempSync(join(home, 'presets-'))
const source = (id = 'demo', extra = '') => [{ path: 'preset.yml', content: `# retain\nid: ${id}\nname: 示例\nmodules: []\n${extra}` }]
async function install(dir, files, choices = {}) {
  const preview = presetImportPreview(dir, files, choices)
  assert.ok(preview.prepared)
  return installPresetPackage(dir, files, { ...choices, targetId: preview.summary.targetId, expectedSourceDigest: preview.sourceDigest, expectedPreviewRevision: preview.previewRevision })
}

test('原生 JSON 不走 ST 转换；文件夹附件字节与正文保留，ZIP 跨根往返', async () => {
  const from = root()
  const picture = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00])
  const files = await expandPresetSource([
    { path: 'folder/native.json', content: JSON.stringify({ id: 'native', name: '原生', modules: ['prompt-config-engine'], layerSettings: { 'pre-step': { injectPrompt: false }, 'system-section': { bootstrapMaxTokens: 0 } }, promptConfigs: [{ id: 'p', layer: 'pre-step', text: 'KEPT' }], unknown: 'kept' }) },
    { path: 'folder/preset.md', content: '原始正文\r\n' },
    { path: 'folder/assets/avatar.png', encoding: 'base64', content: picture.toString('base64') },
    { path: 'folder/engine/custom.mjs', content: 'export default {}' },
  ])
  await install(from, files)
  assert.equal(parse(fs.readFileSync(join(from, 'native/preset.yml'), 'utf8')).promptConfigs[0].text, 'KEPT')
  assert.deepEqual(fs.readFileSync(join(from, 'native/assets/avatar.png')), picture)
  const archive = await exportPresetPackage(from, { id: 'native', mode: 'zip' })
  const to = root()
  await install(to, await expandPresetSource([{ path: 'native.zip', encoding: 'base64', content: archive.content }]))
  assert.equal(fs.readFileSync(join(to, 'native/preset.md'), 'utf8'), '原始正文\r\n')
  assert.deepEqual(fs.readFileSync(join(to, 'native/assets/avatar.png')), picture)
  assert.equal(fs.readFileSync(join(to, 'native/engine/custom.mjs'), 'utf8'), 'export default {}')
  assert.equal(parse(fs.readFileSync(join(to, 'native/preset.yml'), 'utf8')).unknown, 'kept')
  assert.deepEqual(parse(fs.readFileSync(join(to, 'native/preset.yml'), 'utf8')).layerSettings,
    { 'pre-step': { injectPrompt: false }, 'system-section': { bootstrapMaxTokens: 0 } })
})

test('未预览、过期、未确认覆盖均不写目标；另存不会选择原 ID', async () => {
  const dir = root()
  await assert.rejects(installPresetPackage(dir, source(), {}), /预览/)
  await install(dir, source())
  const before = fs.readFileSync(join(dir, 'demo/preset.yml'), 'utf8')
  const next = source('demo', 'description: new\n')
  const preview = presetImportPreview(dir, next, { targetId: 'demo', overwrite: true })
  fs.appendFileSync(join(dir, 'demo/preset.yml'), '# external\n')
  await assert.rejects(installPresetPackage(dir, next, { targetId: 'demo', overwrite: true, expectedSourceDigest: preview.sourceDigest, expectedPreviewRevision: preview.previewRevision }), /过期/)
  assert.ok(fs.readFileSync(join(dir, 'demo/preset.yml'), 'utf8').startsWith(before))
  assert.equal(presetImportPreview(dir, next, {}).summary.targetId, 'demo-copy')
})

test('坏工具不得被 writer 跳过；候选只读自己的 templateFile', async () => {
  const dir = root()
  await assert.rejects(install(dir, source('bad', 'customTools:\n  - id: bad\n')), /output|schema|execute/)
  assert.equal(fs.existsSync(join(dir, 'bad')), false)
  const files = [...source('templated', 'promptConfigs:\n  - id: t\n    layer: pre-step\n    templateFile: ../templated/assets/t.txt\n'), { path: 'assets/t.txt', content: 'CANDIDATE' }]
  await install(dir, files)
  assert.equal(fs.readFileSync(join(dir, 'templated/assets/t.txt'), 'utf8'), 'CANDIDATE')
  await assert.rejects(install(dir, source('missing', 'promptConfigs:\n  - id: t\n    templateFile: ../templated/assets/t.txt\n')), /不属于目标/)
})

test('候选最终 rename 失败恢复原目录，不原地混合更新', async () => {
  const dir = root()
  await install(dir, source())
  const original = fs.readFileSync(join(dir, 'demo/preset.yml'))
  const rename = fs.renameSync
  fs.renameSync = (from, to) => {
    if (to === join(dir, 'demo') && !String(from).endsWith('previous')) throw Object.assign(new Error('busy'), { code: 'EBUSY' })
    return rename(from, to)
  }
  syncBuiltinESMExports()
  try { await assert.rejects(install(dir, source('demo', 'description: changed\n'), { targetId: 'demo', overwrite: true }), /busy/) }
  finally { fs.renameSync = rename; syncBuiltinESMExports() }
  assert.deepEqual(fs.readFileSync(join(dir, 'demo/preset.yml')), original)
})

async function zip(entries) {
  const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false })
  for (const [path, bytes, options] of entries) await writer.add(path, new Uint8ArrayReader(bytes), options)
  return writer.close()
}
test('ZIP 拒绝上跳、大小写冲突、链接、损坏及解压超限', async () => {
  const data = Buffer.from('id: demo\nmodules: []\n')
  for (const entries of [
    [['../preset.yml', data]],
    [['Preset.yml', data], ['preset.yml', data]],
    [['link', data, { unixMode: 0o120777 }]],
  ]) await assert.rejects(unpackZip(await zip(entries)))
  await assert.rejects(unpackZip(Buffer.from('not zip')))
  const bomb = await zip([['large.txt', new Uint8Array(MAX_ASSET_BYTES + 1)]])
  await assert.rejects(unpackZip(bomb), /大小/)
})

test('ZIP 清单不能掩盖文件缺失或篡改', async () => {
  const manifest = JSON.stringify({ version: 1, definition: 'preset.yml', files: { 'preset.yml': 'wrong' } })
  const bytes = await zip([['demo/preset.yml', Buffer.from('id: demo\nmodules: []\n')], ['demo/prompt-tool-package.json', Buffer.from(manifest)]])
  await assert.rejects(expandPresetSource([{ path: 'demo.zip', encoding: 'base64', content: Buffer.from(bytes).toString('base64') }]), /摘要/)
})

test('导出校验 ID／目录并排除独立指令；定义模式说明附件缺失', async () => {
  const dir = root()
  await install(dir, [...source(), { path: 'preset.md', content: 'BODY' }])
  fs.writeFileSync(join(dir, 'demo/AGENTS.md'), 'PRIVATE-INSTRUCTIONS')
  await assert.rejects(exportPresetPackage(dir, { id: '../demo', mode: 'zip' }), /id/)
  const definition = await exportPresetPackage(dir, { id: 'demo', preview: true })
  assert.ok(definition.warnings.some(warning => warning.includes('附属文件')))
  const archive = await exportPresetPackage(dir, { id: 'demo', mode: 'zip' })
  const entries = await unpackZip(Buffer.from(archive.content, 'base64'))
  assert.ok(entries.every(entry => !Buffer.from(entry.content, 'base64').toString().includes('PRIVATE-INSTRUCTIONS')))
})

test('上传只暂存；来源句柄不可跨实例使用，释放与 dispose 后失效', async () => {
  const dir = root()
  const sources = createAssetSources(join(dir, '.uploads'))
  const other = createAssetSources(join(dir, '.other'))
  try {
    const upload = await sources.upload('card.json', Readable.from([Buffer.from('{"name":"Card"}')]))
    assert.equal(upload.bytes, 15)
    assert.throws(() => other.read(upload.sourceId), /不存在/)
    assert.deepEqual(Buffer.from(sources.read(upload.sourceId)[0].content, 'base64'), Buffer.from('{"name":"Card"}'))
    assert.equal(sources.release(upload.sourceId), true)
    assert.throws(() => sources.read(upload.sourceId), /不存在/)
    assert.equal(fs.existsSync(join(dir, 'card')), false)
  } finally { sources.dispose(); other.dispose() }
})

test('两种分享出口均排除自动记忆，普通同名配置和磁盘原文不丢失', async () => {
  const dir = root()
  await install(dir, source())
  const card = importCharacterCard(dir, [{ path: 'converted.yml', content: 'id: keeper\nname: Keeper\nmodules: []\npromptConfigs:\n  - id: memory\n    layer: pre-step\n    text: ORDINARY-CONTENT\n' }])
  assert.equal(card.ok, true, card.message)
  appendCharacterMemory(dir, card.id, 'PRIVATE-MEMORY')
  assert.equal(applyCharacterToPreset(dir, 'demo', card.id).ok, true)
  const before = fs.readFileSync(join(dir, 'demo/preset.yml'))
  const yaml = await exportPresetPackage(dir, { id: 'demo', mode: 'definition' })
  assert.ok(yaml.content.includes('ORDINARY-CONTENT'))
  assert.ok(!yaml.content.includes('PRIVATE-MEMORY'))
  const archive = await exportPresetPackage(dir, { id: 'demo', mode: 'zip' })
  for (const file of await unpackZip(Buffer.from(archive.content, 'base64'))) assert.ok(!Buffer.from(file.content, 'base64').toString().includes('PRIVATE-MEMORY'))
  assert.deepEqual(fs.readFileSync(join(dir, 'demo/preset.yml')), before)
})

test('缺少来源证明的旧记忆必须明确选择，目标变化使导出预览失效', async () => {
  const dir = root()
  await install(dir, source('legacy', 'meta:\n  importedCharacters: [missing]\npromptConfigs:\n  - id: chara-missing-memory\n    layer: pre-step\n    text: UNCERTAIN\n'))
  const preview = await exportPresetPackage(dir, { id: 'legacy', mode: 'definition', preview: true })
  assert.equal(preview.memoryConflicts.length, 1)
  await assert.rejects(exportPresetPackage(dir, { id: 'legacy' }), /记忆/)
  const included = await exportPresetPackage(dir, { id: 'legacy', memoryChoices: { 'chara-missing-memory': 'include' } })
  assert.ok(included.content.includes('UNCERTAIN'))
  const excluded = await exportPresetPackage(dir, { id: 'legacy', memoryChoices: { 'chara-missing-memory': 'exclude' } })
  assert.ok(!excluded.content.includes('UNCERTAIN'))
  fs.appendFileSync(join(dir, 'legacy/preset.yml'), '# CHANGED\n')
  await assert.rejects(exportPresetPackage(dir, { id: 'legacy', expectedRevision: included.revision, memoryChoices: { 'chara-missing-memory': 'include' } }), /过期/)
})

test('复制及导入另存同步自有模板引用，导出副本不再依赖原预设', async () => {
  const dir = root()
  const files = [...source('original', 'promptConfigs:\n  - id: t\n    layer: pre-step\n    templateFile: ../original/assets/t.txt\n'), { path: 'assets/t.txt', content: 'TEMPLATE' }]
  await install(dir, files)
  const copy = duplicateUserPreset('original', dir)
  assert.equal(copy.ok, true, copy.message)
  assert.equal(parse(fs.readFileSync(join(dir, copy.id, 'preset.yml'), 'utf8')).promptConfigs[0].templateFile, `../${copy.id}/assets/t.txt`)
  // 共享引擎自阶段 2 起由插件包提供：组合行写包名说明符，副本不指向任何 `.engine/` 物化目录。
  const compositionRow = (presetDir) => parse(fs.readFileSync(join(presetDir, 'agent.cordis.yml'), 'utf8'))[0]
  assert.equal(compositionRow(join(dir, copy.id)).name, 'dsh-plugin-prompt-tool/engine/prompt-config-engine.mjs')
  assert.deepEqual(
    compositionRow(join(dir, copy.id)).config,
    { configsDir: `../${copy.id}/prompt-configs` },
    '副本的受管配置位置必须改写到自身 id——包名说明符行同样要过改写，否则副本会读原预设的 prompt-configs',
  )
  const exported = await exportPresetPackage(dir, { id: copy.id, mode: 'zip' })
  const entries = await unpackZip(Buffer.from(exported.content, 'base64'))
  assert.ok(
    entries.every(entry => !/(^|\/)\.engine\//.test(entry.path) && !entry.path.endsWith('/engine/prompt-config-engine.mjs')),
    '导出包既不携带共享引擎，也不再出现 .engine 目录',
  )
  const to = root()
  await install(to, await expandPresetSource([{ path: 'copy.zip', encoding: 'base64', content: exported.content }]), { targetId: 'renamed' })
  assert.equal(parse(fs.readFileSync(join(to, 'renamed/preset.yml'), 'utf8')).promptConfigs[0].templateFile, '../renamed/assets/t.txt')
  // 另存后的组合只引用包内引擎，且受管配置位置指向自己：不依赖原预设，也不依赖物化引擎目录。
  assert.deepEqual(compositionRow(join(to, 'renamed')).config, { configsDir: '../renamed/prompt-configs' })
})

test('发布后的 CLI 使用当前根，共享 ZIP／定义／目录出口且不覆盖已有目标', async () => {
  const cliHome = root()
  for (const [folder, name] of [['.agent-presets', 'Current'], ['presets', 'Legacy']]) {
    const preset = join(cliHome, folder, 'cli')
    fs.mkdirSync(preset, { recursive: true })
    fs.writeFileSync(join(preset, 'preset.yml'), `id: cli\nname: ${name}\nmodules: []\n`)
    fs.writeFileSync(join(preset, 'preset.md'), `${name}-BODY`)
  }
  const script = fileURLToPath(new URL('../../scripts/export-preset.mjs', import.meta.url))
  const options = { env: { ...process.env, DSH_HOME: cliHome }, encoding: 'utf8' }
  const zipped = join(cliHome, 'out.zip')
  execFileSync(process.execPath, [script, 'cli', zipped], options)
  const entries = await unpackZip(fs.readFileSync(zipped))
  assert.equal(parse(Buffer.from(entries.find(file => file.path === 'cli/preset.yml').content, 'base64').toString()).name, 'Current')
  const yaml = join(cliHome, 'out.yml')
  execFileSync(process.execPath, [script, 'cli', yaml], options)
  assert.equal(parse(fs.readFileSync(yaml, 'utf8')).name, 'Current')
  const folder = join(cliHome, 'folder')
  execFileSync(process.execPath, [script, 'cli', folder], options)
  assert.equal(fs.readFileSync(join(folder, 'preset.md'), 'utf8'), 'Current-BODY')
  const before = fs.readFileSync(zipped)
  const duplicate = spawnSync(process.execPath, [script, 'cli', zipped], options)
  assert.notEqual(duplicate.status, 0)
  assert.deepEqual(fs.readFileSync(zipped), before)
})
