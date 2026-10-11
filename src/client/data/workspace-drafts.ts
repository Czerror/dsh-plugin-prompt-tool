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
  readSequence?: number
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
  readSequence: number
  publicationPending?: boolean
  publicationError?: string
}

export interface ToolsEditorDraft {
  refresh?: () => void
  tools: Record<string, unknown>[]
  saved: Record<string, unknown>[]
  expanded: Set<number>
  fields: Map<string, FieldDraft>
  loaded: boolean
  error: string
  saving: boolean
}

export interface PolicyDraft {
  defaultProfile?: string
  ceiling?: { allow?: string[]; deny?: string[] }
  profiles?: Array<{ id: string; name?: string; allow?: string[]; deny?: string[]; modelSelectable?: boolean }>
  characterBindings?: Array<{ characterId: string; profile: string; modelSelectable?: boolean }>
  taskRules?: Array<{ id: string; name?: string; pattern: string; profile: string; order?: number; modelSelectable?: boolean }>
  modelExpansion?: { enabled?: boolean; allow?: string[]; maxAdditionalTools?: number; requireApproval?: boolean }
}

export interface PolicyEditorDraft {
  draft: PolicyDraft | null
  saved: PolicyDraft | null
  pending?: PolicyDraft | null
  saving: boolean
  loaded: boolean
  refresh?: () => void
  report?: (kind: 'ok' | 'error', message: string) => void
}

export interface WorkspaceDrafts {
  rules: Map<string, RulesDraft>
  skills: Map<string, SkillEditorDraft>
  tools: Map<string, ToolsEditorDraft>
  persona: Map<string, PersonaEditorDraft>
  personaSources: PersonaSourcesEditorDraft
  variables: Map<string, VariablesDraft>
  policies: Map<string, PolicyEditorDraft>
  expanded: Map<string, boolean>
  fields: Map<string, FieldDraft>
}

export function createWorkspaceDrafts(): WorkspaceDrafts {
  return { rules: new Map(), skills: new Map(), tools: new Map(), persona: new Map(),
    personaSources: { value: { main: null, subagent: null }, saved: { main: null, subagent: null }, revision: null, candidates: [], loaded: false, loading: false, saving: false, error: '', readSequence: 0 },
    variables: new Map(), policies: new Map(), fields: new Map(), expanded: new Map() }
}

/** 切换模块前阻止无声丢弃局部草稿；用户回对应页面处理，不替其隐式落盘。 */
export function hasWorkspaceDrafts(drafts: WorkspaceDrafts, moduleId: string | undefined): boolean {
  // 无主语：草稿无法归属任何模块，既不阻塞切换也没有可写盘的内容。
  if (moduleId === undefined) return false
  const rules = drafts.rules.get(moduleId)
  const tools = drafts.tools.get(moduleId)
  const persona = drafts.persona.get(moduleId)
  const policy = drafts.policies.get(moduleId)
  return (rules !== undefined && (rules.busy === 'save' || rulesDirty(rules)))
    || (tools !== undefined && (tools.saving || JSON.stringify(tools.tools) !== JSON.stringify(tools.saved)
    || [...tools.fields.values()].some((field) => field.text !== field.source || field.error.length > 0)))
    || (persona !== undefined && (persona.saving || JSON.stringify(persona.value) !== JSON.stringify(persona.saved)))
    || [...drafts.variables].some(([key, draft]) => key.startsWith(`${moduleId}:`) && variablesDirty(draft))
    || (policy !== undefined && (policy.saving || JSON.stringify(policy.draft) !== JSON.stringify(policy.saved)))
    || [...drafts.fields].some(([key, field]) => key.startsWith(`${moduleId}:`) && (field.text !== field.source || field.error.length > 0))
}
