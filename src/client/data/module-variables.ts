import type { BridgeRequestMap, BridgeValueMap } from '../../shared/bridge-contract.ts'
import type { ModuleVariableRevisions, ModuleVariableScope, ModuleVariablesSnapshot } from '../../shared/module-variables.ts'
import type { BridgeResult } from './bridge-client.ts'
import { deepEqual } from './dirty-state.ts'

export interface VariablesBaseline {
  scope: ModuleVariableScope
  variables: Record<string, string>
  enabled: boolean
  revisions: ModuleVariableRevisions
  publicationPending?: boolean
  publicationError?: string
}

export interface VariablesDraft {
  scope: ModuleVariableScope
  variables: Record<string, string>
  enabled: boolean
  baseline?: VariablesBaseline
  snapshot?: ModuleVariablesSnapshot
  loading: boolean
  saving: boolean
  error: string
  readSequence: number
}

/** 变量草稿的唯一构造点：草稿表按主语键（`${moduleId}:${scope}`）索引，无主语不建键。 */
export function createVariablesDraft(scope: ModuleVariableScope): VariablesDraft {
  return { scope, variables: {}, enabled: true, loading: false, saving: false, error: '', readSequence: 0 }
}

export function getVariablesDraft(drafts: Map<string, VariablesDraft>, moduleId: string, scope: ModuleVariableScope): VariablesDraft {
  const key = `${moduleId}:${scope}`
  let draft = drafts.get(key)
  if (!draft) {
    draft = createVariablesDraft(scope)
    drafts.set(key, draft)
  }
  return draft
}

export const variablesDirty = (draft: VariablesDraft): boolean => draft.saving
  || draft.baseline !== undefined && (!deepEqual(draft.variables, draft.baseline.variables)
    || draft.scope === 'module' && draft.enabled !== draft.baseline.enabled)

type Request = (body: BridgeRequestMap['moduleVariables']) => Promise<BridgeResult<BridgeValueMap['moduleVariables']>>

/** 响应只进入发起请求的草稿；新请求和已有编辑分别保留自己的版本。 */
export async function readVariablesDraft(moduleId: string, draft: VariablesDraft, request: Request): Promise<void> {
  const sequence = ++draft.readSequence
  draft.loading = true
  try {
    const result = await request({ scope: draft.scope, expectedModuleId: moduleId })
    if (sequence !== draft.readSequence) return
    if (!result.ok) throw new Error(result.message ?? result.code ?? '变量读取失败')
    const previous = draft.baseline, next = result.value
    const retainValues = previous !== undefined && !deepEqual(draft.variables, previous.variables)
    const retainEnabled = previous !== undefined && draft.enabled !== previous.enabled
    if (!retainValues) draft.variables = { ...next[draft.scope] }
    if (!retainEnabled) draft.enabled = next.enabled
    draft.baseline = {
      scope: draft.scope, variables: retainValues ? previous.variables : { ...next[draft.scope] },
      enabled: retainEnabled ? previous.enabled : next.enabled,
      revisions: { ...next.revisions,
        [draft.scope]: retainValues ? previous.revisions[draft.scope] : next.revisions[draft.scope],
        settings: retainEnabled ? previous.revisions.settings : next.revisions.settings },
      ...(previous?.publicationPending ? { publicationPending: true, publicationError: previous.publicationError } : {}),
    }
    draft.snapshot = next
    draft.error = ''
  } catch (error) {
    if (sequence === draft.readSequence) draft.error = error instanceof Error ? error.message : String(error)
  } finally { if (sequence === draft.readSequence) draft.loading = false }
}

/** 只刷新已提交定义，既不重放变量写入，也不确认调用方尚未保存的新草稿。 */
export async function retryModuleVariablesPublication(moduleId: string, baseline: VariablesBaseline,
  request: (body: BridgeRequestMap['moduleVariables']) => Promise<BridgeResult<BridgeValueMap['moduleVariables']>>,
): Promise<{ baseline: VariablesBaseline; publicationError?: string }> {
  const result = await request({ scope: baseline.scope, expectedModuleId: moduleId, refreshOnly: true })
  if (!result.ok) throw new Error(result.message ?? result.code ?? '模板变量刷新失败')
  const { publicationPending: _pending, publicationError: _error, ...saved } = baseline
  return result.value.publicationError
    ? { baseline: { ...saved, publicationPending: true, publicationError: result.value.publicationError }, publicationError: result.value.publicationError }
    : { baseline: saved }
}

/** 变量值与开关各自提交版本；成功只确认请求快照，不接管调用方的新草稿。 */
export async function saveModuleVariables(moduleId: string, baseline: VariablesBaseline,
  desired: Pick<VariablesBaseline, 'variables' | 'enabled'>,
  request: (body: BridgeRequestMap['moduleVariables']) => Promise<BridgeResult<BridgeValueMap['moduleVariables']>>,
): Promise<{ baseline: VariablesBaseline; publicationError?: string }> {
  const variables = Object.fromEntries(Object.entries(desired.variables).filter(([key]) => key.trim().length > 0))
  const enabled = desired.enabled
  const valuesChanged = !deepEqual(variables, baseline.variables)
  const enabledChanged = baseline.scope === 'module' && enabled !== baseline.enabled
  if (!valuesChanged && !enabledChanged) return baseline.publicationPending ? retryModuleVariablesPublication(moduleId, baseline, request) : { baseline }
  // 有前状态才带版本期望；没有前状态（合成基线只用于未声明节的首次创建）就**整键缺席**——
  // 只留键而值是 undefined 经 JSON 会变成 `{}`，服务端读不到期望版本反而拒绝，所以连键一起省。
  const expectedRevisions = {
    ...(valuesChanged && Object.hasOwn(baseline.revisions, baseline.scope) ? { [baseline.scope]: baseline.revisions[baseline.scope] } : {}),
    ...(enabledChanged && Object.hasOwn(baseline.revisions, 'settings') ? { settings: baseline.revisions.settings } : {}),
  }
  const result = await request({
    scope: baseline.scope,
    expectedModuleId: moduleId,
    ...(Object.keys(expectedRevisions).length === 0 ? {} : { expectedRevisions }),
    ...(valuesChanged ? { variables } : {}), ...(enabledChanged ? { enabled } : {}),
  })
  if (!result.ok) throw new Error(result.message ?? result.code ?? '模板变量保存失败')
  return { baseline: {
    scope: baseline.scope,
    variables: valuesChanged ? variables : baseline.variables,
    enabled: enabledChanged ? enabled : baseline.enabled,
    revisions: { ...baseline.revisions,
      ...(valuesChanged ? { [baseline.scope]: result.value.revisions[baseline.scope] } : {}),
      ...(enabledChanged ? { settings: result.value.revisions.settings } : {}) },
    ...(result.value.publicationError ? { publicationPending: true, publicationError: result.value.publicationError } : {}),
  }, ...(result.value.publicationError ? { publicationError: result.value.publicationError } : {}) }
}
