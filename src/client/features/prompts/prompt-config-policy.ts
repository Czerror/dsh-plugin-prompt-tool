import type { EngineMeta, LayerFieldPolicy } from '../../prompt-tool-types.ts'
/** sourceKind / form 是少量固定语义值，用下拉选择；引擎不设枚举，因此额外保留当前值。 */
export const SOURCE_KINDS = ['', 'plugin', 'instruction-hint', 'skill-catalog', 'env-facts'] as const
export const SOURCE_FORMS = ['notice', 'hint', ''] as const

/** audience 的 UI 中文标签：空值=公用（缺省，通用参数默认）；main=仅主会话；subagent=仅子代理。 */
export const AUDIENCE_LABELS: Record<string, string> = { '': '公用（缺省）', main: '仅主会话', subagent: '仅子代理' }

/** 从引擎 /meta 中读取某层的字段能力；未知层回退 pre-step。 */
const EMPTY_POLICY: LayerFieldPolicy = {
  position: false,
  dedupe: false,
  promotion: false,
  audience: false,
  modelScope: false,
  merge: false,
  order: false,
  role: false,
  placeholder: false,
}

export function fieldPolicyFor(meta: EngineMeta, layer: string | undefined): LayerFieldPolicy {
  return meta.layerFieldPolicies[(layer ?? 'pre-step')] ?? EMPTY_POLICY
}
