/**
 * 技能启停：插件侧隐藏策略的唯一实现处。
 *
 * 技能实体只存在于磁盘，插件不维护"隐藏仓库"：停用 = 给技能标记文件加
 * `.disabled` 后缀（目录束 `SKILL.md` ↔ `SKILL.md.disabled`），启用 = 改回。
 * 官方 `dsh-skill-filesystem` 与本插件的扫描都只认未加后缀的标记文件，所以
 * 一次改名同时让两条发现链路消失/恢复该技能：热生效、可逆、可手工还原，
 * 卸载插件后仍是普通技能目录（参考 Fishquito7/dsh-skill-mcp-panel 的停用约定）。
 *
 * 仅接受技能根下的相对路径，拒绝绝对路径、盘符与 `.` / `..` 段；两边同时
 * 存在同名标记文件时判冲突并提示手工处理，绝不猜测删除哪一个。
 */
import { existsSync, renameSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

/** 停用后缀；技能发现只认未加后缀的标记文件。 */
export const DISABLED_SUFFIX = '.disabled'

/** 目录束技能的标记文件名。 */
export const SKILL_MARKER = 'SKILL.md'

export type SkillToggleFailureCode = 'invalid-target' | 'not-found' | 'conflict' | 'io'

export type SkillToggleResult =
  | { ok: true; folder: string; enabled: boolean; changed: boolean; file: string }
  | { ok: false; code: SkillToggleFailureCode; message: string }

/** 相对技能根的路径分段校验：拒绝绝对路径、盘符与 `.` / `..` 段。 */
function safeSegments(folder: string): string[] | undefined {
  const normalized = folder.replace(/\\/g, '/')
  if (normalized.length === 0 || normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) return undefined
  const segments = normalized.split('/').filter((segment) => segment.length > 0)
  if (segments.length === 0) return undefined
  if (segments.some((segment) => segment === '.' || segment === '..')) return undefined
  return segments
}

/**
 * 启用或停用一个技能（按技能根 + 相对路径定位）。
 * @param skillsDir - 技能根绝对路径（activeSkillsDir）。
 * @param folder - 技能在根下的相对路径（嵌套技能用 `/` 分隔）。
 * @param enabled - true = 启用（去掉后缀），false = 停用（加上后缀）。
 */
export function setSkillEnabled(skillsDir: string, folder: string, enabled: boolean): SkillToggleResult {
  if (typeof skillsDir !== 'string' || skillsDir.trim().length === 0 || typeof folder !== 'string') {
    return { ok: false, code: 'invalid-target', message: '技能目录或技能名不合法' }
  }
  const segments = safeSegments(folder)
  if (segments === undefined) {
    return { ok: false, code: 'invalid-target', message: `技能名不合法：${folder}` }
  }
  const root = resolve(skillsDir)
  const targetDir = resolve(join(root, ...segments))
  if (!targetDir.startsWith(root + sep)) {
    return { ok: false, code: 'invalid-target', message: `技能路径越界：${folder}` }
  }

  const active = join(targetDir, SKILL_MARKER)
  const disabled = active + DISABLED_SUFFIX
  const hasActive = existsSync(active)
  const hasDisabled = existsSync(disabled)
  if (!hasActive && !hasDisabled) {
    return { ok: false, code: 'not-found', message: `未找到技能标记文件：${folder}` }
  }
  if (hasActive && hasDisabled) {
    return {
      ok: false,
      code: 'conflict',
      message: `技能 ${folder} 同时存在 SKILL.md 与 SKILL.md.disabled，请手工保留一个后再操作`,
    }
  }
  if (enabled === hasActive) {
    return { ok: true, folder, enabled, changed: false, file: hasActive ? active : disabled }
  }

  const from = hasActive ? active : disabled
  const to = hasActive ? disabled : active
  try {
    renameSync(from, to)
  } catch (error) {
    return {
      ok: false,
      code: 'io',
      message: `技能 ${folder} ${enabled ? '启用' : '停用'}失败：${error instanceof Error ? error.message : String(error)}`,
    }
  }
  return { ok: true, folder, enabled, changed: true, file: to }
}
