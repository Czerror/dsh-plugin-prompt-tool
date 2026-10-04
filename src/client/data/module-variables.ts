import type { BridgeRequestMap, BridgeValueMap } from '../../shared/bridge-contract.ts'
import type { RuleRevisions } from '../../shared/rules.ts'
import type { BridgeResult } from './bridge-client.ts'
import { deepEqual } from './dirty-state.ts'

export interface VariablesBaseline {
  variables: Record<string, string>
  enabled: boolean
  revisions: RuleRevisions
  publicationPending?: boolean
  publicationError?: string
}

/** 只刷新已提交定义，既不重放变量写入，也不确认调用方尚未保存的新草稿。 */
export async function retryModuleVariablesPublication(moduleId: string, baseline: VariablesBaseline,
  request: (body: BridgeRequestMap['moduleVariables']) => Promise<BridgeResult<BridgeValueMap['moduleVariables']>>,
): Promise<{ baseline: VariablesBaseline; publicationError?: string }> {
  const result = await request({ expectedModuleId: moduleId, refreshOnly: true })
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
  const enabledChanged = enabled !== baseline.enabled
  if (!valuesChanged && !enabledChanged) return baseline.publicationPending ? retryModuleVariablesPublication(moduleId, baseline, request) : { baseline }
  const result = await request({
    expectedModuleId: moduleId,
    expectedRevisions: { ...(valuesChanged ? { variables: baseline.revisions.variables } : {}), ...(enabledChanged ? { settings: baseline.revisions.settings } : {}) },
    ...(valuesChanged ? { variables } : {}), ...(enabledChanged ? { enabled } : {}),
  })
  if (!result.ok) throw new Error(result.message ?? result.code ?? '模板变量保存失败')
  return { baseline: {
    variables: valuesChanged ? variables : baseline.variables,
    enabled: enabledChanged ? enabled : baseline.enabled,
    revisions: { ...baseline.revisions,
      ...(valuesChanged ? { variables: result.value.revisions.variables } : {}),
      ...(enabledChanged ? { settings: result.value.revisions.settings } : {}) },
    ...(result.value.publicationError ? { publicationPending: true, publicationError: result.value.publicationError } : {}),
  }, ...(result.value.publicationError ? { publicationError: result.value.publicationError } : {}) }
}
