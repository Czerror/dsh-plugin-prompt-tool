/** skills 目录扫描与 SKILL.md frontmatter 读取(纯函数,按官方 dsh-skill 契约校验)。 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parseFrontmatter } from '../preset-core.ts'
import type { SkillEntry } from '../config.ts'

/** 官方 dsh-skill 的 SkillName 契约:kebab-case。 */
export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export function listSkillFolders(skillsDir: string): string[] {
  try {
    return readdirSync(skillsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b))
  } catch {
    return []
  }
}

/**
 * 读取技能目录;只返回能通过官方 dsh-skill 校验的条目:
 *   - name 必须 kebab-case(SKILL_NAME_RE),否则整个技能跳过(与官方 filesystem provider 一致);
 *   - description 缺失时回退目录名(保证老技能可用)。
 * 无效条目通过 warn 回调告警一次(由调用方去重)。
 */
export function readSkills(skillsDir: string, warn?: (message: string) => void): SkillEntry[] {
  return listSkillFolders(skillsDir).flatMap((folder) => {
    const file = join(skillsDir, folder, 'SKILL.md')
    try {
      const raw = readFileSync(file, 'utf8')
      const { data, body } = parseFrontmatter(raw)
      const name = typeof data.name === 'string' && SKILL_NAME_RE.test(data.name)
        ? data.name
        : SKILL_NAME_RE.test(folder)
          ? folder
          : undefined
      if (name === undefined) {
        warn?.(`prompt-tool: skill ${JSON.stringify(folder)} ignored — skill name must be kebab-case (${SKILL_NAME_RE})`)
        return []
      }
      return [{
        folder,
        file,
        name,
        description: typeof data.description === 'string' && data.description.length > 0
          ? data.description
          : folder,
        ...(typeof data.whenToUse === 'string' ? { whenToUse: data.whenToUse } : {}),
        ...(data.metadata !== undefined ? { metadata: data.metadata } : {}),
        body: body.trim(),
      }]
    } catch {
      warn?.(`prompt-tool: skill ${JSON.stringify(folder)} ignored — SKILL.md unreadable`)
      return []
    }
  })
}
