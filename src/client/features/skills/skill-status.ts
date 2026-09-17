import type { SkillCatalogEntry } from '../../data/prompt-tool-fields.ts'
import { SKILL_SOURCES, type SkillSourceKind } from '../../../shared/skills.ts'
import type { StatusBadgeTone } from '../../ui/StatusBadge.tsx'
import type { PromptToolTranslate } from '../../locales.ts'

export type SkillStatusTab = 'all' | 'model' | 'user' | 'blocked'

/** 实际生效判定：非法技能不注册；被屏蔽的技能在注册层被影子候选压掉。 */
export const skillEnabled = (skill: SkillCatalogEntry): boolean => skill.valid && skill.blocked !== true

/** 是否被同名技能遮蔽（同名裁决只保留来源优先级最高的那一个）。 */
export const skillShadowed = (skill: SkillCatalogEntry): boolean => skillEnabled(skill) && skill.winnerId !== undefined

export function matchesSkillStatus(skill: SkillCatalogEntry, tab: SkillStatusTab): boolean {
  if (tab === 'model') return skillEnabled(skill) && skill.modelInvocable
  if (tab === 'user') return skillEnabled(skill) && skill.userInvocable
  if (tab === 'blocked') return skill.blocked
  return true
}

export interface SkillGroup {
  source: SkillSourceKind
  label: string
  rank: number
  skills: SkillCatalogEntry[]
}

/** 按来源分组，顺序与官方优先级一致（项目 > 引用目录 > 用户 > 内置）；空分组不返回。 */
export function groupBySource(catalog: readonly SkillCatalogEntry[]): SkillGroup[] {
  const kinds = (Object.keys(SKILL_SOURCES) as SkillSourceKind[])
    .sort((left, right) => SKILL_SOURCES[left].rank - SKILL_SOURCES[right].rank)
  return kinds.flatMap((source) => {
    const skills = catalog
      .filter((skill) => skill.source === source)
      .sort((left, right) => left.name.localeCompare(right.name))
    return skills.length === 0 ? [] : [{ source, label: SKILL_SOURCES[source].label, rank: SKILL_SOURCES[source].rank, skills }]
  })
}

export function skillStatusLabel(skill: SkillCatalogEntry, t: PromptToolTranslate): string {
  if (!skill.valid) return t('skills.status.invalid')
  if (skill.blocked) return t('skills.status.blocked')
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
