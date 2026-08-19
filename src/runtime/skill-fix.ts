/**
 * skill-fix — 对扫描层标记为无效的技能做一键修复。
 *
 * 修复范围严格限定在 activeSkillsDir 内：
 *   - 剥 UTF-8 BOM；
 *   - frontmatter `name` 缺失或非 kebab-case 时改写/补写为目录同名；
 *   - 目录名非 kebab-case 时重命名为合法目录（目标存在时追加数字后缀）。
 * 其余内容（description/whenToUse/metadata/正文）逐字节保留。
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { randomBytes } from 'node:crypto'
import { parseFrontmatter } from './skills-parse.ts'
import { SKILL_NAME_RE } from './skills-provider.ts'

export interface SkillFixResult {
  fixed: boolean
  /** 修复前目录名。 */
  folder: string
  /** 修复后目录名。 */
  fixedFolder: string
  /** 修复后注册名（与目录一致）。 */
  name: string
  /** 实际执行的动作描述（写文件/重命名/剥 BOM/补 name）。 */
  actions: string[]
  error?: string
}

/** 任意字符串 → kebab-case；空结果回退 'skill'。 */
export function toKebabName(value: string): string {
  let name = value.trim().toLowerCase()
  name = name.replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '')
  name = name.replace(/-+/g, '-').replace(/^-+|-+$/g, '')
  return name.length > 0 ? name : 'skill'
}

/** 在 root 下选一个不冲突的 kebab 目录名。 */
function uniqueKebab(root: string, name: string): string {
  let candidate = name
  let suffix = 2
  while (existsSync(join(root, candidate))) {
    candidate = `${name}-${suffix}`
    suffix += 1
  }
  return candidate
}

/** 目标名优先从目录名派生（Premium Web → premium-web）；目录名无拉丁字符时再尝试 frontmatter name。 */
function deriveKebab(folder: string, declaredName: string): string {
  const fromFolder = toKebabName(folder)
  if (fromFolder !== 'skill') return fromFolder
  const fromName = toKebabName(declaredName)
  return fromName !== 'skill' ? fromName : 'skill'
}

/** tmp + rename 原子写，保留原文件直至新内容完整落盘。 */
function writeFileAtomic(file: string, content: string): void {
  const tmp = `${file}.${Date.now().toString(36)}.${randomBytes(6).toString('hex')}.tmp`
  writeFileSync(tmp, content, { encoding: 'utf8', flag: 'wx' })
  renameSync(tmp, file)
}

/** 把 SKILL.md 的 frontmatter name 改写/补写为目标值，正文与其余字段逐字保留。 */
function rewriteName(content: string, name: string): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)
  if (match === null) return `---\nname: ${name}\n---\n\n${content}`
  const lines = (match[1] ?? '').split(/\r?\n/)
  const at = lines.findIndex((line) => /^name\s*:/.test(line))
  if (at >= 0) lines[at] = `name: ${name}`
  else lines.splice(0, 0, `name: ${name}`)
  return `---\n${lines.join('\n')}\n---${content.slice((match[0] ?? '').length)}`
}

/**
 * 修复一个无效技能条目。
 * @param skillsDir - activeSkillsDir（绝对路径）。
 * @param folder - 要修复的目录名（不允许含路径分隔符）。
 */
export function fixSkillEntry(skillsDir: string, folder: string): SkillFixResult {
  if (typeof skillsDir !== 'string' || skillsDir.length === 0 || typeof folder !== 'string' || folder.length === 0
    || folder.includes('/') || folder.includes('\\') || folder === '.' || folder === '..') {
    return { fixed: false, folder, fixedFolder: folder, name: folder, actions: [], error: '非法目录名' }
  }
  const root = resolve(skillsDir)
  const sourceDir = resolve(join(root, folder))
  if (!sourceDir.startsWith(root + sep) || !existsSync(sourceDir)) {
    return { fixed: false, folder, fixedFolder: folder, name: folder, actions: [], error: `目录不存在：${folder}` }
  }
  const file = join(sourceDir, 'SKILL.md')
  if (!existsSync(file)) {
    return { fixed: false, folder, fixedFolder: folder, name: folder, actions: [], error: 'SKILL.md 不存在，无法自动修复' }
  }

  let content = readFileSync(file, 'utf8')
  const hadBom = content.charCodeAt(0) === 0xfeff
  if (hadBom) content = content.slice(1)

  const { data } = parseFrontmatter(content)
  const declaredName = typeof data.name === 'string' && data.name.length > 0 ? data.name : folder
  const nameValid = SKILL_NAME_RE.test(declaredName)
  const folderValid = SKILL_NAME_RE.test(folder)
  const fixedFolder = folderValid ? folder : uniqueKebab(root, deriveKebab(folder, declaredName))
  const fixedName = fixedFolder
  const actions: string[] = []

  let next = content
  if (!nameValid || declaredName !== fixedName) {
    next = rewriteName(next, fixedName)
    actions.push(`name: ${JSON.stringify(declaredName)} → ${fixedName}`)
  }
  if (hadBom) actions.push('移除 UTF-8 BOM')

  if (folder !== fixedFolder) {
    renameSync(sourceDir, join(root, fixedFolder))
    actions.push(`目录重命名：${folder} → ${fixedFolder}`)
  }
  const targetFile = join(root, fixedFolder, 'SKILL.md')
  if (!nameValid || hadBom || declaredName !== fixedName) {
    writeFileAtomic(targetFile, next)
    actions.push('SKILL.md 已原子重写')
  }
  return { fixed: true, folder, fixedFolder, name: fixedName, actions }
}
