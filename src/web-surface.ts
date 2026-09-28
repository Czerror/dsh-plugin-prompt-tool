/**
 * Web 能力诊断：profile 由官方插件管理器装配，本插件只报告缺失能力。
 * 保留原公开函数名，启动与卸载均不改写 profile 或包链接。
 */
import { readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'

/**
 * Web surface bundle：DSH 随安装自带的 in-box bundle。
 * 这是装配事实的唯一定义处，不再从 package.json#dsh.bundle.requires 读取
 * （官方 DshBundleManifest 只有 patch，没有 requires 字段；私有扩展会让
 * 清单看起来像支持该字段，实际无人消费）。
 */
const WEB_APP_BUNDLE = '@deepseek-ai/dsh-web-app'

interface ProfileManifest {
  dsh?: { profile?: { bundles?: string[] } }
}

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

/** 只读诊断；安装与 profile 变更交给官方 plugin_manager。 */
export function ensureWebSurface(ctx: Context, warn: (message: string) => void): void {
  if (ctx.get('webServer') !== undefined) return
  const notify = (message: string): void => {
    process.stderr.write(message + '\n')
    warn(message)
  }
  const profileDir = resolveProfileDir(ctx)
  if (profileDir === undefined) {
    notify(`prompt-tool: Web 服务未就绪，无法定位当前 profile；请通过官方 plugin_manager 检查或安装 ${WEB_APP_BUNDLE}`)
    return
  }
  const profileName = basename(profileDir)
  // TUI profile 无需 Web 表面。
  if (profileName === 'dsh-tui') return
  const manifest = readManifest(join(profileDir, 'package.json'), notify)
  const bundles = manifest?.dsh?.profile?.bundles
  const declared = Array.isArray(bundles) && bundles.includes(WEB_APP_BUNDLE)
  notify(`prompt-tool: profile "${profileName}" 的 Web 服务未就绪${declared ? '（已声明 Web bundle）' : ''}；请通过官方 plugin_manager 检查或安装 ${WEB_APP_BUNDLE}`)
}

/**
 * 延迟到本轮装配结束后诊断；插件卸载取消尚未执行的任务。
 */
export function scheduleWebSurfaceRepair(ctx: Context, warn: (message: string) => void): void {
  ctx.effect(() => {
    let cancelled = false
    const timer = setTimeout(() => {
      if (cancelled) return
      ensureWebSurface(ctx, warn)
    }, 0)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, 'prompt-tool: deferred web surface diagnosis')
}

