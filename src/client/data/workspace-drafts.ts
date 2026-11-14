/** 工作台实例期的业务草稿。每类数据有明确 owner，切页只卸载视图，不丢原始输入。 */
import { rulesDirty, type RulesDraft } from './rule-drafts.ts'
import { variablesDirty, type VariablesDraft } from './module-variables.ts'

export interface FieldDraft {
  source: string
  text: string
  error: string
}

/** 清掉某个字段前缀下的原始草稿（含嵌套键）。 */
export const cleared = <T,>(fields: Map<string, T>, prefix: string): void => { for (const key of fields.keys()) if (key === prefix || key.startsWith(prefix + ':')) fields.delete(key) }

/** 工具草稿的形状：`tools`／`saved` 的元素与 `ToolsEditorDraft.fields` 的键都按它算。 */
export type ToolDraft = Record<string, unknown>

export interface ToolsEditorDraft {
  refresh?: () => void
  tools: Record<string, unknown>[]
  saved: Record<string, unknown>[]
  expanded: Set<number>
  fields: Map<string, FieldDraft>
  loaded: boolean
  error: string
  saving: boolean
  publicationPending?: boolean
  publicationError?: string
  /** 最新优先序号（见 resource-track.ts）：迟到响应不落地、不清 saving。 */
  latest: number
}

export interface WorkspaceDrafts {
  rules: Map<string, RulesDraft>
  tools: Map<string, ToolsEditorDraft>
  variables: Map<string, VariablesDraft>
  expanded: Map<string, boolean>
  fields: Map<string, FieldDraft>
}

export function createWorkspaceDrafts(): WorkspaceDrafts {
  return { rules: new Map(), tools: new Map(),
    variables: new Map(), fields: new Map(), expanded: new Map() }
}

/**
 * 池自答：指定主语（模块）有没有未保存的输入；不给主语问「任意模块」。
 *
 * 同一条判据服务两处消费——覆盖导入守卫问某个模块、离开前保存问全局——所以只留这一份实现。
 * 无主语（草稿无法归属任何模块）不算脏：它既不阻塞也没可写盘的内容。
 */
export function poolDirty(drafts: WorkspaceDrafts, moduleId?: string): boolean {
  // 无主语：草稿无法归属任何模块，既不阻塞也没有可写盘的内容（调用方无须自己判这一条）。
  if (moduleId === undefined) return false
  const owner = (key: string): boolean => key.startsWith(`${moduleId}:`)
  const rules = drafts.rules.get(moduleId)
  const tools = drafts.tools.get(moduleId)
  return (rules !== undefined && (rules.busy === 'save' || rulesDirty(rules)))
    || (tools !== undefined && (tools.saving || JSON.stringify(tools.tools) !== JSON.stringify(tools.saved)
    || [...tools.fields.values()].some((field) => field.text !== field.source || field.error.length > 0)))
    || [...drafts.variables].some(([key, draft]) => owner(key) && variablesDirty(draft))
    || [...drafts.fields].some(([key, field]) => owner(key) && (field.text !== field.source || field.error.length > 0))
}
