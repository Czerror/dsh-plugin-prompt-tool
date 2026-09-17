export const SKILL_MARKER = 'SKILL.md'

/** 受管技能的稳定身份与磁盘状态；正文只属于实体 SKILL.md。 */
export interface ManagedSkillState {
  /** 相对 skills/.system 的实体目录，允许嵌套。 */
  path: string
  /** skills 根中的单段链接名；与注册名称是不同身份。 */
  link: string
  enabled: boolean
  modelInvocable: boolean
  userInvocable: boolean
  /** 来源类别/原目录仅用于管理展示，不作为写入授权。 */
  source?: string
}

export type SkillStatePatch = Partial<Pick<ManagedSkillState, 'enabled' | 'modelInvocable' | 'userInvocable'>>

export interface SkillCatalogEntry {
  /** 受管项的稳定键；folder 为兼容现有列表保留的同值字段。 */
  id?: string
  folder: string
  name: string
  description: string
  valid: boolean
  dir?: string
  duplicate?: boolean
  issue?: string
  linked?: boolean
  disabled?: boolean
  modelInvocable: boolean
  userInvocable: boolean
  source?: string
  entityPath?: string
  linkPath?: string
  parentId?: string
  managed?: boolean
}
