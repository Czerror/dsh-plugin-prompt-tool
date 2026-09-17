/** 技能清单扫描：与官方 `dsh-skill-filesystem` 相同的六类技能根与"一层发现"规则，只读不改动。
 *  技能实体始终留在原处；本模块只负责把"现在有哪些技能、来自哪里、谁会被模型看到"算清楚。 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { parseFrontmatter } from '../runtime/skills-parse.ts'
import {
  SKILL_MARKER,
  SKILL_SOURCES,
  type SkillCatalogEntry,
  type SkillSourceKind,
} from '../shared/skills.ts'
import { SKILL_NAME_PATTERN } from './skills-config.ts'

export interface ScanRoot {
  kind: SkillSourceKind
  path: string
}

/** 一条扫描结果：清单展示与提供者候选都由它派生。 */
export interface ScannedSkill {
  id: string
  source: SkillSourceKind
  rank: number
  /** 来源根绝对路径。 */
  dir: string
  folder: string
  file: string
  name: string
  description: string
  whenToUse?: string
  metadata?: Record<string, unknown>
  body: string
  valid: boolean
  issue?: string
  modelInvocable: boolean
  userInvocable: boolean
}

export function resolveAgentsHome(): string {
  const configured = process.env.DSH_AGENTS_HOME
  return resolve(configured !== undefined && configured.length > 0 ? configured : join(homedir(), '.agents'))
}

export function resolveBundledSkillsDir(): string | undefined {
  const configured = process.env.DSH_BUNDLED_SKILL_DIR
  return configured === undefined || configured.length === 0 ? undefined : resolve(configured)
}

/** 项目根：从工作目录向上找第一个含 `.git` 的目录，找不到就用工作目录本身（与官方一致）。 */
export function resolveProjectRoot(cwd: string): string {
  const start = resolve(cwd)
  let current = start
  for (;;) {
    if (existsSync(join(current, '.git'))) return current
    const parent = dirname(current)
    if (parent === current) return start
    current = parent
  }
}

/** 六类技能根（与官方顺序一致：项目 > 引用目录 > 用户 > 内置）。 */
export function skillRoots(options: { cwd?: string; dshHome: string; folders: readonly string[] }): ScanRoot[] {
  const roots: ScanRoot[] = []
  if (options.cwd !== undefined && options.cwd.length > 0) {
    const project = resolveProjectRoot(options.cwd)
    roots.push({ kind: 'project-dsh', path: join(project, '.dsh', 'skills') })
    roots.push({ kind: 'project-agents', path: join(project, '.agents', 'skills') })
  }
  for (const folder of options.folders) roots.push({ kind: 'custom', path: folder })
  roots.push({ kind: 'user-dsh', path: join(options.dshHome, 'skills') })
  roots.push({ kind: 'user-agents', path: join(resolveAgentsHome(), 'skills') })
  const bundled = resolveBundledSkillsDir()
  if (bundled !== undefined) roots.push({ kind: 'bundled', path: bundled })
  return roots
}

function isDirectory(path: string): boolean {
  try { return statSync(path).isDirectory() } catch { return false }
}

function readEntries(root: ScanRoot): string[] {
  try {
    return readdirSync(root.path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right))
  } catch { return [] }
}

/** 扫描一个技能根：只认 `<根>/<目录名>/SKILL.md`（官方一层发现，不递归嵌套）。 */
export function scanRoot(root: ScanRoot): ScannedSkill[] {
  if (!isDirectory(root.path)) return []
  const skills: ScannedSkill[] = []
  for (const folder of readEntries(root)) {
    const dir = join(root.path, folder)
    const file = join(dir, SKILL_MARKER)
    if (!existsSync(file)) continue
    let raw: string
    try { raw = readFileSync(file, 'utf8') } catch { continue }
    const { data, body, issue: parseIssue } = parseFrontmatter(raw)
    const declared = typeof data.name === 'string' && data.name.length > 0 ? data.name : folder
    const description = typeof data.description === 'string' ? data.description : ''
    let issue = parseIssue
    if (issue === undefined && typeof data.name !== 'string') issue = 'frontmatter 缺少 name'
    else if (issue === undefined && description.length === 0) issue = 'frontmatter 缺少 description'
    if (issue === undefined && !SKILL_NAME_PATTERN.test(declared)) issue = `技能名不是 kebab-case：${declared}`
    const valid = issue === undefined
    skills.push({
      id: `${root.kind}:${root.path}:${folder}`,
      source: root.kind,
      rank: SKILL_SOURCES[root.kind].rank,
      dir: root.path,
      folder,
      file,
      name: valid ? declared : folder,
      description,
      ...(typeof data.whenToUse === 'string' ? { whenToUse: data.whenToUse } : {}),
      ...(data.metadata !== undefined ? { metadata: data.metadata } : {}),
      body,
      valid,
      ...(issue !== undefined ? { issue } : {}),
      modelInvocable: data.disableModelInvocation !== true,
      userInvocable: data.userInvocable !== false,
    })
  }
  return skills
}

export function scanRoots(roots: readonly ScanRoot[]): ScannedSkill[] {
  return roots.flatMap((root) => scanRoot(root))
}

/** 技能根指纹：各根下技能目录与标记文件的修改时间。
 *  清单与候选缓存据此在文件系统变化后失效——项目根随会话 cwd 变化，静态 watcher 覆盖不到
 *  全部工作区，指纹是唯一能兜住六类来源（含手工增删）的判据。 */
export function rootsFingerprint(roots: readonly ScanRoot[]): string {
  return roots.map((root) => {
    let stamp = '-'
    try {
      stamp = readdirSync(root.path, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => {
          let marker = '-'
          try {
            const info = statSync(join(root.path, entry.name, SKILL_MARKER))
            // 三个字段都来自同一次 stat：size 抓「内容长度变了」，mtimeMs 抓普通改写，
            // ctimeMs 抓「等长改写 + mtime 被还原或落在同一刻度」——utimes 改不动 ctime。
            // 这是启发式判据：绝对精确要读全文哈希，代价是每个技能一次读盘。
            marker = `${info.mtimeMs}:${info.size}:${info.ctimeMs}`
          } catch { /* 缺标记文件的目录按 '-' 计 */ }
          return `${entry.name}:${marker}`
        })
        .sort()
        .join(',')
    } catch { /* 根不存在或不可读：空指纹 */ }
    return `${root.kind}|${root.path}|${stamp}`
  }).join(';')
}

/** 同名裁决：按来源优先级升序取首个有效技能，其余标注"被遮蔽"。 */
export function markWinners(skills: readonly ScannedSkill[]): Map<string, string> {
  const winners = new Map<string, string>()
  for (const skill of [...skills].sort((left, right) => left.rank - right.rank || left.id.localeCompare(right.id))) {
    if (!skill.valid || winners.has(skill.name)) continue
    winners.set(skill.name, skill.id)
  }
  return winners
}

/** 扫描结果 → 清单条目（附加同名遮蔽信息；调用策略直接取自 frontmatter）。 */
export function catalogFromScan(skills: readonly ScannedSkill[]): SkillCatalogEntry[] {
  const winners = markWinners(skills)
  return skills.map((skill) => {
    const winnerId = winners.get(skill.name)
    return {
      id: skill.id,
      name: skill.name,
      description: skill.description,
      folder: skill.folder,
      dir: skill.dir,
      source: skill.source,
      rank: skill.rank,
      valid: skill.valid,
      ...(skill.issue !== undefined ? { issue: skill.issue } : {}),
      modelInvocable: skill.modelInvocable,
      userInvocable: skill.userInvocable,
      ...(winnerId !== undefined && winnerId !== skill.id ? { winnerId } : {}),
      path: skill.file,
    }
  })
}
