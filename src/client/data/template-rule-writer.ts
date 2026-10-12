import type { RuleDefinition, RulesSnapshot } from '../../shared/rules.ts'
import type { ModuleSummary } from '../../shared/bridge-contract.ts'
import { bridgeCall, type BridgeResult } from './bridge-client.ts'
import { createRuleEditor, getRulesDraft } from './rule-drafts.ts'
import { isWritableTarget } from './module-subject.ts'
import type { WorkspaceDrafts } from './workspace-drafts.ts'
import type { ModuleActions } from './module-actions.ts'

export type TemplateWriteResult = BridgeResult<RulesSnapshot> & { moduleEnabled?: boolean; moduleEnableError?: string; refreshError?: string; localConflict?: boolean }

/** 操作完成后先接纳共享事实；视图只拥有选择意图、提示与展开。 */
export function createTemplateRuleWriter(deps: {
  drafts: WorkspaceDrafts
  modules: () => readonly ModuleSummary[] | undefined
  changed: () => void
  markDeclared: (moduleId: string, section: string) => void
  enqueue: <T>(task: () => Promise<T>) => Promise<T>
  actions: Pick<ModuleActions, 'enable'>
}) {
  return async (moduleId: string, rule: RuleDefinition, newlyCreated = false): Promise<TemplateWriteResult> => {
    if (!newlyCreated && !isWritableTarget(deps.modules(), moduleId)) return { ok: false, code: 'module-readonly', message: '目标模块不可写' }
    const draft = getRulesDraft(deps.drafts, moduleId)
    const module = deps.modules()?.find(candidate => candidate.id === moduleId)
    const declared = newlyCreated ? false : module?.declares?.includes('rules')
    const editor = createRuleEditor(moduleId, draft, {
      request: body => bridgeCall('rules', body, moduleId), enqueue: (_id, task) => deps.enqueue(task),
      isCurrent: () => true, changed: deps.changed,
    })
    const result = await editor.create(rule, declared)
    if (!result.ok) return result
    deps.markDeclared(moduleId, 'rules')
    const committed = { ...result, localConflict: draft.remote !== undefined }
    if (!newlyCreated) return committed
    const enabled = await deps.actions.enable(moduleId, true)
    if (!enabled.ok) return { ...committed, moduleEnableError: enabled.message ?? enabled.code ?? 'module-enable-failed' }
    return { ...committed, moduleEnabled: true, ...(enabled.refreshError === undefined ? {} : { refreshError: enabled.refreshError }) }
  }
}
