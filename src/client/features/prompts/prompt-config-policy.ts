import type { PromptToolLocaleKey, PromptToolTranslate } from '../../locales.ts'
import type { EngineMeta, LayerFieldPolicy, PromptConfigDraft, PromptConfigMatch } from '../../prompt-tool-types.ts'
/** sourceKind / form 是少量固定语义值，用下拉选择；引擎不设枚举，因此额外保留当前值。 */
export const SOURCE_KINDS = ['', 'plugin', 'instruction-hint', 'instruction-file', 'skill-catalog', 'env-facts'] as const
export const SOURCE_FORMS = ['notice', 'hint', 'instructions', ''] as const

/** UI 始终提供九个官方插入点；meta 额外返回的层仍保留在末尾，避免丢失未知配置。 */
export const INSERTION_LAYERS = [
  'pre-step',
  'system-section',
  'runtime-context',
  'agent-request',
  'llm-stream',
  'tool-pipeline',
  'turn-stop',
  'subagent-start',
  'subagent-end',
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
  'turn-stop': 'layer.turn-stop',
  'subagent-start': 'layer.subagent-start',
  'subagent-end': 'layer.subagent-end',
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
export const SOURCE_KIND_LABEL_KEYS: Record<string, PromptToolLocaleKey> = { '': 'sourceKind.default', plugin: 'sourceKind.plugin', 'instruction-hint': 'sourceKind.instructionHint', 'instruction-file': 'sourceKind.instructionFile', 'skill-catalog': 'sourceKind.skillCatalog', 'env-facts': 'sourceKind.envFacts' }
export const SOURCE_FORM_LABEL_KEYS: Record<string, PromptToolLocaleKey> = { notice: 'sourceForm.notice', hint: 'sourceForm.hint', instructions: 'sourceForm.instructions', '': 'sourceForm.default' }
export const IDENTITY_FIELD_LABEL_KEYS: Record<string, PromptToolLocaleKey> = { plugin: 'identity.plugin', kind: 'identity.kind' }
export const EMPTY_BEHAVIOR_LABEL_KEYS: Record<string, PromptToolLocaleKey> = { skip: 'emptyBehavior.skip', text: 'emptyBehavior.text' }
/** 条件判定的匹配对象（''= 层缺省，不写 subject 字段）。 */
export const SUBJECT_LABEL_KEYS: Record<string, PromptToolLocaleKey> = {
  '': 'subject.layerDefault',
  toolArgs: 'subject.toolArgs',
  toolResult: 'subject.toolResult',
  userMessage: 'subject.userMessage',
  assistantText: 'subject.assistantText',
  subagentInfo: 'subject.subagentInfo',
}
/** 组合逻辑取值（引擎 MATCH_LOGIC 的四个值），顺序即下拉展示顺序。 */
export const MATCH_LOGICS = ['any', 'all', 'not', 'notAny'] as const
export const MATCH_LOGIC_LABEL_KEYS: Record<string, PromptToolLocaleKey> = {
  any: 'match.any',
  all: 'match.all',
  not: 'match.not',
  notAny: 'match.notAny',
}
/**
 * useRegex 是三态而非开关：缺省（自动识别 `/pattern/flags`）、强制正则、强制字面。
 * 做成开关会把用户手写的 `useRegex: false`（强制字面）在编辑后静默变成自动识别。
 */
export const MATCH_REGEX_MODES = ['auto', 'force', 'literal'] as const
export const MATCH_REGEX_MODE_LABEL_KEYS: Record<string, PromptToolLocaleKey> = {
  auto: 'form.match.useRegex.auto',
  force: 'form.match.useRegex.force',
  literal: 'form.match.useRegex.literal',
}

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
  subject: false,
  match: false,
}

export function fieldPolicyFor(meta: EngineMeta, layer: string | undefined): LayerFieldPolicy {
  return meta.layerFieldPolicies[(layer ?? 'pre-step')] ?? EMPTY_POLICY
}

/**
 * 切换注入层的补丁：目标层不支持 subject/match 时清空旧值。
 * 引擎对不支持这两个字段的层直接 fail loud（整个预设无法挂载），
 * 所以「切过去顺手清掉」是唯一安全的层切换语义。
 */
export function clearedConditionPatch(meta: EngineMeta, layer: string): Pick<PromptConfigDraft, 'subject' | 'match'> {
  const policy = fieldPolicyFor(meta, layer)
  return {
    ...(policy.subject ? {} : { subject: undefined }),
    ...(policy.match ? {} : { match: undefined }),
  }
}

/**
 * 归一化 match 草稿：去空白键、丢缺省值（logic=any 与未开启的开关不落盘）。
 * 没有任何有效主/副键时返回 undefined——引擎的 match 要求至少一个非空键，
 * 半成品（只填了逻辑或开关）写进配置会让挂载期直接失败，因此不落盘。
 */
export function normalizeMatch(match: Partial<PromptConfigMatch> | undefined): PromptConfigMatch | undefined {
  const keys = (match?.keys ?? []).map((key) => key.trim()).filter((key) => key.length > 0)
  const secondaryKeys = (match?.secondaryKeys ?? []).map((key) => key.trim()).filter((key) => key.length > 0)
  if (keys.length === 0 && secondaryKeys.length === 0) return undefined
  // 非法 logic（手写 yml / 旧数据）回落缺省 any，而不是把非法值继续写回去。
  const logic = MATCH_LOGICS.find((value) => value === match?.logic)
  return {
    keys,
    ...(secondaryKeys.length > 0 ? { secondaryKeys } : {}),
    ...(logic !== undefined && logic !== 'any' ? { logic } : {}),
    ...(match?.caseSensitive === true ? { caseSensitive: true } : {}),
    ...(match?.wholeWords === true ? { wholeWords: true } : {}),
    ...(match?.useRegex !== undefined ? { useRegex: match.useRegex === true } : {}),
  }
}
