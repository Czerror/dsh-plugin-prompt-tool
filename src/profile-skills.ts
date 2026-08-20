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
 *  - 包内 `skills/manifest.json` 记录每个技能的版本；
 *  - 目标副本通过 `.prompt-tool-manifest.json` 记录已部署版本；
 *  - 包内技能版本高于副本时整体覆盖该技能目录（版本升级）；
 *  - 副本中用户新增/修改且不在包内清单的技能目录保持不动；
 *  - 没有 manifest 时回退到旧行为：只补缺失、绝不覆盖。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { resolveProfileDir } from './web-surface.ts'

/** 本插件专属 profile 名；skills 副本固定放这里。 */
const PLUGIN_PROFILE = 'prompt-tool'
/** 目标副本中记录已部署版本的隐藏 manifest。 */
const TARGET_MANIFEST = '.prompt-tool-manifest.json'

interface SkillsManifest {
  version: number
  skills: Record<string, number>
}

function readManifest(file: string): SkillsManifest | undefined {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<SkillsManifest> | null
    if (parsed === null || typeof parsed !== 'object') return undefined
    return {
      version: typeof parsed.version === 'number' ? parsed.version : 0,
      skills: parsed.skills !== null && typeof parsed.skills === 'object' ? parsed.skills as Record<string, number> : {},
    }
  } catch {
    return undefined
  }
}

function writeManifest(file: string, manifest: SkillsManifest): void {
  writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
}

/** 递归把 src 中缺失的目录/文件补到 dst，已有项保持不动（无 manifest 时的兼容路径）。 */
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

/** 按 manifest 版本同步技能副本：只覆盖版本升级的包内技能，保留用户自定义技能。 */
function syncSkillsByManifest(sourceDir: string, targetDir: string): void {
  const sourceManifest = readManifest(join(sourceDir, 'manifest.json'))
  if (sourceManifest === undefined) {
    mergeMissing(sourceDir, targetDir)
    return
  }

  mkdirSync(targetDir, { recursive: true })
  const targetManifest = readManifest(join(targetDir, TARGET_MANIFEST)) ?? { version: 0, skills: {} }

  // 迁移清理：历史版本曾把项目根结构误复制进副本（解析路径错位）。
  // 删除「非包内技能且不含 SKILL.md」的顶层目录（.agents/.git/docs 等垃圾）；
  // 用户自定义技能（含 SKILL.md）与包内技能目录保留。
  for (const entry of readdirSync(targetDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (sourceManifest.skills[entry.name] !== undefined) continue
    const targetEntry = join(targetDir, entry.name)
    if (!existsSync(join(targetEntry, 'SKILL.md'))) {
      rmSync(targetEntry, { recursive: true, force: true })
    }
  }

  for (const [folder, version] of Object.entries(sourceManifest.skills)) {
    const sourceEntry = join(sourceDir, folder)
    if (!existsSync(sourceEntry)) continue
    const targetEntry = join(targetDir, folder)
    const deployed = targetManifest.skills[folder] ?? 0
    if (!existsSync(targetEntry) || version > deployed) {
      rmSync(targetEntry, { recursive: true, force: true })
      cpSync(sourceEntry, targetEntry, { recursive: true })
    }
  }

  writeManifest(join(targetDir, TARGET_MANIFEST), {
    version: sourceManifest.version,
    skills: { ...targetManifest.skills, ...sourceManifest.skills },
  })
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
    syncSkillsByManifest(sourceDir, targetDir)
    return targetDir
  } catch (error) {
    warn(`prompt-tool: failed to copy skills into profile directory ${targetDir}: ${error instanceof Error ? error.message : String(error)}`)
    return sourceDir
  }
}
