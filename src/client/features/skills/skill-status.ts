import type { SkillCatalogEntry } from '../../data/prompt-tool-fields.ts'
import type { StatusBadgeTone } from '../../ui/StatusBadge.tsx'
import type { PromptToolTranslate } from '../../locales.ts'

export type SkillStatusTab = 'all' | 'model' | 'user' | 'disabled'

export function matchesSkillStatus(skill: SkillCatalogEntry, enabled: boolean, tab: SkillStatusTab): boolean {
  if (tab === 'model') return skill.valid && enabled && skill.modelInvocable
  if (tab === 'user') return skill.valid && enabled && skill.userInvocable
  if (tab === 'disabled') return skill.valid && !enabled
  return true
}

export function skillStatusLabel(skill: SkillCatalogEntry, enabled: boolean, t: PromptToolTranslate): string {
  if (!skill.valid) return t('skills.status.unregistered')
  if (!enabled) return t('skills.status.disabled')
  const audiences = [
    skill.modelInvocable ? t('skills.status.audience.model') : '',
    skill.userInvocable ? t('skills.status.audience.user') : '',
  ].filter(Boolean)
  return audiences.length > 0 ? t('skills.status.callable', { audiences: audiences.join('/') }) : t('skills.status.notCallable')
}

/** 状态徽章色调：未注册=红 / 关闭或不可调用=灰 / 可调用=绿（与工具卡「模型可见」同款）。 */
export function skillStatusTone(skill: SkillCatalogEntry, enabled: boolean): StatusBadgeTone {
  if (!skill.valid) return 'danger'
  if (!enabled || (!skill.modelInvocable && !skill.userInvocable)) return 'neutral'
  return 'success'
}
