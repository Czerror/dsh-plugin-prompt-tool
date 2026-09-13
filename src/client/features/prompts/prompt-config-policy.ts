import type { PromptToolLocaleKey, PromptToolTranslate } from '../../locales.ts'
import type { EngineMeta, LayerFieldPolicy } from '../../prompt-tool-types.ts'
/** sourceKind / form 是少量固定语义值，用下拉选择；引擎不设枚举，因此额外保留当前值。 */
export const SOURCE_KINDS = ['', 'plugin', 'instruction-hint', 'skill-catalog', 'env-facts'] as const
export const SOURCE_FORMS = ['notice', 'hint', ''] as const

/** UI 始终提供六个官方插入点；meta 额外返回的层仍保留在末尾，避免丢失未知配置。 */
export const INSERTION_LAYERS = [
  'pre-step',
  'system-section',
  'runtime-context',
  'agent-request',
  'llm-stream',
  'tool-pipeline',
] as const

export function displayLayers(layers: readonly string[]): string[] {
  return [...INSERTION_LAYERS, ...layers.filter((layer) => !(INSERTION_LAYERS as readonly string[]).includes(layer))]
}

/**
 * 枚举显示标签只存字典键（文案归 `prompt-tool` 字典）：
 * 值 → 键映射 + {@link translateLabel} 求值，未知值回退原始值（旧配置仍可读）。
 */
export function translateLabel(
  t: PromptToolTranslate,
  keys: Record<string, PromptToolLocaleKey>,
  value: string,
): string {
  const key = keys[value]
  return key === undefined ? value : t(key)
}

/** audience：空值=公用（缺省，通用参数默认）；main=仅主会话；subagent=仅子代理。 */
export const AUDIENCE_LABEL_KEYS: Record<string, PromptToolLocaleKey> = { '': 'audience.none', main: 'audience.main', subagent: 'audience.subagent' }
export const LAYER_LABEL_KEYS: Record<string, PromptToolLocaleKey> = {
  'pre-step': 'layer.pre-step',
  'system-section': 'layer.system-section',
  'runtime-context': 'layer.runtime-context',
  'agent-request': 'layer.agent-request',
  'llm-stream': 'layer.llm-stream',
  'tool-pipeline': 'layer.tool-pipeline',
}
export const STRATEGY_LABEL_KEYS: Record<string, PromptToolLocaleKey> = {
  static: 'strategy.static',
  placeholder: 'strategy.placeholder',
  'instruction-hint': 'strategy.instructionHint',
  'first-turn-anchor': 'strategy.firstTurnAnchor',
  'guide-auto': 'strategy.guideAuto',
  'custom-fallback': 'strategy.customFallback',
  'world-book': 'strategy.worldBook',
}
export const SLOT_KIND_LABEL_KEYS: Record<string, PromptToolLocaleKey> = { ordered: 'slotKind.ordered', anchor: 'slotKind.anchor' }
export const ROLE_LABEL_KEYS: Record<string, PromptToolLocaleKey> = { user: 'role.user', assistant: 'role.assistant' }
export const POSITION_LABEL_KEYS: Record<string, PromptToolLocaleKey> = { 'after-user': 'position.afterUser', 'before-all': 'position.beforeAll', 'after-all': 'position.afterAll' }
export const MERGE_MODE_LABEL_KEYS: Record<string, PromptToolLocaleKey> = { separate: 'merge.separate', merged: 'merge.merged' }
export const DEDUPE_LABEL_KEYS: Record<string, PromptToolLocaleKey> = { none: 'dedupe.none', session: 'dedupe.session', batch: 'dedupe.batch' }
export const PROMOTION_LABEL_KEYS: Record<string, PromptToolLocaleKey> = { none: 'promotion.none', main: 'promotion.main', 'include-subagents': 'promotion.subagents' }
export const MODEL_SCOPE_LABEL_KEYS: Record<string, PromptToolLocaleKey> = { all: 'modelScope.all', pro: 'modelScope.pro', flash: 'modelScope.flash' }
export const FILL_LABEL_KEYS: Record<string, PromptToolLocaleKey> = { '': 'fill.none', 'instruction-hint': 'fill.instructionHint', 'env-facts': 'fill.envFacts', 'skill-catalog': 'fill.skillCatalog' }
export const SOURCE_KIND_LABEL_KEYS: Record<string, PromptToolLocaleKey> = { '': 'sourceKind.default', plugin: 'sourceKind.plugin', 'instruction-hint': 'sourceKind.instructionHint', 'skill-catalog': 'sourceKind.skillCatalog', 'env-facts': 'sourceKind.envFacts' }
export const SOURCE_FORM_LABEL_KEYS: Record<string, PromptToolLocaleKey> = { notice: 'sourceForm.notice', hint: 'sourceForm.hint', '': 'sourceForm.default' }
export const IDENTITY_FIELD_LABEL_KEYS: Record<string, PromptToolLocaleKey> = { plugin: 'identity.plugin', kind: 'identity.kind' }
export const EMPTY_BEHAVIOR_LABEL_KEYS: Record<string, PromptToolLocaleKey> = { skip: 'emptyBehavior.skip', text: 'emptyBehavior.text' }

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
