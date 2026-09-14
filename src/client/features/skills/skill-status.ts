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

/**
 * 按筛选条件保留技能行：命中项之外，保留“存在命中后代”的父节点作为树容器。
 * 只保留命中项会让子技能单独命中时从顶层展开逻辑里消失（父节点不在可见集合）。
 */
export function filterSkillCatalog(
  catalog: SkillCatalogEntry[],
  match: (skill: SkillCatalogEntry) => boolean,
): SkillCatalogEntry[] {
  const matchedFolders = catalog.filter(match).map((skill) => skill.folder)
  if (matchedFolders.length === 0) return []
  // ponytail: O(n²) 前缀扫描；技能目录量级下无需索引，规模上来再换字典。
  return catalog.filter((skill) => matchedFolders.includes(skill.folder)
    || matchedFolders.some((folder) => folder.startsWith(`${skill.folder}/`)))
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
