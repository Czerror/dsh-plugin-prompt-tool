/**
 * web 表层自愈契约。
 *
 * 2026-09-17 测试归一精简 Wave 2（host 分片）：用例标题与断言原样保留，只把
 * 「ensureWebSurface 的 web-app 来源」那条从读 src/web-surface.ts 的静态正则匹配
 * 升级为行为断言（清单里的误导性 requires 字段不得改变补进 bundles 的 bundle）。
 * 2026-09-23：原合并进来的 dsh-web-ui `link-profile` 用例随该外来脚本一并移除——那支脚本
 * 服务 `@linxin666/*` 家族包与 `profiles/node_modules` 兜底层，不属本仓库内容；其
 * `resolveDshHomeArg` 用例已迁到 `profile-repair.test.mjs`（本仓库自有的解析修复器）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isolatedHome, tempDir } from '../fixtures/host-harness.mjs'

// 隔离 DSH_HOME 必须在插件入口之前生效：插件在模块加载期解析 DSH_HOME 派生路径。
// isolatedHome 同时登记 after() 还原原值并清理临时目录（本文件不直接读家目录，
// 这是 host 分片统一的隔离语义）。
isolatedHome('pt-profile-assembly-')
const { ensureWebSurface, scheduleWebSurfaceRepair } = await import('../../lib/index.mjs')

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
  // 行为断言（取代原先读 src/web-surface.ts 做正则匹配的静态断言）：清单里放一个误导性的
  // requires 字段 + 真实 profile 目录；若实现真按 requires 取 bundle，补进 bundles 的就会
  // 是那个字段的值，而不是文件常量。
  const root = tempDir('pt-web-requires-')
  const profileDir = join(root, 'prompt-tool')
  mkdirSync(profileDir, { recursive: true })
  const manifest = {
    name: 'prompt-tool',
    dsh: {
      bundle: { requires: ['@deepseek-ai/dsh-misleading-requires'] },
      profile: { bundles: ['@deepseek-ai/dsh-base'] },
    },
  }
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')

  ensureWebSurface(ctxFor(profileDir, undefined), () => {})

  const bundles = readBundles(profileDir)
  assert.deepEqual(
    bundles,
    ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
    '补进 bundles 的必须是文件常量 @deepseek-ai/dsh-web-app（base 之后）',
  )
  assert.equal(
    bundles.includes('@deepseek-ai/dsh-misleading-requires'),
    false,
    '官方 DshBundleManifest 只有 patch：requires 字段不得再被读取',
  )
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
