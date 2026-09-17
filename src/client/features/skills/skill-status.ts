import type { SkillCatalogEntry } from '../../data/prompt-tool-fields.ts'
import { SKILL_SOURCES, scopeOfInvocation, type SkillPolicyScope, type SkillSourceKind } from '../../../shared/skills.ts'
import type { StatusBadgeTone } from '../../ui/StatusBadge.tsx'
import type { PromptToolTranslate } from '../../locales.ts'

export type SkillStatusTab = 'all' | 'model' | 'user' | 'blocked'

/** 实际生效判定：非法技能不注册；调用策略直接来自技能文件的 frontmatter。 */
export const skillEnabled = (skill: SkillCatalogEntry): boolean =>
  skill.valid && (skill.modelInvocable || skill.userInvocable)

/** 模型端是否可用：只看 frontmatter 的 `disable-model-invocation`。 */
export const skillModelAvailable = (skill: SkillCatalogEntry): boolean => skill.valid && skill.modelInvocable

/** 用户端是否可用：只看 frontmatter 的 `user-invocable`。 */
export const skillUserAvailable = (skill: SkillCatalogEntry): boolean => skill.valid && skill.userInvocable

/** 两端都不可用：插件写入的两端停用与技能自身声明都走同一套事实，不再区分来源。 */
export const skillUnavailable = (skill: SkillCatalogEntry): boolean =>
  skill.valid && !skillModelAvailable(skill) && !skillUserAvailable(skill)

/** 是否被同名技能遮蔽（同名裁决只保留来源优先级最高的那一个）。 */
export const skillShadowed = (skill: SkillCatalogEntry): boolean => skillEnabled(skill) && skill.winnerId !== undefined

/** 点击某一端开关后的目标范围：本端取反，另一端保持当前状态。
 *  参数不是「当前是否被屏蔽」，而是各端当前是否可调用——两者只差一次取反，
 *  读错就会误以为两端都停用后开关是死端。 */
export const scopeAfterToggle = (
  skill: Pick<SkillCatalogEntry, 'modelInvocable' | 'userInvocable'>,
  side: 'model' | 'user',
): SkillPolicyScope => scopeOfInvocation(side === 'model'
  ? { modelInvocable: !skill.modelInvocable, userInvocable: skill.userInvocable }
  : { modelInvocable: skill.modelInvocable, userInvocable: !skill.userInvocable })

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

/** 状态徽章文案：按端如实区分「只关了一端」与「两端都关」，措辞说明这是技能文件自己的声明。 */
export function skillStatusLabel(skill: SkillCatalogEntry, t: PromptToolTranslate): string {
  if (!skill.valid) return t('skills.status.invalid')
  if (!skill.modelInvocable && !skill.userInvocable) return t('skills.status.blocked')
  if (!skill.modelInvocable) return t('skills.status.blockedModel')
  if (!skill.userInvocable) return t('skills.status.blockedUser')
  if (skillShadowed(skill)) return t('skills.status.shadowed')
  // 走到这里至少一端可调用：两端都关在上一段已经返回「已停用」，所以不再需要 notCallable 兜底分支
  // （该键仍保留在字典里，供将来出现「有效但两端都不可调用且不是停用」的语义时复用）。
  const audiences = [
    skill.modelInvocable ? t('skills.status.audience.model') : '',
    skill.userInvocable ? t('skills.status.audience.user') : '',
  ].filter(Boolean)
  return t('skills.status.callable', { audiences: audiences.join('/') })
}

/** 徽章色调：非法=红；被同名遮蔽或两端都不可用=灰；其余=绿。
 *  「两端都不可用」与页签用同一个谓词，插件写入与技能自身声明不再各算一套。 */
export function skillStatusTone(skill: SkillCatalogEntry): StatusBadgeTone {
  if (!skill.valid) return 'danger'
  if (skillShadowed(skill) || skillUnavailable(skill)) return 'neutral'
  return 'success'
}
