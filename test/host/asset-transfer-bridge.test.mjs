import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { parse } from 'yaml'

const home = mkdtempSync(join(process.cwd(), 'pt-assets-bridge-'))
process.env.DSH_HOME = home
const { registerSettingsBridge } = await import('../../src/runtime/settings-bridge.ts')
const { BRIDGE_ENDPOINTS, MAX_BRIDGE_BODY_BYTES, SETTINGS_BRIDGE_PREFIX } = await import('../../src/shared/bridge-contract.ts')
const root = join(home, '.agent-presets')
mkdirSync(join(root, 'owner'), { recursive: true })
writeFileSync(join(root, 'owner/preset.yml'), 'id: owner\nname: Owner\nmodules: []\n')
test.after(() => rmSync(home, { recursive: true, force: true }))

function harness(t, refresh = () => {}) {
  const handlers = new Map()
  const disposers = []
  let active = join(root, 'owner')
  const sctx = {
    settings: { describe: () => [], get: () => undefined },
    webServer: { register: ({ path, handler }) => { handlers.set(path, handler); return () => handlers.delete(path) } },
    effect: (fn) => { const dispose = fn(); if (dispose) disposers.push(dispose) },
  }
  const ctx = { inject: (deps, fn) => { if (deps.includes('settings')) fn(sctx) } }
  registerSettingsBridge(ctx, 'prompt-tool', () => ({}), () => ({}), () => '', undefined, () => active, undefined, undefined, refresh)
  const dispose = () => { for (const fn of disposers.splice(0)) fn() }
  t.after(dispose)
  return { handlers, dispose, setActive: (dir) => { active = dir } }
}

function response() {
  let status
  let payload
  return { writeHead: (code) => { status = code }, end: (body) => { payload = JSON.parse(body) }, get status() { return status }, get payload() { return payload } }
}

async function call(h, endpoint, body, overrides = {}) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))])
  Object.assign(req, { method: 'POST', headers: { host: 'localhost' }, socket: { remoteAddress: '127.0.0.1' } }, overrides)
  const res = response()
  await h.handlers.get(SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS[endpoint])(req, res)
  return res
}

const filesFor = (id, extra = []) => [{ path: 'preset.yml', encoding: 'utf8', content: `# SOURCE\nid: ${id}\nname: ${id}\nmodules: []\n` }, ...extra]
const credentials = (preview) => ({ expectedSourceDigest: preview.payload.value.sourceDigest, expectedPreviewRevision: preview.payload.value.previewRevision })

test('预设真实安装保留自有资源；刷新报错仍返回已安装结果', async (t) => {
  let refreshed = 0
  const h = harness(t, (id) => { refreshed++; assert.ok(existsSync(join(root, id, 'agent.cordis.yml'))); throw new Error('refresh failed') })
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0])
  const files = filesFor('roundtrip', [
    { path: 'preset.md', content: 'BODY\r\n' },
    { path: 'cover.png', content: png.toString('base64'), encoding: 'base64' },
    { path: 'engine/private.mjs', content: 'export default {}' },
  ])
  const preview = await call(h, 'importPresetPackage', { files, preview: true })
  assert.equal(preview.status, 200, JSON.stringify(preview.payload))
  assert.equal(preview.payload.value.summary.targetId, 'roundtrip')
  assert.equal(existsSync(join(root, 'roundtrip')), false)
  const result = await call(h, 'importPresetPackage', { files, ...credentials(preview) })
  assert.equal(result.status, 200, JSON.stringify(result.payload))
  assert.match(result.payload.value.refreshWarning, /refresh failed/)
  assert.equal(refreshed, 1)
  assert.equal(readFileSync(join(root, 'roundtrip/preset.md'), 'utf8'), 'BODY\r\n')
  assert.deepEqual(readFileSync(join(root, 'roundtrip/cover.png')), png)
  assert.equal(readFileSync(join(root, 'roundtrip/engine/private.mjs'), 'utf8'), 'export default {}')
  assert.equal(existsSync(join(root, 'owner/preset.yml')), true)
})

test('提交必须匹配预览；默认重名另存、明确更新及目标版本复检', async (t) => {
  const h = harness(t)
  const files = filesFor('versioned')
  assert.equal((await call(h, 'importPresetPackage', { files })).status, 409)
  assert.equal(existsSync(join(root, 'versioned')), false)
  const preview = await call(h, 'importPresetPackage', { files, preview: true })
  assert.equal((await call(h, 'importPresetPackage', { files: filesFor('changed'), ...credentials(preview) })).status, 409)
  assert.equal((await call(h, 'importPresetPackage', { files, ...credentials(preview) })).status, 200)
  const copy = await call(h, 'importPresetPackage', { files, preview: true })
  assert.equal(copy.payload.value.summary.targetId, 'versioned-copy')
  const update = { files, targetId: 'versioned', overwrite: true }
  const updatePreview = await call(h, 'importPresetPackage', { ...update, preview: true })
  writeFileSync(join(root, 'versioned/changed.txt'), 'EXTERNAL')
  assert.equal((await call(h, 'importPresetPackage', { ...update, ...credentials(updatePreview) })).status, 409)
  assert.equal(readFileSync(join(root, 'versioned/changed.txt'), 'utf8'), 'EXTERNAL')
  const fresh = await call(h, 'importPresetPackage', { ...update, preview: true })
  assert.equal((await call(h, 'importPresetPackage', { ...update, ...credentials(fresh) })).status, 200)
  assert.equal(existsSync(join(root, 'versioned/changed.txt')), false)
})

function pngCard() {
  const chunk = (type, data) => {
    const size = Buffer.alloc(4)
    size.writeUInt32BE(data.length)
    return Buffer.concat([size, Buffer.from(type), data, Buffer.alloc(4)])
  }
  const json = JSON.stringify({ spec: 'chara_card_v3', data: { name: 'PNG角色', description: 'PNG BODY' } })
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('tEXt', Buffer.from('chara\0' + Buffer.from(json).toString('base64'))), chunk('IEND', Buffer.alloc(0))])
}

async function upload(h, bytes, name = 'card.png') {
  const req = Readable.from([bytes])
  Object.assign(req, { method: 'POST', headers: { host: 'localhost', 'x-file-name': encodeURIComponent(name) }, socket: { remoteAddress: '127.0.0.1' } })
  const res = response()
  await h.handlers.get(SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.assetUpload)(req, res)
  return res
}

test('PNG 原始上传只暂存；角色确认后字节一致，释放和卸载清理来源', async (t) => {
  const h = harness(t)
  const png = pngCard()
  const uploaded = await upload(h, png)
  assert.equal(uploaded.status, 200, JSON.stringify(uploaded.payload))
  assert.equal(existsSync(join(root, '.characters')), false)
  const { sourceId } = uploaded.payload.value
  const preview = await call(h, 'charactersImport', { sourceId, preview: true, targetId: 'png-card' })
  assert.equal(preview.status, 200, JSON.stringify(preview.payload))
  assert.equal(existsSync(join(root, '.characters')), false)
  const result = await call(h, 'charactersImport', { sourceId, targetId: 'png-card', ...credentials(preview) })
  assert.equal(result.status, 200, JSON.stringify(result.payload))
  assert.deepEqual(readFileSync(join(root, '.characters/png-card/avatar.png')), png)
  assert.equal((await call(h, 'assetRelease', { sourceId })).payload.value.released, true)
  assert.equal((await call(h, 'charactersImport', { sourceId, preview: true })).status, 400)
  await upload(h, png)
  h.dispose()
  assert.deepEqual(readdirSync(join(home, '.prompt-tool-uploads')), [])
})

test('角色预览绑定 owner、目标和覆盖选择；重导入保留记忆', async (t) => {
  const h = harness(t)
  const files = [{ path: 'role.yml', content: 'id: native-role\nname: Native\npromptConfigs:\n  - id: text\n    text: HELLO\n' }]
  const first = await call(h, 'charactersImport', { files, preview: true })
  assert.equal(first.status, 200, JSON.stringify(first.payload))
  writeFileSync(join(root, 'owner/change.txt'), 'OWNER CHANGED')
  assert.equal((await call(h, 'charactersImport', { files, ...credentials(first) })).status, 409)
  const fresh = await call(h, 'charactersImport', { files, preview: true })
  assert.equal((await call(h, 'charactersImport', { files, ...credentials(fresh) })).status, 200)
  assert.equal((await call(h, 'charactersImport', { files, preview: true })).payload.value.summary.targetId, 'native-role-copy')
  writeFileSync(join(root, '.characters/native-role/memory.md'), 'KEEP MEMORY')
  const update = { files, targetId: 'native-role', overwrite: true }
  const preview = await call(h, 'charactersImport', { ...update, preview: true })
  assert.equal((await call(h, 'charactersImport', { ...update, overwrite: false, ...credentials(preview) })).status, 409)
  assert.equal((await call(h, 'charactersImport', { ...update, ...credentials(preview) })).status, 200)
  assert.equal(readFileSync(join(root, '.characters/native-role/memory.md'), 'utf8'), 'KEEP MEMORY')
})

test('新参数、来源、载荷上限和回环边界均在写盘前拒绝；旧流接口仅提示升级', async (t) => {
  const h = harness(t)
  const files = filesFor('invalid-new')
  for (const extra of [{ preview: 'true' }, { overwrite: 1 }, { targetId: 'UPPER' }, { targetName: [] }, { sourceKind: 'unknown' }, { expectedSourceDigest: 'bad' }, { sourceId: 'wrong' }, { unknown: true }]) {
    assert.equal((await call(h, 'importPresetPackage', { files, ...extra })).status, 400, JSON.stringify(extra))
  }
  assert.equal((await call(h, 'importPresetPackage', { files: [{ path: 'preset.yml', content: 'x', encoding: 'binary' }], preview: true })).status, 400)
  assert.equal((await call(h, 'importPresetPackage', { files, preview: true }, { socket: { remoteAddress: '192.0.2.1' } })).status, 403)
  assert.equal((await call(h, 'importPresetPackage', { files, preview: true }, { headers: { host: 'localhost', origin: 'https://evil.invalid' } })).status, 403)
  assert.equal((await call(h, 'importPresetPackage', { files, preview: true }, { method: 'GET' })).status, 405)
  assert.equal((await call(h, 'importPresetPackage', { files: [{ path: 'preset.yml', content: 'x'.repeat(MAX_BRIDGE_BODY_BYTES) }] })).status, 413)
  assert.equal((await call(h, 'charactersImportStream', {})).status, 410)
  assert.equal(existsSync(join(root, 'invalid-new')), false)
})

test('ZIP 与定义出口共用预览，来源改变使下载过期', async (t) => {
  const h = harness(t)
  const request = { id: 'roundtrip', mode: 'zip', preview: true }
  const preview = await call(h, 'exportPreset', request)
  assert.equal(preview.status, 200, JSON.stringify(preview.payload))
  const zip = await call(h, 'exportPreset', { ...request, preview: false, expectedRevision: preview.payload.value.revision })
  assert.equal(zip.status, 200, JSON.stringify(zip.payload))
  assert.equal(Buffer.from(zip.payload.value.content, 'base64').subarray(0, 2).toString(), 'PK')
  const definition = await call(h, 'exportPreset', { id: 'roundtrip', mode: 'definition' })
  assert.equal(parse(definition.payload.value.content).id, 'roundtrip')
  writeFileSync(join(root, 'roundtrip/extra.txt'), 'changed')
  assert.equal((await call(h, 'exportPreset', { ...request, preview: false, expectedRevision: preview.payload.value.revision })).status, 409)
  assert.equal((await call(h, 'exportPreset', { id: 'roundtrip', mode: 'invalid' })).status, 400)
})
