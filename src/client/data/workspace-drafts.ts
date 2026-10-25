/** 工作台实例期的业务草稿。每类数据有明确 owner，切页只卸载视图，不丢原始输入。 */
import { rulesDirty, type RulesDraft } from './rule-drafts.ts'
import type { SkillContentSnapshot } from '../../shared/skills.ts'
import type { PersonaSources, PersonaSourcesSnapshot, PersonaSpec } from '../../shared/persona-section.ts'
import { variablesDirty, type VariablesDraft } from './module-variables.ts'

export interface SkillEditorDraft {
  saved?: SkillContentSnapshot
  text: string
  description: string
  error: string
  loading: boolean
  saving: boolean
  refresh?: () => void
}
export interface FieldDraft {
  source: string
  text: string
  error: string
}

export type PersonaDraft = PersonaSpec

export interface PersonaEditorDraft {
  listeners?: Set<() => void>
  loading?: boolean
  /** 最新优先序号（见 resource-track.ts）：迟到响应不落地、不清 loading。 */
  latest: number
  value: PersonaDraft
  saved: PersonaDraft
  revision: string
  declared: boolean
  loaded: boolean
  error: string
  saving: boolean
  publicationPending?: boolean
  publicationError?: string
}

export interface PersonaSourcesEditorDraft {
  listeners?: Set<() => void>
  value: PersonaSources
  saved: PersonaSources
  revision: string | null
  candidates: PersonaSourcesSnapshot['candidates']
  loaded: boolean
  loading: boolean
  saving: boolean
  error: string
  /** 最新优先序号（见 resource-track.ts）。 */
  latest: number
  publicationPending?: boolean
  publicationError?: string
}

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
  skills: Map<string, SkillEditorDraft>
  tools: Map<string, ToolsEditorDraft>
  persona: Map<string, PersonaEditorDraft>
  personaSources: PersonaSourcesEditorDraft
  variables: Map<string, VariablesDraft>
  expanded: Map<string, boolean>
  fields: Map<string, FieldDraft>
}

export function createWorkspaceDrafts(): WorkspaceDrafts {
  return { rules: new Map(), skills: new Map(), tools: new Map(), persona: new Map(),
    personaSources: { value: { main: null, subagent: null }, saved: { main: null, subagent: null }, revision: null, candidates: [], loaded: false, loading: false, saving: false, error: '', latest: 0 },
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
  const persona = drafts.persona.get(moduleId)
  return (rules !== undefined && (rules.busy === 'save' || rulesDirty(rules)))
    || (tools !== undefined && (tools.saving || JSON.stringify(tools.tools) !== JSON.stringify(tools.saved)
    || [...tools.fields.values()].some((field) => field.text !== field.source || field.error.length > 0)))
    || (persona !== undefined && (persona.saving || JSON.stringify(persona.value) !== JSON.stringify(persona.saved)))
    || [...drafts.variables].some(([key, draft]) => owner(key) && variablesDirty(draft))
    || [...drafts.fields].some(([key, field]) => owner(key) && (field.text !== field.source || field.error.length > 0))
}
