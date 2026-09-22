import type { PromptToolLocaleKey, PromptToolTranslate } from '../../locales.ts'
import { ENGINE_LAYER_ORDER, engineGroupParamKeys, type EngineLayer } from '../../../shared/engine-capabilities.ts'
import { LAYER_FIELD_POLICY_KEYS, type EngineMeta, type LayerFieldPolicy, type LayerFieldPolicyKey, type MatchLogic, type PromptConfigDraft, type PromptConfigMatch } from '../../prompt-tool-types.ts'
import type { LayerContract } from '../../../shared/bridge-contract.ts'
/**
 * sourceKind / form 是少量固定语义值，用下拉选择；**UI 专有，引擎无对应枚举**——
 * 引擎把两者当自由字符串收（schema.mjs:605-606 只做非空与缺省 'notice'），
 * 下列取值是客户端下拉的约定集合，引擎不校验、也不下发。引擎不设枚举故额外保留当前值。
 */
export const SOURCE_KINDS = ['', 'plugin', 'instruction-hint', 'instruction-file', 'skill-catalog', 'env-facts'] as const
export const SOURCE_FORMS = ['notice', 'hint', 'instructions', ''] as const

/**
 * 层序的唯一来源是宿主 meta.layerOrder（运行时由引擎 schema 下发）。
 * 这里只留共享契约里的九层作退化默认：旧宿主不下发 layerOrder 时仍能渲染完整菜单。
 */
export const INSERTION_LAYERS = ENGINE_LAYER_ORDER

/**
 * 九层顺序在前，其余层追加在末尾（旧数据里的未知层不丢）。
 * layerOrder 缺失或为空（旧宿主、首屏）时退化为共享九层，不崩也不清空层列表。
 */
export function displayLayers(layerOrder: readonly string[] | undefined, layers: readonly string[]): string[] {
  const base: readonly string[] = Array.isArray(layerOrder) && layerOrder.length > 0 ? layerOrder : INSERTION_LAYERS
  return [...base, ...layers.filter((layer) => !base.includes(layer))]
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
/**
 * 层显示标签的字典键：键集由共享契约的 {@link EngineLayer} 联合在编译期约束（九层穷尽、禁多余键），
 * 与引擎下发的 layerLabels 的键集对拍见 test/client/mirror-guards.test.mjs。
 * 文案仍归 `prompt-tool` 字典（zh/en 双份），不消费 /meta 的 layerLabels.title（引擎只下发中文单份）。
 */
export const LAYER_LABEL_KEYS: Record<EngineLayer, PromptToolLocaleKey> = {
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
/** 官方装配刻度的区段显示名（id 来自 src/shared/official-orders.ts；这里只有名字，没有数值）。 */
export const OFFICIAL_ORDER_GROUP_LABEL_KEYS: Record<string, PromptToolLocaleKey> = {
  identity: 'orderGroup.identity',
  policy: 'orderGroup.policy',
  tools: 'orderGroup.tools',
  sdk: 'orderGroup.sdk',
  deliverable: 'orderGroup.deliverable',
  closing: 'orderGroup.closing',
  'runtime-policy': 'orderGroup.runtimePolicy',
}
/** 只有把 order 原样交给官方 `section()` / `context()` 的两层才展示官方刻度。 */
export const OFFICIAL_ORDER_LAYERS: readonly EngineLayer[] = ['system-section', 'runtime-context']
export const FILL_LABEL_KEYS: Record<string, PromptToolLocaleKey> = { '': 'fill.none', 'instruction-hint': 'fill.instructionHint', 'env-facts': 'fill.envFacts', 'skill-catalog': 'fill.skillCatalog' }
/** 上述两个 UI 专有取值集的标签键：没有引擎值可对拍，只给本地下拉用。 */
export const SOURCE_KIND_LABEL_KEYS: Record<string, PromptToolLocaleKey> = { '': 'sourceKind.default', plugin: 'sourceKind.plugin', 'instruction-hint': 'sourceKind.instructionHint', 'instruction-file': 'sourceKind.instructionFile', 'skill-catalog': 'sourceKind.skillCatalog', 'env-facts': 'sourceKind.envFacts' }
export const SOURCE_FORM_LABEL_KEYS: Record<string, PromptToolLocaleKey> = { notice: 'sourceForm.notice', hint: 'sourceForm.hint', instructions: 'sourceForm.instructions', '': 'sourceForm.default' }
/**
 * identity.field：引擎只接受 'plugin'（schema.mjs:450，kind 模式已与 sourceKind 归一），
 * 表单也只提供 ['plugin']（PromptConfigForm 的 IdentityFields）；'kind' 是历史遗留标签键，
 * 当前没有消费点，保留不改动（删它属于 UI 面收紧，不在本次零行为变更范围内）。
 */
export const IDENTITY_FIELD_LABEL_KEYS: Record<string, PromptToolLocaleKey> = { plugin: 'identity.plugin', kind: 'identity.kind' }
/**
 * emptyBehavior：引擎消费点内联取 'text'，其余一律按 'skip'（fillers.mjs），
 * schema 未声明枚举，因此这里同样不引用 /meta。
 */
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
/**
 * 组合逻辑取值（引擎 MATCH_LOGIC 的四个值），顺序即下拉展示顺序；取值域由 {@link MatchLogic} 约束。
 * 不做运行期派生：产品代码不 import engine/*.mjs（无既有先例），
 * 与 engine/anchor-match.mjs 的逐值对拍守卫见 test/client/prompt-config-form-layout.test.mjs。
 */
export const MATCH_LOGICS: readonly MatchLogic[] = ['any', 'all', 'not', 'notAny']
export const MATCH_LOGIC_LABEL_KEYS: Record<MatchLogic, PromptToolLocaleKey> = {
  any: 'match.any',
  all: 'match.all',
  not: 'match.not',
  notAny: 'match.notAny',
}
/**
 * useRegex 是三态而非开关：缺省（自动识别 `/pattern/flags`）、强制正则、强制字面。
 * 做成开关会把用户手写的 `useRegex: false`（强制字面）在编辑后静默变成自动识别。
 * 这三态是 **UI 专有**编辑形态（引擎只收 useRegex 布尔值），无对应引擎枚举。
 */
export const MATCH_REGEX_MODES = ['auto', 'force', 'literal'] as const
export const MATCH_REGEX_MODE_LABEL_KEYS: Record<string, PromptToolLocaleKey> = {
  auto: 'form.match.useRegex.auto',
  force: 'form.match.useRegex.force',
  literal: 'form.match.useRegex.literal',
}

/** 从引擎 /meta 中读取某层的字段能力；未知层回退 pre-step。空策略按键表派生，全 false。 */
// Object.fromEntries 只能给索引签名，故此处断言：键集由 LAYER_FIELD_POLICY_KEYS 保证（不得手写第二份）。
const EMPTY_POLICY = Object.fromEntries(
  LAYER_FIELD_POLICY_KEYS.map((key): [LayerFieldPolicyKey, boolean] => [key, false]),
) as LayerFieldPolicy

export function fieldPolicyFor(meta: EngineMeta, layer: string | undefined): LayerFieldPolicy {
  return meta.layerFieldPolicies[(layer ?? 'pre-step')] ?? EMPTY_POLICY
}

export function layerContractFor(meta: EngineMeta, layer: string | undefined): LayerContract | undefined {
  return (meta.layerContracts as Record<string, LayerContract> | undefined)?.[layer ?? 'pre-step']
}

/** 只有用户明确换层才清理目标层拒绝的字段；隐藏正文、未知 params 不被删除。 */
export function layerChangePatch(meta: EngineMeta, config: PromptConfigDraft, layer: string): Partial<PromptConfigDraft> {
  const policy = fieldPolicyFor(meta, layer)
  const contract = layerContractFor(meta, layer)
  const patch: Partial<PromptConfigDraft> = { layer, ...clearedConditionPatch(meta, layer) }
  for (const field of ['position', 'dedupe', 'promotion', 'audience', 'modelScope', 'role'] as const) {
    if (!policy[field] && config[field] != null) Object.assign(patch, { [field]: undefined })
  }
  if (!policy.merge && config.mergeMode !== undefined) patch.mergeMode = undefined
  if (config.subject !== undefined && contract !== undefined && !contract.subjects.includes(config.subject)) patch.subject = undefined
  if (contract !== undefined && !contract.strategies.includes(config.strategy ?? 'static')) {
    patch.strategy = 'static'
    patch.fill = undefined
  }
  return patch
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

/**
 * 统一搜索：同时覆盖「中文名」与「技术键」，只拼可搜索文本，不改变过滤语义
 * （过滤仍然只影响展示，不写盘、不改变保存载荷，也不把匹配结果合并成一张层结果）。
 */
function matchesKeyword(text: string, keyword: string): boolean {
  return keyword.length === 0 || text.toLowerCase().includes(keyword)
}

/** 配置实例的搜索文本：标识、名称、枚举技术值与其中文标签、局部参数键。 */
export function configSearchText(config: PromptConfigDraft, t: PromptToolTranslate): string {
  const params = Object.keys(config.params ?? {})
  return [
    config.id,
    config.name ?? '',
    config.layer ?? '',
    config.strategy ?? '',
    config.position ?? '',
    config.dedupe ?? '',
    config.mergeMode ?? '',
    config.fill ?? '',
    config.sourceKind ?? '',
    config.form ?? '',
    config.role ?? '',
    config.audience ?? '',
    config.modelScope ?? '',
    ...params,
    translateLabel(t, LAYER_LABEL_KEYS, config.layer ?? 'pre-step'),
    translateLabel(t, STRATEGY_LABEL_KEYS, config.strategy ?? ''),
    translateLabel(t, POSITION_LABEL_KEYS, config.position ?? ''),
    translateLabel(t, FILL_LABEL_KEYS, config.fill ?? ''),
    translateLabel(t, SOURCE_KIND_LABEL_KEYS, config.sourceKind ?? ''),
    translateLabel(t, SOURCE_FORM_LABEL_KEYS, config.form ?? ''),
    translateLabel(t, AUDIENCE_LABEL_KEYS, config.audience ?? ''),
    translateLabel(t, MODEL_SCOPE_LABEL_KEYS, config.modelScope ?? ''),
  ].join(' ')
}

/** 该配置实例是否命中搜索词（配置名、标识、注入层与参数名）。 */
export function matchesConfigKeyword(config: PromptConfigDraft, keyword: string, t: PromptToolTranslate): boolean {
  return matchesKeyword(configSearchText(config, t), keyword)
}

/**
 * 编辑组 / 能力卡是否命中搜索词：能力 id（技术键）+ 该组参数键 + 参数中文标签。
 * 参数键取自 shared 派生，与能力卡侧的判定同一口径（本文件不反向依赖其他 feature）。
 */
export function matchesEditorGroup(id: string, keyword: string, t: PromptToolTranslate): boolean {
  if (keyword.length === 0) return true
  const keys = engineGroupParamKeys(id)
  return [id, ...keys, ...keys.map((key) => t(`param.${key}`))].join(' ').toLowerCase().includes(keyword)
}
