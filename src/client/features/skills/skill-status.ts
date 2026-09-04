import type { SkillCatalogEntry } from '../../data/prompt-tool-fields.ts'

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
