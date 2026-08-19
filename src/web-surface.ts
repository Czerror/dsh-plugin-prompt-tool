/**
 * prompt-tool 自愈层：补当前 profile manifest 与本插件相关的装配项。
 *
 * 官方 profile 组合规则：`dsh plugin add` 只把声明了 `dsh.bundle` 的
 * **直接依赖**追加进 `dsh.profile.bundles`，而 `@deepseek-ai/dsh-web-app`
 * 是随 dsh 安装自带的 in-box bundle。自定义 profile（如 prompt-tool）
 * 首次初始化只含 `@deepseek-ai/dsh-base`，单独执行
 * `dsh plugin --profile prompt-tool add link:<本仓库>` 后，本插件等待的
 * `webServer` 服务不存在。
 *
 * 因此：
 *  1. 当前 profile 缺 webServer 时，把 web-app 补进当前 profile 的
 *     bundles（base 之后、本插件之前），重启一次后生效；
 *  2. 不再改写同级 `web` / `dsh-tui` profile，也不主动退出进程；
 *     只提示用户重启，让官方装配路径在下次启动时读取新 manifest。
 *
 * 官方 Loader 只会在进程启动时读取 profile 的 bundles 列表，因此本层只
 * 持久化 manifest 并提示重启，不做运行中热挂载。所有写入都是幂等的，
 * 写前会保留一份 `.bak` 备份。
 *
 * 失败只降级为日志告警，绝不阻断启动。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'

const FALLBACK_WEB_APP_BUNDLE = '@deepseek-ai/dsh-web-app'
const BASE_BUNDLE = '@deepseek-ai/dsh-base'
const PLUGIN_BUNDLE = 'dsh-plugin-prompt-tool'

/**
 * 从本插件自己的 package.json 读取 `dsh.bundle.requires` 中声明的
 * Web surface bundle（缺失时回退到 @deepseek-ai/dsh-web-app）。
 * 这样“把 web-app 补进本插件 package.json”就是装配事实，而不是散落的魔法字符串。
 */
function readWebAppBundle(): string {
  try {
    const manifestPath = new URL('../package.json', import.meta.url)
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      dsh?: { bundle?: { requires?: unknown } }
    }
    const requires = manifest.dsh?.bundle?.requires
    if (Array.isArray(requires)) {
      const first = requires.find((entry): entry is string => typeof entry === 'string')
      if (first !== undefined && first.length > 0) return first
    }
  } catch {
    // 包结构异常时用内置回退值，自愈仍可用。
  }
  return FALLBACK_WEB_APP_BUNDLE
}

const WEB_APP_BUNDLE = readWebAppBundle()

interface ProfileManifest {
  dependencies?: Record<string, unknown>
  dsh?: { profile?: { bundles?: string[] } }
}

type HealResult = 'already' | 'added' | 'invalid'

/** 从 loader 根 Include 的 baseUrl 推导 profile 目录。 */
export function resolveProfileDir(ctx: Context): string | undefined {
  const baseUrl = ctx.baseUrl
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) return undefined
  try {
    return fileURLToPath(new URL('.', baseUrl))
  } catch {
    return undefined
  }
}

function readManifest(packagePath: string, warn: (message: string) => void): ProfileManifest | undefined {
  try {
    return JSON.parse(readFileSync(packagePath, 'utf8')) as ProfileManifest
  } catch (error) {
    warn(`prompt-tool: cannot read profile manifest ${packagePath}: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

function writeManifest(packagePath: string, manifest: ProfileManifest, warn: (message: string) => void): boolean {
  try {
    // 写前备份当前 manifest，自愈失败时保留现场。
    if (existsSync(packagePath)) {
      writeFileSync(`${packagePath}.bak`, readFileSync(packagePath, 'utf8'), 'utf8')
    }
    writeFileSync(packagePath, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
    return true
  } catch (error) {
    warn(`prompt-tool: cannot update profile manifest ${packagePath}: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

/**
 * 把 web-app 补进当前 profile 的 bundles（base 之后、本插件之前）。
 * 只用于当前 prompt-tool profile；dsh-tui 不需要 web-app。
 */
function ensureCurrentWebAppBundle(manifest: ProfileManifest): HealResult {
  const bundles = manifest.dsh?.profile?.bundles
  if (!Array.isArray(bundles)) return 'invalid'
  if (bundles.includes(WEB_APP_BUNDLE)) return 'already'
  const pluginIndex = bundles.indexOf(PLUGIN_BUNDLE)
  const baseIndex = bundles.indexOf(BASE_BUNDLE)
  const insertAt = pluginIndex >= 0 ? pluginIndex : baseIndex >= 0 ? baseIndex + 1 : bundles.length
  bundles.splice(insertAt, 0, WEB_APP_BUNDLE)
  return 'added'
}

/**
 * 每次启动：
 *  1. 只处理当前 profile：缺 webServer 时补 web-app 并提示重启；
 *  2. 不修改同级 profile，不主动退出进程。
 */
export function ensureWebSurface(ctx: Context, warn: (message: string) => void): void {
  const notify = (message: string): void => {
    // 关键自愈提示同时写 stderr，保证 TTY 与日志重定向场景都可见。
    process.stderr.write(message + '\n')
    warn(message)
  }
  const profileDir = resolveProfileDir(ctx)
  if (profileDir === undefined) {
    notify('prompt-tool: cannot locate profile directory to repair bundles; add @deepseek-ai/dsh-web-app to dsh.profile.bundles manually')
    return
  }
  const packagePath = join(profileDir, 'package.json')
  const manifest = readManifest(packagePath, notify)
  if (manifest === undefined) return

  const profileName = basename(profileDir)
  // dsh-tui 有它自己的表层，不需要 web-app，也不做当前 profile 的 web 自愈。
  if (profileName === 'dsh-tui') return
  if (ctx.get('webServer') !== undefined) return
  const result = ensureCurrentWebAppBundle(manifest)
  if (result === 'invalid') {
    notify(`prompt-tool: profile manifest has no dsh.profile.bundles: ${packagePath}`)
    return
  }
  if (result === 'added' && !writeManifest(packagePath, manifest, notify)) return
  if (result === 'added') {
    notify(`prompt-tool: auto-added ${WEB_APP_BUNDLE} to dsh.profile.bundles for profile "${profileName}"; next launch will mount the Web surface`)
    notify('prompt-tool: please restart the app for the repaired profile to take effect')
  }
}
