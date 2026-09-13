import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ensureWebSurface, scheduleWebSurfaceRepair } from '../../lib/index.mjs'

const webSurfaceSource = readFileSync(new URL('../../src/web-surface.ts', import.meta.url), 'utf8')

function makeProfile(root, { bundles = ['@deepseek-ai/dsh-base'] } = {}) {
  const profileDir = join(root, 'prompt-tool')
  mkdirSync(profileDir, { recursive: true })
  const manifest = { name: 'prompt-tool', dsh: { profile: { bundles } } }
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  return { profileDir, manifest }
}

function ctxFor(profileDir, webServer) {
  return {
    baseUrl: pathToFileURL(profileDir + '/').href,
    get: (key) => key === 'webServer' ? webServer : undefined,
  }
}

/** 带 disposer 记录的假 ctx：验证延迟任务确实挂在 effect 上。 */
function effectCtxFor(profileDir) {
  const effects = []
  return {
    baseUrl: pathToFileURL(profileDir + '/').href,
    get: () => undefined,
    effect: (callback, name) => {
      effects.push({ name, dispose: callback() })
      return () => {}
    },
    effects,
  }
}

const readBundles = (profileDir) =>
  JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')).dsh.profile.bundles

test('ensureWebSurface 为当前 profile 补 web-app 并写 .bak 备份', () => {
  const root = join(tmpdir(), `prompt-tool-web-${process.pid}-${Date.now()}`)
  mkdirSync(root, { recursive: true })
  try {
    const { profileDir, manifest } = makeProfile(root)
    const warnings = []
    ensureWebSurface(ctxFor(profileDir, undefined), (message) => warnings.push(message))

    const updated = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
    assert.ok(updated.dsh.profile.bundles.includes('@deepseek-ai/dsh-web-app'))
    assert.ok(existsSync(join(profileDir, 'package.json.bak')))
    assert.deepEqual(JSON.parse(readFileSync(join(profileDir, 'package.json.bak'), 'utf8')), manifest)
    assert.ok(warnings.some((message) => message.includes('please restart')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('ensureWebSurface 不修改同级 profile', () => {
  const root = join(tmpdir(), `prompt-tool-web-${process.pid}-${Date.now()}`)
  mkdirSync(root, { recursive: true })
  try {
    const { profileDir } = makeProfile(root)
    for (const name of ['web', 'dsh-tui']) {
      const dir = join(root, name)
      mkdirSync(dir, { recursive: true })
      const original = { name, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }
      writeFileSync(join(dir, 'package.json'), JSON.stringify(original, null, 2) + '\n', 'utf8')
    }
    ensureWebSurface(ctxFor(profileDir, undefined), () => {})

    for (const name of ['web', 'dsh-tui']) {
      const content = JSON.parse(readFileSync(join(root, name, 'package.json'), 'utf8'))
      assert.equal(content.name, name)
      assert.deepEqual(content.dsh.profile.bundles, ['@deepseek-ai/dsh-base'])
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('ensureWebSurface 在 webServer 已存在时不修改 manifest', () => {
  const root = join(tmpdir(), `prompt-tool-web-${process.pid}-${Date.now()}`)
  mkdirSync(root, { recursive: true })
  try {
    const { profileDir, manifest } = makeProfile(root)
    ensureWebSurface(ctxFor(profileDir, {}), () => {})
    assert.deepEqual(JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')), manifest)
    assert.equal(existsSync(join(profileDir, 'package.json.bak')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('ensureWebSurface 的 web-app 来源是文件常量，不再读 package.json#dsh.bundle.requires', () => {
  assert.match(webSurfaceSource, /const WEB_APP_BUNDLE = '@deepseek-ai\/dsh-web-app'/)
  // 只看代码，注释里保留“为什么不再读清单”的说明不算违规。
  const code = webSurfaceSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  assert.doesNotMatch(code, /\.\.\/package\.json/, '不得再读插件自身 package.json 的私有 requires 字段')
  assert.doesNotMatch(code, /requires/, '官方 DshBundleManifest 只有 patch，代码里不再有 requires 读取路径')
})

test('scheduleWebSurfaceRepair：延迟到本轮装配结束后补写，插件卸载后不再写盘', async () => {
  const root = join(tmpdir(), `prompt-tool-web-${process.pid}-${Date.now()}`)
  mkdirSync(root, { recursive: true })
  try {
    const live = makeProfile(join(root, 'live'))
    const liveCtx = effectCtxFor(live.profileDir)
    scheduleWebSurfaceRepair(liveCtx, () => {})
    assert.equal(liveCtx.effects.length, 1, '修复任务必须注册在 ctx.effect 上')
    assert.equal(readBundles(live.profileDir).includes('@deepseek-ai/dsh-web-app'), false, '注册当帧不写盘')
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(readBundles(live.profileDir).includes('@deepseek-ai/dsh-web-app'), true, '延迟任务应补写 web-app')

    const unloaded = makeProfile(join(root, 'unloaded'))
    const unloadedCtx = effectCtxFor(unloaded.profileDir)
    scheduleWebSurfaceRepair(unloadedCtx, () => {})
    unloadedCtx.effects[0].dispose()
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.deepEqual(readBundles(unloaded.profileDir), ['@deepseek-ai/dsh-base'], '卸载后不得再异步补写 profile')
    assert.equal(existsSync(join(unloaded.profileDir, 'package.json.bak')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
