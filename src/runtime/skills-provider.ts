/**
 * skills 目录扫描与 SKILL.md frontmatter 读取（纯函数）。
 *
 * 三层结构（扫描层宽松、管理界面全量展示、provider 层严格注册）：
 *   1. readSkills 返回目录内所有条目，坏条目不静默丢弃，而是 valid=false + issue；
 *   2. Web/TUI 管理界面消费全量条目，灰显坏条目并展示原因；
 *   3. 注册给 ctx.skills 的 provider 只返回 valid=true 的候选，
 *      并尊重 frontmatter 的 disable-model-invocation / user-invocable 调用策略。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parseFrontmatter } from '../preset-core.ts'
import type { SkillEntry } from '../config.ts'

/** 官方 dsh-skill 的 SkillName 契约：kebab-case。 */
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
 *  - SKILL.md 不可读时条目保留并标记 issue；
 *  - warn 仅用于日志，不再决定条目去留。
 */
export function readSkills(skillsDir: string, warn?: (message: string) => void): SkillEntry[] {
  return listSkillFolders(skillsDir).flatMap((folder) => {
    const file = join(skillsDir, folder, 'SKILL.md')
    let raw: string
    try {
      raw = readFileSync(file, 'utf8')
    } catch {
      const issue = 'SKILL.md 不可读或不存在'
      warn?.(`prompt-tool: skill ${JSON.stringify(folder)} ignored — ${issue}`)
      return [{
        folder,
        file,
        name: folder,
        description: '',
        body: '',
        valid: false,
        issue,
        modelInvocable: false,
        userInvocable: false,
      }]
    }

    const { data, body } = parseFrontmatter(raw)
    const declaredName = typeof data.name === 'string' && data.name.length > 0 ? data.name : folder
    const valid = SKILL_NAME_RE.test(declaredName)
    let issue: string | undefined
    if (!valid) {
      issue = `技能名不合法（官方要求 kebab-case 小写连字符）：${JSON.stringify(declaredName)}。请把目录改为 kebab-case，或修改 SKILL.md frontmatter 的 name。`
      warn?.(`prompt-tool: skill ${JSON.stringify(folder)} ignored — ${issue}`)
    }
    return [{
      folder,
      file,
      name: declaredName,
      description: typeof data.description === 'string' && data.description.length > 0
        ? data.description
        : folder,
      ...(typeof data.whenToUse === 'string' ? { whenToUse: data.whenToUse } : {}),
      ...(data.metadata !== undefined ? { metadata: data.metadata } : {}),
      body: body.trim(),
      valid,
      ...(issue !== undefined ? { issue } : {}),
      modelInvocable: valid && data.disableModelInvocation !== true,
      userInvocable: valid && data.userInvocable !== false,
    }]
  })
}
