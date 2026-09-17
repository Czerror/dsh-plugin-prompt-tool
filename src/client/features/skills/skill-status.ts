import type { SkillCatalogEntry } from '../../data/prompt-tool-fields.ts'
import type { StatusBadgeTone } from '../../ui/StatusBadge.tsx'
import type { PromptToolTranslate } from '../../locales.ts'

export type SkillStatusTab = 'all' | 'model' | 'user' | 'disabled'

/** 稳定身份：受管技能用服务端 id，旧快照回退 folder（两者在新模型下同值）。 */
export const skillIdOf = (skill: SkillCatalogEntry): string => skill.id ?? skill.folder

export function matchesSkillStatus(skill: SkillCatalogEntry, enabled: boolean, tab: SkillStatusTab): boolean {
  if (tab === 'model') return skill.valid && enabled && skill.modelInvocable
  if (tab === 'user') return skill.valid && enabled && skill.userInvocable
  if (tab === 'disabled') return skill.valid && !enabled
  return true
}

/** 最近存在的技能祖先：优先服务端 parentId，缺失时按路径前缀回退。
 *  父技能不存在（例如中间目录没有 SKILL.md）时返回 undefined —— 该行作为根行展示，不能丢。 */
export function skillParentOf(skill: SkillCatalogEntry, ids: ReadonlySet<string>): string | undefined {
  const id = skillIdOf(skill)
  if (skill.parentId !== undefined && skill.parentId !== id && ids.has(skill.parentId)) return skill.parentId
  const parts = id.split('/')
  while (parts.length > 1) {
    parts.pop()
    const candidate = parts.join('/')
    if (ids.has(candidate)) return candidate
  }
  return undefined
}

export interface SkillTreeRow {
  skill: SkillCatalogEntry
  depth: number
}

export interface SkillTree {
  /** 展开顺序：父行在前，其后紧跟其子树的全部子孙。 */
  rows: SkillTreeRow[]
  /** 根行（无技能祖先）；拖拽与排序只作用于它们。 */
  primary: SkillCatalogEntry[]
  childrenOf: Map<string, SkillCatalogEntry[]>
}

/** 按稳定身份建树：子项挂到最近存在的技能祖先，无祖先则成为根行。 */
export function buildSkillTree(catalog: SkillCatalogEntry[]): SkillTree {
  const ids = new Set(catalog.map(skillIdOf))
  const childrenOf = new Map<string, SkillCatalogEntry[]>()
  const primary: SkillCatalogEntry[] = []
  for (const skill of catalog) {
    const parent = skillParentOf(skill, ids)
    if (parent === undefined) { primary.push(skill); continue }
    const list = childrenOf.get(parent) ?? []
    list.push(skill)
    childrenOf.set(parent, list)
  }
  for (const list of childrenOf.values()) list.sort((a, b) => skillIdOf(a).localeCompare(skillIdOf(b)))
  const rows: SkillTreeRow[] = []
  const visited = new Set<string>()
  const visit = (skill: SkillCatalogEntry, depth: number): void => {
    const id = skillIdOf(skill)
    if (visited.has(id)) return
    visited.add(id)
    rows.push({ skill, depth })
    for (const child of childrenOf.get(id) ?? []) visit(child, depth + 1)
  }
  for (const root of primary) visit(root, 0)
  return { rows, primary, childrenOf }
}

/**
 * 按筛选条件保留技能行：命中项之外，保留其全部技能祖先作为树容器。
 * 只保留命中项会让子技能单独命中时从顶层展开逻辑里消失（父节点不在可见集合）。
 */
export function filterSkillCatalog(
  catalog: SkillCatalogEntry[],
  match: (skill: SkillCatalogEntry) => boolean,
): SkillCatalogEntry[] {
  const ids = new Set(catalog.map(skillIdOf))
  const byId = new Map(catalog.map((skill) => [skillIdOf(skill), skill]))
  const keep = new Set<string>()
  for (const skill of catalog) {
    if (!match(skill)) continue
    keep.add(skillIdOf(skill))
    let parent = skillParentOf(skill, ids)
    while (parent !== undefined && !keep.has(parent)) {
      keep.add(parent)
      const entry = byId.get(parent)
      parent = entry === undefined ? undefined : skillParentOf(entry, ids)
    }
  }
  return catalog.filter((skill) => keep.has(skillIdOf(skill)))
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
