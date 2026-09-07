import type { EngineMeta, LayerFieldPolicy } from '../../prompt-tool-types.ts'
/** sourceKind / form 是少量固定语义值，用下拉选择；引擎不设枚举，因此额外保留当前值。 */
export const SOURCE_KINDS = ['', 'plugin', 'instruction-hint', 'skill-catalog', 'env-facts'] as const
export const SOURCE_FORMS = ['notice', 'hint', ''] as const

/** audience 的 UI 中文标签：空值=公用（缺省，通用参数默认）；main=仅主会话；subagent=仅子代理。 */
export const AUDIENCE_LABELS: Record<string, string> = { '': '公用（缺省）', main: '仅主会话', subagent: '仅子代理' }
export const LAYER_LABELS: Record<string, string> = {
  'pre-step': '前置步骤',
  'system-section': '系统提示段',
  'runtime-context': '运行上下文',
  'agent-request': '代理请求',
  'llm-stream': '模型流',
  'tool-pipeline': '工具链',
}
export const STRATEGY_LABELS: Record<string, string> = {
  static: '固定文本',
  placeholder: '动态填充',
  'instruction-hint': '指令提示',
  'first-turn-anchor': '首轮锚定',
  'guide-auto': '自动引导',
  'custom-fallback': '自定义回退',
  'world-book': '世界书',
}
export const SLOT_KIND_LABELS: Record<string, string> = { ordered: '顺序配置', anchor: '固定锚点' }
export const ROLE_LABELS: Record<string, string> = { user: '用户', assistant: '助手' }
export const POSITION_LABELS: Record<string, string> = { 'after-user': '用户消息后', 'before-all': '全部消息前', 'after-all': '全部消息后' }
export const MERGE_MODE_LABELS: Record<string, string> = { separate: '分开发送', merged: '合并发送' }
export const DEDUPE_LABELS: Record<string, string> = { none: '不去重', session: '每会话一次', batch: '当前批次' }
export const PROMOTION_LABELS: Record<string, string> = { none: '不晋升', main: '主会话', 'include-subagents': '包含子代理' }
export const MODEL_SCOPE_LABELS: Record<string, string> = { all: '全部模型', pro: '专业模型', flash: '快速模型' }
export const FILL_LABELS: Record<string, string> = { '': '未选择', 'instruction-hint': '指令提示', 'env-facts': '环境信息', 'skill-catalog': '技能目录' }
export const SOURCE_KIND_LABELS: Record<string, string> = { '': '默认', plugin: '插件', 'instruction-hint': '指令提示', 'skill-catalog': '技能目录', 'env-facts': '环境信息' }
export const SOURCE_FORM_LABELS: Record<string, string> = { notice: '通知', hint: '提示', '': '默认' }
export const IDENTITY_FIELD_LABELS: Record<string, string> = { plugin: '按插件', kind: '按注入类型' }
export const EMPTY_BEHAVIOR_LABELS: Record<string, string> = { skip: '跳过', text: '使用提示文本' }

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
