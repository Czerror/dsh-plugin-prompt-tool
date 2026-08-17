/**
 * prompt-tool skills 的 profile 副本。
 *
 * 安装命令 `dsh plugin add` 是官方的 pnpm 转发器，插件代码不会在该命令中
 * 执行（本项目也不修改官方源码）。因此复制动作放在插件首次 apply 时：
 * 把包内 `skills/` 增量复制到**本插件自己的 profile** 目录下的 `skills/`
 * （`$DSH_HOME/profiles/prompt-tool/skills`），并且后续启动优先使用这份副本。
 * 即使本插件从 `dsh web` / `dsh-tui` 启动，也固定写到 prompt-tool profile，
 * 不会写到 web / dsh-tui 的 profile 下。
 *
 * 合并规则：
 *  - 只补缺失项，绝不覆盖已存在文件——用户在 profile 副本里的修改会保留；
 *  - 包内新增的技能目录/文件会在下次启动补进副本；
 *  - 副本目录不可写或 profile 定位失败时回退到包内目录，只告警不阻断。
 */
import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { resolveProfileDir } from './web-surface.ts'

/** 本插件专属 profile 名；skills 副本固定放这里。 */
const PLUGIN_PROFILE = 'prompt-tool'

/** 递归把 src 中缺失的目录/文件补到 dst，已有项保持不动。 */
function mergeMissing(src: string, dst: string): void {
  mkdirSync(dst, { recursive: true })
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const srcEntry = join(src, entry.name)
    const dstEntry = join(dst, entry.name)
    if (!existsSync(dstEntry)) {
      cpSync(srcEntry, dstEntry, { recursive: true })
    } else if (entry.isDirectory()) {
      mergeMissing(srcEntry, dstEntry)
    }
  }
}

/** 定位本插件自己的 profile 目录；不存在时回退到当前 profile。 */
function resolvePluginProfileDir(ctx: Context): string | undefined {
  const currentDir = resolveProfileDir(ctx)
  if (currentDir === undefined) return undefined
  const profilesDir = join(currentDir, '..')
  const pluginDir = join(profilesDir, PLUGIN_PROFILE)
  return existsSync(join(pluginDir, 'package.json')) ? pluginDir : currentDir
}

/**
 * 返回本插件应使用的 skills 目录：
 * 优先本插件 profile（prompt-tool）下的 `skills/` 副本；无法确定 profile
 * 或复制失败时回退到 sourceDir（默认包内 `skills/`）。
 */
export function resolveProfileSkillsDir(ctx: Context, sourceDir: string, warn: (message: string) => void): string {
  const profileDir = resolvePluginProfileDir(ctx)
  if (profileDir === undefined) return sourceDir
  const targetDir = join(profileDir, 'skills')
  try {
    if (!existsSync(sourceDir)) return targetDir
    mergeMissing(sourceDir, targetDir)
    return targetDir
  } catch (error) {
    warn(`prompt-tool: failed to copy skills into profile directory ${targetDir}: ${error instanceof Error ? error.message : String(error)}`)
    return sourceDir
  }
}
