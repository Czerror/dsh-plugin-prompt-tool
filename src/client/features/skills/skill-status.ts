import type { SkillCatalogEntry } from '../../data/prompt-tool-fields.ts'
import { SKILL_SOURCES, type SkillBlockScope, type SkillSourceKind } from '../../../shared/skills.ts'
import type { StatusBadgeTone } from '../../ui/StatusBadge.tsx'
import type { PromptToolTranslate } from '../../locales.ts'

export type SkillStatusTab = 'all' | 'model' | 'user' | 'blocked'

/** 实际生效判定：非法技能不注册；被屏蔽的技能在注册层被影子候选压掉。 */
export const skillEnabled = (skill: SkillCatalogEntry): boolean => skill.valid && skill.blocked !== true

/** 模型端是否可用：技能自身声明与插件屏蔽叠加。 */
export const skillModelAvailable = (skill: SkillCatalogEntry): boolean =>
  skill.valid && skill.blockedModel !== true && skill.modelInvocable

/** 用户端是否可用：技能自身声明与插件屏蔽叠加。 */
export const skillUserAvailable = (skill: SkillCatalogEntry): boolean =>
  skill.valid && skill.blockedUser !== true && skill.userInvocable

/** 两端都被屏蔽才是「已停用」：只关一端时技能仍从另一端可用，不能同时算进「已停用」。 */
export const skillFullyBlocked = (skill: SkillCatalogEntry): boolean =>
  skill.blockedModel === true && skill.blockedUser === true

/** 是否被同名技能遮蔽（同名裁决只保留来源优先级最高的那一个）。 */
export const skillShadowed = (skill: SkillCatalogEntry): boolean => skillEnabled(skill) && skill.winnerId !== undefined

/** 两个开关状态 → 注册层屏蔽范围（两端都开 = 恢复该技能）。 */
export const blockScopeFor = (modelBlocked: boolean, userBlocked: boolean): SkillBlockScope =>
  modelBlocked && userBlocked ? 'all' : modelBlocked ? 'model' : userBlocked ? 'user' : 'none'

/** 两端都不可用（有效技能）：既包含插件两端屏蔽，也包含技能自身声明两端都不可调用。
 *  「已停用」页签按这个口径收技能，保证每个有效技能至少落在一个页签里，而不是只出现在「全部」。
 *  无效技能不在此列——它有自己的原因展示。 */
export const skillUnavailable = (skill: SkillCatalogEntry): boolean =>
  skill.valid && !skillModelAvailable(skill) && !skillUserAvailable(skill)

export function matchesSkillStatus(skill: SkillCatalogEntry, tab: SkillStatusTab): boolean {
  if (tab === 'model') return skillModelAvailable(skill)
  if (tab === 'user') return skillUserAvailable(skill)
  if (tab === 'blocked') return skillUnavailable(skill)
  return true
}

export interface SkillGroup {
  source: SkillSourceKind
  rank: number
  skills: SkillCatalogEntry[]
}

/** 按来源分组，顺序与官方优先级一致（项目 > 引用目录 > 用户 > 内置）；空分组不返回。
 *  分组只回传来源类型，标题文案由界面按 `skills.source.<kind>` 取，避免把中文写进共享常量。 */
export function groupBySource(catalog: readonly SkillCatalogEntry[]): SkillGroup[] {
  const kinds = (Object.keys(SKILL_SOURCES) as SkillSourceKind[])
    .sort((left, right) => SKILL_SOURCES[left].rank - SKILL_SOURCES[right].rank)
  return kinds.flatMap((source) => {
    const skills = catalog
      .filter((skill) => skill.source === source)
      .sort((left, right) => left.name.localeCompare(right.name))
    return skills.length === 0 ? [] : [{ source, rank: SKILL_SOURCES[source].rank, skills }]
  })
}

/** 状态徽章文案：按端如实区分「只关了一端」与「两端都关」。 */
export function skillStatusLabel(skill: SkillCatalogEntry, t: PromptToolTranslate): string {
  if (!skill.valid) return t('skills.status.invalid')
  if (skillFullyBlocked(skill)) return t('skills.status.blocked')
  if (skill.blockedModel === true) return t('skills.status.blockedModel')
  if (skill.blockedUser === true) return t('skills.status.blockedUser')
  if (skillShadowed(skill)) return t('skills.status.shadowed')
  const audiences = [
    skill.modelInvocable ? t('skills.status.audience.model') : '',
    skill.userInvocable ? t('skills.status.audience.user') : '',
  ].filter(Boolean)
  return audiences.length > 0 ? t('skills.status.callable', { audiences: audiences.join('/') }) : t('skills.status.notCallable')
}

/** 徽章色调：非法=红；屏蔽、被同名遮蔽或不可调用=灰；其余=绿。 */
export function skillStatusTone(skill: SkillCatalogEntry): StatusBadgeTone {
  if (!skill.valid) return 'danger'
  if (skill.blocked || skillShadowed(skill) || (!skill.modelInvocable && !skill.userInvocable)) return 'neutral'
  return 'success'
}
