import type { SkillCatalogEntry } from '../../data/prompt-tool-fields.ts'
import type { StatusBadgeTone } from '../../ui/StatusBadge.tsx'

export type SkillStatusTab = 'all' | 'model' | 'user' | 'disabled'

export function matchesSkillStatus(skill: SkillCatalogEntry, enabled: boolean, tab: SkillStatusTab): boolean {
  if (tab === 'model') return skill.valid && enabled && skill.modelInvocable
  if (tab === 'user') return skill.valid && enabled && skill.userInvocable
  if (tab === 'disabled') return skill.valid && !enabled
  return true
}

export function skillStatusLabel(skill: SkillCatalogEntry, enabled: boolean): string {
  if (!skill.valid) return '未注册'
  if (!enabled) return '已禁用'
  const audiences = [
    skill.modelInvocable ? '模型' : '',
    skill.userInvocable ? '用户' : '',
  ].filter(Boolean)
  return audiences.length > 0 ? `可调用:${audiences.join('/')}` : '不可调用'
}

/** 状态徽章色调：未注册=红 / 关闭或不可调用=灰 / 可调用=绿（与工具卡「模型可见」同款）。 */
export function skillStatusTone(skill: SkillCatalogEntry, enabled: boolean): StatusBadgeTone {
  if (!skill.valid) return 'danger'
  if (!enabled || (!skill.modelInvocable && !skill.userInvocable)) return 'neutral'
  return 'success'
}
