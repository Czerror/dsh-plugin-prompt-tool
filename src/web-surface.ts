/**
 * prompt-tool 自愈层：补 profile manifest 与本插件相关的装配项。
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
 *  2. 同级 `web` / `dsh-tui` profile 存在时，只把
 *     `dsh-plugin-prompt-tool` 写进它们的 dependencies + bundles。
 *     node_modules 的物化交给官方 `dsh plugin --profile <name> install`
 *     （本质是 pnpm）完成，本插件不手工创建链接。
 *     `dsh-tui` 只有在确实装有 `@deepseek-harness-tui/dsh-tui` 时才处理，
 *     否则整体跳过——不写入本插件。dsh-tui **不需要** web-app。
 *
 * 官方 Loader 只会在进程启动时读取 profile 的 bundles 列表，因此本层只
 * 持久化 manifest 并提示重启，不做运行中热挂载。所有写入都是幂等的。
 * 当前 profile 首次补上 web-app 后会自动退出（exit 0），完成初始化。
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
const TUI_BUNDLE = '@deepseek-harness-tui/dsh-tui'
const SIBLING_PROFILES = ['web', 'dsh-tui'] as const
/** 首次初始化完成后的自动退出延迟，给日志落盘与终端刷新留时间。 */
const AUTO_EXIT_DELAY_MS = 500

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
    writeFileSync(packagePath, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
    return true
  } catch (error) {
    warn(`prompt-tool: cannot update profile manifest ${packagePath}: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

/** dsh-tui profile 是否真的装着 dsh-tui（依赖声明或 bundle 层都算）。 */
function hasDshTui(manifest: ProfileManifest): boolean {
  return manifest.dependencies?.[TUI_BUNDLE] !== undefined
    || manifest.dsh?.profile?.bundles?.includes(TUI_BUNDLE) === true
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
 * 把本插件补进同级 profile 的 dependencies + bundles。
 * @returns 实际写入的条目描述；返回 undefined 表示跳过/失败。
 */
function ensurePluginInSiblingProfile(packagePath: string, manifest: ProfileManifest, pluginSpec: string | undefined, warn: (message: string) => void): string | undefined {
  const bundles = manifest.dsh?.profile?.bundles
  if (!Array.isArray(bundles)) {
    warn(`prompt-tool: sibling profile manifest has no dsh.profile.bundles: ${packagePath}`)
    return undefined
  }
  const hasDependency = manifest.dependencies?.[PLUGIN_BUNDLE] !== undefined
  const added: string[] = []
  if (!hasDependency) {
    if (typeof pluginSpec !== 'string' || pluginSpec.length === 0) {
      warn(`prompt-tool: skip sibling profile ${packagePath} — current profile declares no install spec for ${PLUGIN_BUNDLE}`)
      return undefined
    }
    manifest.dependencies = { ...manifest.dependencies, [PLUGIN_BUNDLE]: pluginSpec }
    added.push(`dependency ${PLUGIN_BUNDLE}=${pluginSpec}`)
  }
  if (!bundles.includes(PLUGIN_BUNDLE)) {
    bundles.push(PLUGIN_BUNDLE)
    added.push(`bundle ${PLUGIN_BUNDLE}`)
  }
  if (added.length === 0) return undefined
  if (!writeManifest(packagePath, manifest, warn)) return undefined
  return added.join(', ')
}

/** 自愈同级 web / dsh-tui profile；只写 package.json，不创建 node_modules 链接。 */
function healSiblingProfiles(profileDir: string, pluginSpec: string | undefined, warn: (message: string) => void): void {
  const profilesDir = join(profileDir, '..')
  for (const profileName of SIBLING_PROFILES) {
    const packagePath = join(profilesDir, profileName, 'package.json')
    if (!existsSync(packagePath)) {
      warn(`prompt-tool: skip sibling heal for "${profileName}" — profile package.json not found`)
      continue
    }
    const manifest = readManifest(packagePath, warn)
    if (manifest === undefined) continue
    if (profileName === 'dsh-tui' && !hasDshTui(manifest)) {
      warn(`prompt-tool: skip sibling heal for "dsh-tui" — ${TUI_BUNDLE} is not installed; dsh-plugin-prompt-tool will not be written into it`)
      continue
    }
    const changes = ensurePluginInSiblingProfile(packagePath, manifest, pluginSpec, warn)
    if (changes !== undefined) {
      warn(`prompt-tool: healed sibling profile "${profileName}": added ${changes}`)
    }
  }
}

/**
 * 每次启动：
 *  1. 同级 web / dsh-tui 补本插件（dsh-tui 未安装则跳过）；
 *  2. 当前 profile 缺 webServer 时补 web-app 并提示重启。
 * webServer 已存在时当前 profile 无需处理，但同级自愈仍会执行（幂等）。
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
  const pluginSpec = typeof manifest.dependencies?.[PLUGIN_BUNDLE] === 'string'
    ? manifest.dependencies[PLUGIN_BUNDLE]
    : undefined
  healSiblingProfiles(profileDir, pluginSpec, notify)

  const profileName = basename(profileDir)
  // dsh-tui 有它自己的表层，不需要 web-app，也不做当前 profile 的 web 自愈。
  if (profileName === 'dsh-tui' || hasDshTui(manifest)) return
  if (ctx.get('webServer') !== undefined) return
  const result = ensureCurrentWebAppBundle(manifest)
  if (result === 'invalid') {
    notify(`prompt-tool: profile manifest has no dsh.profile.bundles: ${packagePath}`)
    return
  }
  if (result === 'added' && !writeManifest(packagePath, manifest, notify)) return
  if (result === 'added') {
    notify(`prompt-tool: auto-added ${WEB_APP_BUNDLE} to dsh.profile.bundles for profile "${profileName}"; next launch will mount the Web surface (dsh web / dsh-tui / dsh --profile ${profileName})`)
    notify('prompt-tool: initialization complete — exiting so the repaired profile can be launched')
    setTimeout(() => process.exit(0), AUTO_EXIT_DELAY_MS)
  }
}
