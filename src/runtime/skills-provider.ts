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
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
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
 * 读取技能目录树的全部条目（含坏条目与嵌套子技能）。
 *  - 递归语义：技能目录（含 SKILL.md）的子目录可能是子技能（嵌套技能包），
 *    继续下探；不含 SKILL.md 的目录是资源/引导/仓库目录，不产生条目也不下探
 *    （根目录自身除外——根目录展开一级子目录发现技能）。
 *  - 链接（junction/symlink）目录作为技能叶子：含 SKILL.md 则注册，不递归进入（防环）。
 *  - frontmatter 无 name 时回退目录名；name（frontmatter 或目录名）必须 kebab-case 才 valid；
 *  - warn 仅用于日志，不再决定条目去留。
 */
export function readSkills(skillsDir: string, warn?: (message: string) => void): SkillEntry[] {
  const entries: SkillEntry[] = []
  const walk = (current: string, rel: string, linked: boolean): void => {
    const file = join(current, 'SKILL.md')
    let raw: string
    try {
      raw = readFileSync(file, 'utf8')
    } catch {
      if (linked || rel.length > 0) return
      // 根目录自身不是技能：只展开一级子目录发现技能；
      // 非技能子目录（资源/引导/仓库目录）不再下探，避免把其中的
      // SKILL.md（如 .agents/skills、docs）误注册为技能。
      for (const folder of listSkillFolders(current)) {
        walk(join(current, folder.name), folder.name, folder.linked)
      }
      return
    }
    const name = basename(current)
    const { data, body } = parseFrontmatter(raw)
    // 官方契约（skill-filesystem）：frontmatter 必须含 name 与 description，
    // name 必须 kebab-case；缺失时官方整条忽略——本项目保留管理面：标记
    // invalid + issue（UI 可见可修），不注册给模型。
    const source = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
    const hasFrontmatter = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.test(source)
    let issue: string | undefined
    if (!hasFrontmatter) {
      issue = 'SKILL.md 缺少 YAML frontmatter（官方要求 name 与 description）。请补全 frontmatter。'
    } else if (typeof data.name !== 'string' || data.name.length === 0) {
      issue = 'frontmatter 缺少 name（官方要求 kebab-case 技能名）。'
    } else if (typeof data.description !== 'string' || data.description.length === 0) {
      issue = 'frontmatter 缺少 description（官方必填字段）。'
    }
    const declaredName = typeof data.name === 'string' && data.name.length > 0 ? data.name : name
    const valid = issue === undefined && SKILL_NAME_RE.test(declaredName)
    if (valid === false && issue === undefined) {
      issue = `技能名不合法（官方要求 kebab-case 小写连字符）：${JSON.stringify(declaredName)}。请把目录改为 kebab-case，或修改 SKILL.md frontmatter 的 name。`
    }
    if (issue !== undefined) {
      warn?.(`prompt-tool: skill ${JSON.stringify(rel)} ignored — ${issue}`)
    }
    entries.push({
      dir: skillsDir,
      folder: rel.length > 0 ? rel : name,
      file,
      name: declaredName,
      description: typeof data.description === 'string' ? data.description : '',
      ...(typeof data.whenToUse === 'string' ? { whenToUse: data.whenToUse } : {}),
      ...(data.metadata !== undefined ? { metadata: data.metadata } : {}),
      body: body.trim(),
      valid,
      ...(issue !== undefined ? { issue } : {}),
      ...(linked ? { linked: true } : {}),
      modelInvocable: valid && data.disableModelInvocation !== true,
      userInvocable: valid && data.userInvocable !== false,
    })
    // 技能目录下的一级子目录可能含 SKILL.md（嵌套子技能），继续下探。
    if (!linked) {
      for (const folder of listSkillFolders(current)) {
        walk(join(current, folder.name), `${rel}/${folder.name}`, folder.linked)
      }
    }
  }
  walk(skillsDir, '', false)
  return entries
}

/** 多目录全量合并：条目全部保留（同名不跳过，UI 层再做 duplicate 标注）。 */
export function mergeSkillDirs(
  dirs: string[],
  read: (dir: string, warn?: (message: string) => void) => SkillEntry[],
  warn?: (message: string) => void,
): SkillEntry[] {
  return dirs.flatMap((dir) => read(dir, warn))
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
  const files: string[] = []
  const walk = (current: string, linked: boolean): void => {
    const file = join(current, 'SKILL.md')
    if (existsSync(file)) files.push(file)
    if (linked) return
    for (const folder of listSkillFolders(current)) {
      walk(join(current, folder.name), folder.linked)
    }
  }
  walk(skillsDir, false)
  return files.map((file) => {
    try {
      const stat = statSync(file)
      return `${basename(dirname(file))}:${stat.mtimeMs}:${stat.size}`
    } catch {
      return `${file}:missing`
    }
  }).join('|')
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
