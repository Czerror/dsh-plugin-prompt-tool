/** 管理面只读扫描本地资产与诊断；模型候选、作用域和胜出关系属于官方注册表。 */
import { accessSync, constants, existsSync, lstatSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import type { SkillSummary } from '@deepseek-ai/dsh-skill'
import { parseFrontmatter } from '../runtime/skills-parse.ts'
import { SKILL_MARKER, SKILL_SOURCES, type SkillCatalogEntry, type SkillSourceKind } from '../shared/skills.ts'
import { SKILL_NAME_PATTERN } from './skills-config.ts'
import { readSkillInvocation } from './skills-policy.ts'
import { assertUnlinkedPath } from './skills-actions.ts'

export interface ScanRoot { kind: SkillSourceKind; path: string }

export interface ScannedSkill {
  id: string
  source: SkillSourceKind
  rank: number
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

/** 能力投影也核验祖先链接；服务端每次写入前仍重新核验。 */
export function skillWriteRestriction(file: string): string | undefined {
  try {
    if (resolve(file).split(sep).some((segment) => segment.toLowerCase() === '.system')) return '系统技能只读'
    assertUnlinkedPath(file)
    const info = lstatSync(file)
    if (!info.isFile()) return '技能标记不是普通文件'
    if ((info.mode & 0o222) === 0 || (lstatSync(dirname(file)).mode & 0o222) === 0) return '技能文件或所在目录只读'
    accessSync(file, constants.W_OK)
    accessSync(dirname(file), constants.W_OK)
    return undefined
  } catch (error) { return `技能只读：${error instanceof Error ? error.message : String(error)}` }
}

/** 只扫描普通目录包和直属 Markdown 文件；链接技能由 registry 补充为只读条目。 */
export function scanRoot(root: ScanRoot): ScannedSkill[] {
  let entries
  try {
    if (!statSync(root.path).isDirectory()) return []
    entries = readdirSync(root.path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
  } catch { return [] }
  const skills: ScannedSkill[] = []
  for (const entry of entries) {
    if (entry.name === '.system') continue
    const file = entry.isDirectory() ? join(root.path, entry.name, SKILL_MARKER)
      : entry.isFile() && entry.name.endsWith('.md') ? join(root.path, entry.name) : undefined
    if (file === undefined) continue
    let raw: string
    try { raw = readFileSync(file, 'utf8') } catch { continue }
    const { data, body, issue: parseIssue } = parseFrontmatter(raw)
    const fallback = entry.isDirectory() ? entry.name : basename(entry.name, '.md')
    const declared = typeof data.name === 'string' && data.name.length > 0 ? data.name : fallback
    const description = typeof data.description === 'string' ? data.description : ''
    let issue = parseIssue
    if (issue === undefined && (typeof data.name !== 'string' || data.name.length === 0)) issue = 'frontmatter 缺少 name'
    else if (issue === undefined && description.length === 0) issue = 'frontmatter 缺少 description'
    if (issue === undefined && !SKILL_NAME_PATTERN.test(declared)) issue = `技能名不是 kebab-case：${declared}`
    skills.push({
      id: `${root.kind}:${root.path}:${entry.name}`,
      source: root.kind, rank: SKILL_SOURCES[root.kind].rank, dir: root.path,
      folder: entry.name, file, name: issue === undefined ? declared : fallback, description,
      ...(typeof data.whenToUse === 'string' ? { whenToUse: data.whenToUse } : {}),
      ...(data.metadata !== undefined ? { metadata: data.metadata } : {}),
      body, valid: issue === undefined, ...(issue === undefined ? {} : { issue }),
      modelInvocable: data.disableModelInvocation !== true,
      userInvocable: data.userInvocable !== false,
    })
  }
  return skills
}

export function scanRoots(roots: readonly ScanRoot[]): ScannedSkill[] {
  return roots.flatMap(scanRoot)
}

export function catalogFromScan(skills: readonly ScannedSkill[]): SkillCatalogEntry[] {
  return skills.map((skill) => {
    const restriction = skill.source === 'bundled' || skill.source === 'other' ? '官方或提供方管理的技能只读' : skillWriteRestriction(skill.file)
    const policy = restriction === undefined && skill.valid ? readSkillInvocation(skill.file) : undefined
    const readonlyReason = restriction ?? skill.issue ?? (policy?.ok === false ? policy.message : undefined)
    return {
      id: skill.id, name: skill.name, description: skill.description, folder: skill.folder,
      dir: skill.dir, source: skill.source, rank: skill.rank, valid: skill.valid,
      ...(skill.issue === undefined ? {} : { issue: skill.issue }),
      modelInvocable: skill.modelInvocable, userInvocable: skill.userInvocable, path: skill.file,
      availability: 'unknown', canSetPolicy: readonlyReason === undefined,
      canDelete: skill.valid && restriction === undefined && (skill.source === 'custom' || skill.source === 'user-dsh'),
      ...(readonlyReason === undefined ? {} : { readonlyReason }),
    }
  })
}

export const skillPathKey = (path: string): string => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)

/**
 * 技能视图回退：带 scope 的查询只读该视图层（官方 SkillViewOptions 注释：
 * omitted reads the global layer alone），技能装在全局层时它整表为空；而空
 * resolved 会让 withSkillWinners 把每个条目判成 unregistered，整个技能页显示
 * 「当前会话未注册」。视图为空时改用全局视图，与全局层技能的存放位置一致；
 * 全局视图同样为空时保留原视图，不虚构条目。
 *
 * @param scoped - 带 scope 的查询结果。
 * @param readGlobal - 惰性读取不带 scope 的全局视图；仅在 scoped 为空时调用。
 * @returns 非空的那个视图；两者皆空时返回 scoped。
 */
export async function withGlobalSkillFallback<T extends { skills: readonly unknown[] }>(
  scoped: T,
  readGlobal: () => Promise<T>,
): Promise<T> {
  if (scoped.skills.length > 0) return scoped
  const global = await readGlobal()
  return global.skills.length > 0 ? global : scoped
}

type ResolvedSkill = Pick<SkillSummary, 'name' | 'path'> & Partial<SkillSummary>

/** 当前会话快照负责胜出关系；不完整观测不能宣称任何条目已经生效或确定缺席。 */
export function withSkillWinners(entries: readonly SkillCatalogEntry[], resolved: readonly ResolvedSkill[], complete = true): SkillCatalogEntry[] {
  const matches = (entry: SkillCatalogEntry, skill: ResolvedSkill): boolean => entry.name === skill.name
    && entry.path !== undefined && skill.path !== undefined && skillPathKey(entry.path) === skillPathKey(skill.path)
  const catalog = [...entries]
  for (const skill of resolved) {
    if (catalog.some((entry) => matches(entry, skill))) continue
    const source = Object.hasOwn(SKILL_SOURCES, skill.source ?? 'other') ? (skill.source ?? 'other') as SkillSourceKind : 'other'
    const bundle = skill.path !== undefined && basename(skill.path) === SKILL_MARKER
    catalog.push({
      id: `registry:${skill.provider ?? ''}:${skill.name}`, name: skill.name, description: skill.description ?? '',
      folder: skill.path === undefined ? skill.name : basename(bundle ? dirname(skill.path) : skill.path),
      dir: skill.path === undefined ? '' : dirname(bundle ? dirname(skill.path) : skill.path),
      source, rank: SKILL_SOURCES[source].rank, valid: true,
      modelInvocable: skill.invocation?.modelInvocable ?? true, userInvocable: skill.invocation?.userInvocable ?? true,
      ...(skill.path === undefined ? {} : { path: skill.path }),
      ...(skill.provider === undefined ? {} : { provider: skill.provider }),
      canSetPolicy: false, canDelete: false, readonlyReason: '未命中可管理的本地资产，提供方技能只读',
    })
  }
  const winners = new Map(resolved.map((skill) => [skill.name, skill]))
  return catalog.map(({ winnerId: _previous, ...entry }) => {
    const winner = winners.get(entry.name)
    if (!complete) return { ...entry, availability: 'unknown' }
    if (!entry.valid || winner === undefined) return { ...entry, availability: 'unregistered' }
    const active = matches(entry, winner) || entry.id === `registry:${winner.provider ?? ''}:${winner.name}`
    if (active) return {
      ...entry, availability: 'active',
      ...(winner.provider === undefined ? {} : { provider: winner.provider }),
    }
    const visible = catalog.find((other) => matches(other, winner))
    return { ...entry, availability: 'shadowed', winnerId: visible?.id ?? `registry:${winner.provider ?? ''}:${winner.name}` }
  })
}
