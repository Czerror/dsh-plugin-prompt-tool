/**
 * skills 目录扫描与 SKILL.md frontmatter 读取（纯函数）。
 *
 * 三层结构（扫描层宽松、管理界面全量展示、provider 层严格注册）：
 *   1. 技能规范：只有含 SKILL.md 的一级子目录才是技能——readSkills 跳过无
 *      SKILL.md 的目录（含隐藏目录）；SKILL.md 存在但名称非法时保留
 *      valid=false + issue 供修复；
 *   2. Web/TUI 管理界面消费全量条目，灰显坏条目并展示原因；
 *   3. 注册给 ctx.skills 的 provider 只返回 valid=true 的候选，
 *      并尊重 frontmatter 的 disable-model-invocation / user-invocable 调用策略。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parseFrontmatter } from './skills-parse.ts'
import type { SkillEntry } from '../config.ts'

/** 官方 dsh-skill 的 SkillName 契约：kebab-case。 */
export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export interface SkillFolder {
  name: string
  /** 通过符号链接/junction 挂入的目录（删除类操作需谨慎）。 */
  linked: boolean
}

export function listSkillFolders(skillsDir: string): SkillFolder[] {
  try {
    return readdirSync(skillsDir, { withFileTypes: true }).flatMap((entry) => {
      // 技能名官方要求 kebab-case，点开头目录（.git/.github 等）永远不是技能。
      if (entry.name.startsWith('.')) return []
      if (entry.isDirectory()) return [{ name: entry.name, linked: false }]
      // Windows junction / 符号链接：dirent.isDirectory() 为 false，stat 跟随后按目录纳入。
      if (entry.isSymbolicLink()) {
        try {
          const target = statSync(join(skillsDir, entry.name))
          if (target.isDirectory()) return [{ name: entry.name, linked: true }]
        } catch {
          // 悬空链接跳过。
        }
      }
      return []
    }).sort((a, b) => a.name.localeCompare(b.name))
  } catch {
    return []
  }
}

/** 只有 valid=true 的条目才能进入 ctx.skills 注册表。 */
export function isValidSkill(entry: SkillEntry): boolean {
  return entry.valid
}

/** 供 provider 使用的合法条目集合（坏条目逐条跳过，绝不拖垮整批列表）。 */
export function validSkills(entries: SkillEntry[]): SkillEntry[] {
  return entries.filter((entry) => entry.valid)
}

/**
 * 读取技能目录的全部条目（含坏条目）。
 *  - frontmatter 无 name 时回退目录名；
 *  - name（frontmatter 或目录名）必须 kebab-case 才 valid；
 *  - SKILL.md 不可读的目录不是技能，直接跳过（不列为坏条目）；
 *  - warn 仅用于日志，不再决定条目去留。
 */
export function readSkills(skillsDir: string, warn?: (message: string) => void): SkillEntry[] {
  return listSkillFolders(skillsDir).flatMap((folder) => {
    const file = join(skillsDir, folder.name, 'SKILL.md')
    let raw: string
    try {
      raw = readFileSync(file, 'utf8')
    } catch {
      // 二级子目录由 SKILL.md 引导链接，不属于技能本体；缺失 SKILL.md 的目录跳过。
      warn?.(`prompt-tool: ${JSON.stringify(folder.name)} has no readable SKILL.md — skipped`)
      return []
    }

    const { data, body } = parseFrontmatter(raw)
    const declaredName = typeof data.name === 'string' && data.name.length > 0 ? data.name : folder.name
    const valid = SKILL_NAME_RE.test(declaredName)
    let issue: string | undefined
    if (!valid) {
      issue = `技能名不合法（官方要求 kebab-case 小写连字符）：${JSON.stringify(declaredName)}。请把目录改为 kebab-case，或修改 SKILL.md frontmatter 的 name。`
      warn?.(`prompt-tool: skill ${JSON.stringify(folder.name)} ignored — ${issue}`)
    }
    return [{
      folder: folder.name,
      file,
      name: declaredName,
      description: typeof data.description === 'string' && data.description.length > 0
        ? data.description
        : folder.name,
      ...(typeof data.whenToUse === 'string' ? { whenToUse: data.whenToUse } : {}),
      ...(data.metadata !== undefined ? { metadata: data.metadata } : {}),
      body: body.trim(),
      valid,
      ...(issue !== undefined ? { issue } : {}),
      ...(folder.linked ? { linked: true } : {}),
      modelInvocable: valid && data.disableModelInvocation !== true,
      userInvocable: valid && data.userInvocable !== false,
    }]
  })
}

/**
 * 进程内技能扫描缓存：按目录 + 每个 SKILL.md 的 mtime/size 签名失效。
 * 同一目录在内容未变化时，list/get 可复用同一次扫描结果。
 */
export interface CachedSkillsReader {
  read: (skillsDir: string, warn?: (message: string) => void) => SkillEntry[]
  invalidate: (skillsDir?: string) => void
}

function skillSignature(skillsDir: string): string {
  const folders = listSkillFolders(skillsDir)
  const parts: string[] = []
  for (const folder of folders) {
    const file = join(skillsDir, folder.name, 'SKILL.md')
    try {
      const stat = statSync(file)
      parts.push(`${folder.name}:${stat.mtimeMs}:${stat.size}`)
    } catch {
      parts.push(`${folder.name}:missing`)
    }
  }
  return parts.join('|')
}

export function createCachedSkillsReader(): CachedSkillsReader {
  const cache = new Map<string, { signature: string; entries: SkillEntry[] }>()

  const read = (skillsDir: string, warn?: (message: string) => void): SkillEntry[] => {
    const signature = skillSignature(skillsDir)
    const cached = cache.get(skillsDir)
    if (cached !== undefined && cached.signature === signature) return cached.entries
    const entries = readSkills(skillsDir, warn)
    cache.set(skillsDir, { signature, entries })
    return entries
  }

  const invalidate = (skillsDir?: string): void => {
    if (skillsDir === undefined) {
      cache.clear()
      return
    }
    cache.delete(skillsDir)
  }

  return { read, invalidate }
}
