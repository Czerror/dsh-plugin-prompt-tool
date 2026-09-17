/** 技能管理的共享契约：技能实体由官方发现，插件只维护屏蔽表与引用目录。 */
export const SKILL_MARKER = 'SKILL.md'

/** 技能状态文件版本（v3 = 注册层屏蔽模型）。 */
export const SKILLS_STATE_VERSION = 3

/** 官方技能根分类；数值越小越优先，与官方 rank 一致。 */
export type SkillSourceKind =
  | 'project-dsh'
  | 'project-agents'
  | 'custom'
  | 'user-dsh'
  | 'user-agents'
  | 'bundled'

/** 来源优先级：与官方六类技能根的次序一致（数值越小越优先）。
 *  展示名不在这里——标题由界面按 `skills.source.<kind>` 取字典，避免同一批文案出现两处真相。 */
export const SKILL_SOURCES: Record<SkillSourceKind, { rank: number }> = {
  'project-dsh': { rank: 100 },
  'project-agents': { rank: 200 },
  custom: { rank: 300 },
  'user-dsh': { rank: 400 },
  'user-agents': { rank: 500 },
  bundled: { rank: 600 },
}

/** 屏蔽记录的影子候选优先级：小于全部官方根（最小 100），因此任何来源的同名技能都会被压掉。 */
export const SKILL_BLOCK_RANK = 0

/** 一条屏蔽记录；只按技能名生效，不改动任何技能文件。 */
export interface BlockedSkill {
  /** 技能名（frontmatter name，kebab-case）。 */
  name: string
  /** 记录时间（ISO 字符串）。 */
  at: string
  note?: string
  /** false = 不屏蔽模型端（即只屏蔽用户端）。 */
  model?: boolean
  /** false = 不屏蔽用户端（即只屏蔽模型端）。 */
  user?: boolean
}

/** 屏蔽范围：两端独立控制，全部在注册层生效（不改技能文件）。 */
export type SkillBlockScope = 'none' | 'model' | 'user' | 'all'

/** 记录 → 范围（缺省视为屏蔽该端）。 */
export function blockScopeOf(record: BlockedSkill): SkillBlockScope {
  const model = record.model !== false
  const user = record.user !== false
  if (model && user) return 'all'
  if (model) return 'model'
  if (user) return 'user'
  return 'none'
}

/** 范围 → 记录；两端都不屏蔽时没有记录，调用方应删除该条。 */
export function blockRecordFor(name: string, scope: Exclude<SkillBlockScope, 'none'>, at: string): BlockedSkill {
  if (scope === 'model') return { name, at, user: false }
  if (scope === 'user') return { name, at, model: false }
  return { name, at }
}

/** 插件技能状态：屏蔽表 + 用户显式引用的技能文件夹（绝对路径，按引用顺序）。 */
export interface SkillsState {
  version: number
  blocked: BlockedSkill[]
  folders: string[]
}

/** 清单条目：由插件扫描六类官方技能根得到，是管理面的事实来源。 */
export interface SkillCatalogEntry {
  /** 稳定键：来源类别 + 来源根 + 目录名。 */
  id: string
  /** frontmatter name（缺失时回退目录名）。 */
  name: string
  description: string
  /** 技能目录名（一层扫描，与官方发现规则一致）。 */
  folder: string
  /** 来源根的绝对路径。 */
  dir: string
  source: SkillSourceKind
  /** 来源优先级（越小越优先）。 */
  rank: number
  valid: boolean
  issue?: string
  /** 是否被屏蔽（至少一端，注册层影子候选生效中）。 */
  blocked: boolean
  /** 插件是否屏蔽了模型端。 */
  blockedModel: boolean
  /** 插件是否屏蔽了用户端。 */
  blockedUser: boolean
  /** frontmatter 声明的调用策略（只读事实，不受插件屏蔽影响）。 */
  modelInvocable: boolean
  userInvocable: boolean
  /** 同名技能中的胜出者 id；本项未胜出时用于提示"被同名技能遮蔽"。 */
  winnerId?: string
  /** 标记文件绝对路径。 */
  path?: string
}
