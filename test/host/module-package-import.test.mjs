import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeHostContext } from '../fixtures/host-harness.mjs'

// DSH_HOME 在加载被测模块前设置（风格一致；paths.ts 自 2026-10-16 起按调用求值，不再要求这个顺序），
// 因此本文件用动态 import 加载 lib，避免污染真实用户预设目录。
const home = mkdtempSync(join(tmpdir(), 'pt-package-import-'))
process.env.DSH_HOME = home
const { registerSettingsBridge } = await import('../../src/runtime/settings-bridge.ts')
const { storageRootOf } = await import('../../src/host/paths.ts')
const bridgeDisposers = []

const PREFIX = '/api/prompt-tool/settings'
const PRESETS = join(storageRootOf(home), 'modules')

function makeHarness() {
  // 差异项用选项表达：本文件的 effect 要收集 disposer（after 统一释放），其余走 harness 默认值。
  return makeHostContext({ effect: (fn) => { const dispose = fn(); if (dispose) bridgeDisposers.push(dispose) } })
}

function register() {
  const { ctx, handlers } = makeHarness()
  registerSettingsBridge(ctx, {
    ns: 'prompt-tool',
    models: () => ({ available: true, providers: [] }),
  })
  return handlers
}

function fakeReq(body) {
  const payload = Buffer.from(JSON.stringify(body))
  return {
    method: 'POST',
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: 'localhost' },
    [Symbol.asyncIterator]: async function* () {
      yield payload
    },
  }
}

function fakeRes() {
  let status = 0
  let body = ''
  return {
    writeHead(code) { status = code },
    end(payload) { body = payload },
    get status() { return status },
    get body() { return body },
  }
}

async function importPackage(body) {
  const handler = register().get(`${PREFIX}/import-module-package`)
  assert.ok(handler, '/import-module-package 端点应注册')
  const res = fakeRes()
  // 覆盖场景显式授权，并经实际预览取得本次提交凭据。
  const request = { ...body, overwrite: true }
  await handler(fakeReq({ ...request, preview: true }), res)
  if (res.status === 200 && JSON.parse(res.body).value?.state === 'ready') {
    const { sourceDigest, previewRevision } = JSON.parse(res.body).value
    await handler(fakeReq({ ...request, expectedSourceDigest: sourceDigest, expectedPreviewRevision: previewRevision }), res)
  }
  return { status: res.status, payload: JSON.parse(res.body) }
}

/** 合法模块包：定义只带 module.yml。 */
function presetPackage(overrides = {}) {
  return {
    files: [
      { path: 'demo/module.yml', content: overrides.presetYml ?? 'id: demo\nmodules: []\nname: Demo 预设\n' },
      ...(overrides.files ?? []),
    ],
  }
}

test('准备期被改动即拒写：预览后源内容变化，旧凭据提交不得落盘', async () => {
  const handler = register().get(`${PREFIX}/import-module-package`)
  assert.ok(handler, '/import-module-package 端点应注册')
  const target = join(PRESETS, 'demo')

  // 1) 用原始包预览并取得本次提交凭据（sourceDigest + previewRevision）。
  const previewRes = fakeRes()
  await handler(fakeReq({ ...presetPackage({}), overwrite: true, preview: true }), previewRes)
  assert.equal(previewRes.status, 200, previewRes.body)
  const preview = JSON.parse(previewRes.body).value
  assert.equal(preview.state, 'ready')
  assert.ok(typeof preview.previewRevision === 'string' && preview.previewRevision.length > 0)

  // 2) 提交时源已变（多带一个文件），却仍用上一步的凭据 —— 必须被拒。
  const staleRes = fakeRes()
  await handler(fakeReq({
    ...presetPackage({ files: [{ path: 'demo/added-after-preview.txt', content: 'changed\n' }] }),
    overwrite: true,
    expectedSourceDigest: preview.sourceDigest,
    expectedPreviewRevision: preview.previewRevision,
  }), staleRes)

  assert.notEqual(staleRes.status, 200, `准备期已变仍应拒绝，实际 ${staleRes.body}`)
  const definition = join(target, 'module.yml')
  if (existsSync(definition)) {
    assert.doesNotMatch(readFileSync(definition, 'utf8'), /changed/, '被拒的提交不得改动目标定义')
  }
  assert.ok(!existsSync(join(target, 'added-after-preview.txt')), '被拒的提交不得写入新增文件')
})

test('装载窗口：暂存期间目标被外部改动即拒装，外部内容不被覆盖', async (t) => {
  const handler = register().get(`${PREFIX}/import-module-package`)
  assert.ok(handler, '/import-module-package 端点应注册')
  const target = join(PRESETS, 'window')
  const pack = (text) => ({
    files: [
      { path: 'window/module.yml', content: 'id: window\nmodules: []\nname: Window\n' },
      { path: 'window/keep.txt', content: text },
    ],
  })
  // 1) 先真装一次，建立目标。
  const first = fakeRes()
  await handler(fakeReq({ ...pack('v1\n'), overwrite: true, preview: true }), first)
  const seed = JSON.parse(first.body).value
  const install = fakeRes()
  await handler(fakeReq({ ...pack('v1\n'), overwrite: true, expectedSourceDigest: seed.sourceDigest, expectedPreviewRevision: seed.previewRevision }), install)
  assert.equal(install.status, 200, install.body)
  assert.equal(readFileSync(join(target, 'keep.txt'), 'utf8'), 'v1\n')

  // 2) 用 v2 预览取凭据。
  const previewRes = fakeRes()
  await handler(fakeReq({ ...pack('v2\n'), overwrite: true, preview: true }), previewRes)
  const preview = JSON.parse(previewRes.body).value
  assert.equal(preview.state, 'ready')

  // 3) 暂存写盘期间往目标目录塞一个外部文件：模拟「装载窗口内目标被别人改动」。
  // 只能 mock 默认导出（CJS 对象）——ESM 命名空间的属性不可重定义。
  const fs = (await import('node:fs')).default
  const { syncBuiltinESMExports } = await import('node:module')
  const real = fs.writeFileSync
  let injected = false
  t.mock.method(fs, 'writeFileSync', (path, ...rest) => {
    real(path, ...rest)
    if (!injected && typeof path === 'string' && path.endsWith('keep.txt')) {
      injected = true
      real(join(target, 'external.txt'), 'EXTERNAL\n')
    }
  })
  syncBuiltinESMExports()
  let res
  try {
    res = fakeRes()
    await handler(fakeReq({ ...pack('v2\n'), overwrite: true, expectedSourceDigest: preview.sourceDigest, expectedPreviewRevision: preview.previewRevision }), res)
  } finally {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  }

  assert.ok(injected, '用例应命中暂存写盘窗口')
  assert.equal(res.status, 409, res.body)
  assert.equal(JSON.parse(res.body).code, 'module-preview-stale')
  assert.equal(readFileSync(join(target, 'external.txt'), 'utf8'), 'EXTERNAL\n', '窗口内的外部改动不得被清理或覆盖')
  assert.equal(readFileSync(join(target, 'keep.txt'), 'utf8'), 'v1\n', '拒装时目标正文保持原字节')
})

test('importPresetPackage：路径穿越条目被明确拒绝，不落盘', async () => {
  for (const files of [
    [{ path: 'demo/../evil.yml', content: 'x' }],
    [{ path: 'C:/evil2.yml', content: 'y' }],
    [{ path: '/abs-evil.yml', content: 'z' }],
    [{ path: '\\abs-evil.yml', content: 'z' }],
  ]) {
    const { status, payload } = await importPackage(presetPackage({ files }))
    assert.equal(status, 400, `非法路径必须 fail closed：${files[0].path}`)
    assert.equal(payload.code, 'module-package-invalid')
    assert.match(payload.message, /非法|路径/)
  }
  const definition = JSON.stringify({ id: 'self-template', modules: [], rules: [{ id: 'rule', then: [
    { id: 'text', kind: 'inject-text', config: { templateFile: './module.yml', text: 'sample' } },
  ] }] })
  const self = await importPackage({ files: [{ path: 'module.yml', content: definition }] })
  assert.equal(self.status, 400, '交换定义不能作为运行模板')
  assert.equal(existsSync(join(PRESETS, 'self-template')), false)
  const { payload: composition } = await importPackage({ files: [{ path: 'module.yml',
    content: 'id: self-composition\ncomposition: ./module.yml\nrules: []\n' }] })
  assert.match(composition.message, /composition.*交换定义/)
  assert.equal(existsSync(join(PRESETS, 'self-composition')), false)
  assert.ok(!existsSync(join(PRESETS, 'evil.yml')), '穿越条目不得写到预设目录之外')
  assert.ok(!existsSync(join(PRESETS, 'demo', 'evil.yml')), '穿越条目不得写入预设目录')
  assert.ok(!existsSync(join(PRESETS, 'demo', 'evil2.yml')))
  assert.ok(!existsSync(join(PRESETS, 'demo', 'abs-evil.yml')))
})

test.after(() => {
  for (const dispose of bridgeDisposers) dispose()
  rmSync(home, { recursive: true, force: true })
})
