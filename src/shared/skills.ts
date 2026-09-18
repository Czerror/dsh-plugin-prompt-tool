/** 技能管理的共享契约：技能实体由官方发现，**调用策略写在技能文件自己的 frontmatter 里**。
 *
 *  为什么不再有「屏蔽表」：注册层的同名裁决是「最近层无视优先级直接胜出」（官方 `dsh-skill` 的
 *  `collectFresh`），而本插件的提供方在 profile/全局层、官方文件提供方由预设常驻组合挂在预设层，
 *  影子候选必然被预设层候选覆盖。停用改为改写技能文件的两个官方调用策略键后，任何装配下都成立。 */
export const SKILL_MARKER = 'SKILL.md'

/** 技能状态文件版本（v4：状态文件只保存引用目录，调用策略回到技能文件）。
 *  v3 里的 `blocked` 屏蔽表已弃用，读取时忽略、写入时删除。 */
export const SKILLS_STATE_VERSION = 4

/** 官方技能根分类；数值越小越优先，与官方 rank 一致。 */
export type SkillSourceKind =
  | 'project-dsh'
  | 'project-agents'
  | 'custom'
  | 'user-dsh'
  | 'user-agents'
  | 'bundled'
  | 'other'

/** 来源优先级：与官方六类技能根的次序一致（数值越小越优先）。
 *  展示名不在这里——标题由界面按 `skills.source.<kind>` 取字典，避免同一批文案出现两处真相。 */
export const SKILL_SOURCES: Record<SkillSourceKind, { rank: number }> = {
  'project-dsh': { rank: 100 },
  'project-agents': { rank: 200 },
  custom: { rank: 300 },
  'user-dsh': { rank: 400 },
  'user-agents': { rank: 500 },
  bundled: { rank: 600 },
  other: { rank: 700 },
}

/** 两个官方调用策略键：值就是「该端是否可调用」。 */
export interface SkillInvocation {
  /** `disable-model-invocation`：false 时模型不可发现、不可加载。 */
  modelInvocable: boolean
  /** `user-invocable`：false 时用户斜杠命令不可加载。 */
  userInvocable: boolean
}

/** 两端调用策略的目标范围：'model' = 只让模型端不可调用，'user' = 只让用户端不可调用，
 *  'all' = 两端都不可调用，'none' = 两端都恢复可调用。语义是「点击之后的目标状态」。 */
export type SkillPolicyScope = 'none' | 'model' | 'user' | 'all'

/** 单端操作不携带另一端的旧快照；显式 scope 供两端批量操作和 TUI 使用。 */
export type SkillPolicyChange = { side: 'model' | 'user'; enabled: boolean } | { scope: SkillPolicyScope }

export interface SkillsCatalogSnapshot {
  skills: SkillCatalogEntry[]
  /** false 表示观测不完整，不能把未发现解释成不存在。 */
  complete: boolean
}

/** 目标范围 → 两个键的写入意图（true = 该端可调用）。 */
export function invocationForScope(scope: SkillPolicyScope): SkillInvocation {
  return {
    modelInvocable: scope === 'none' || scope === 'user',
    userInvocable: scope === 'none' || scope === 'model',
  }
}

/** 当前两端状态 → 范围（两端都可调用时为 'none'）。 */
export function scopeOfInvocation(invocation: SkillInvocation): SkillPolicyScope {
  if (invocation.modelInvocable && invocation.userInvocable) return 'none'
  if (!invocation.modelInvocable && !invocation.userInvocable) return 'all'
  return invocation.modelInvocable ? 'user' : 'model'
}

/** 插件技能状态：只剩用户显式引用的技能文件夹（绝对路径，按引用顺序）。
 *  技能是否可调用由技能文件自己声明，不再进状态文件。 */
export interface SkillsState {
  version: number
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
  /** frontmatter 声明的模型端调用策略（唯一事实，缺省为可调用）。 */
  modelInvocable: boolean
  /** frontmatter 声明的用户端调用策略（唯一事实，缺省为可调用）。 */
  userInvocable: boolean
  /** 同名技能中的胜出者 id；本项未胜出时用于提示"被同名技能遮蔽"。 */
  winnerId?: string
  /** 标记文件绝对路径（调用策略的写入目标与身份校验依据）。 */
  path?: string
  /** 同名遮蔽事实：只有注册表确实报了同名技能时才标注；其余条目按文件声明为事实。 */
  availability?: 'active' | 'shadowed'
  provider?: string
  canSetPolicy?: boolean
  canDelete?: boolean
  readonlyReason?: string
}
