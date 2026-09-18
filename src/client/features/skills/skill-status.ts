import type { SkillCatalogEntry } from '../../data/prompt-tool-fields.ts'
import { SKILL_SOURCES, type SkillPolicyChange, type SkillSourceKind } from '../../../shared/skills.ts'
import type { StatusBadgeTone } from '../../ui/StatusBadge.tsx'
import type { PromptToolTranslate } from '../../locales.ts'

export type SkillStatusTab = 'all' | 'model' | 'user' | 'blocked'

/** 会话可用必须同时满足官方注册结果与文件调用策略。 */
export const skillEnabled = (skill: SkillCatalogEntry): boolean =>
  skill.valid && skill.availability === 'active' && (skill.modelInvocable || skill.userInvocable)

/** 模型端可用：会话已注册且文件允许模型调用。 */
export const skillModelAvailable = (skill: SkillCatalogEntry): boolean => skillEnabled(skill) && skill.modelInvocable

/** 用户端可用：会话已注册且文件允许用户调用。 */
export const skillUserAvailable = (skill: SkillCatalogEntry): boolean => skillEnabled(skill) && skill.userInvocable

/** 两端都不可用：插件写入的两端停用与技能自身声明都走同一套事实，不再区分来源。 */
export const skillUnavailable = (skill: SkillCatalogEntry): boolean =>
  skill.valid && !skill.modelInvocable && !skill.userInvocable

/** 遮蔽来自当前会话注册表，客户端不重新裁决优先级。 */
export const skillShadowed = (skill: SkillCatalogEntry): boolean => skill.valid && skill.availability === 'shadowed'

/** 只提交用户点击的端，不把另一端的陈旧快照带回服务端。 */
export const policyAfterToggle = (
  skill: Pick<SkillCatalogEntry, 'modelInvocable' | 'userInvocable'>,
  side: 'model' | 'user',
): Extract<SkillPolicyChange, { side: string }> => ({ side, enabled: !(side === 'model' ? skill.modelInvocable : skill.userInvocable) })

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

/** 先说明会话注册状态，已注册条目再显示调用策略。 */
export function skillStatusLabel(skill: SkillCatalogEntry, t: PromptToolTranslate): string {
  if (!skill.valid) return t('skills.status.invalid')
  if (skillShadowed(skill)) return t('skills.status.shadowed')
  if (skill.availability === 'unregistered') return t('skills.status.unregistered')
  if (skill.availability !== 'active') return t('skills.status.unknown')
  if (!skill.modelInvocable && !skill.userInvocable) return t('skills.status.blocked')
  if (!skill.modelInvocable) return t('skills.status.blockedModel')
  if (!skill.userInvocable) return t('skills.status.blockedUser')
  const audiences = [
    skill.modelInvocable ? t('skills.status.audience.model') : '',
    skill.userInvocable ? t('skills.status.audience.user') : '',
  ].filter(Boolean)
  return t('skills.status.callable', { audiences: audiences.join('/') })
}

/** 只有已确认的会话可用状态显示绿色。 */
export function skillStatusTone(skill: SkillCatalogEntry): StatusBadgeTone {
  if (!skill.valid) return 'danger'
  return skillEnabled(skill) ? 'success' : 'neutral'
}
