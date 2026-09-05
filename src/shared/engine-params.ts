/**
 * 引擎行为参数契约（单一来源）。
 *
 * 这是「可配置引擎参数」的类型唯一权威：所有消费引擎参数的接口（RuntimeOptions /
 * BuildCordisOptions / WritePresetOptions）从这里派生，不再各自手写一遍字段
 * （此前 5 处重复声明导致同字段签名漂移，如 maxDepth / usePtcMode）。
 *
 * 分层约定：
 *  - 本文件 = 引擎参数「契约层」（类型）：参数桥/模板/UI 可配置的键与类型；
 *  - ENGINE_PARAM_KEYS = 引擎参数「运行时键唯一权威」（数组字面量）；EngineParams
 *    接口与它双向相等断言（漏改任一侧 typecheck 报错），PARAM_KEYS 从这里派生；
 *  - 模型段 ↔ 扁平键的存储翻译唯二入口：loadPresetSpec 展平 / savePresetParams 迁移。
 *
 * 全部字段可选：缺省 = 模板 preset.yml params / 引擎默认，符合「一切皆可自定义」。
 */
export interface EngineParams {
  /** 首轮近距离锚定：首条真实用户消息后追加一次性首句锚点。 */
  firstTurnAnchor?: boolean
  /** 自定义锚点文本；firstTurnCustom=true 时固定使用。 */
  firstTurnText?: string
  /** 自定义锚点开关：true 固定使用 firstTurnText；false 按任务自动选择。 */
  firstTurnCustom?: boolean
  /** 自定义每轮引导文本；guideCustom=true 时固定使用。 */
  guideText?: string
  /** 自定义每轮引导开关：true 固定使用 guideText；false 按任务自动选择。 */
  guideCustom?: boolean
  /** 每轮引导独立开关；undefined = 兼容旧行为：跟随 firstTurnAnchor（关锚定 = 关引导）。 */
  guideEnabled?: boolean
  /** 锚定确认后注入 preset.md；关闭时仍保留工具引导，但不生成 prompt-injector 提示词配置内容。 */
  injectPrompt?: boolean
  /** 模型路由 provider；与模型名同时非空时给 subagent/subagent_fork 行加 agentOptions（主对话直派子代理与委派子代理通用）。 */
  modelProvider?: string
  /** 模型名；与 provider 同时非空时生效。 */
  modelName?: string
  /** 子代理固定模型路由 provider（agentOptions 注入 tool-subagent）。 */
  subagentModelProvider?: string
  /** 子代理固定模型名。 */
  subagentModelName?: string
  /** 主对话思维程度（agent-request patch reasoningEffort；''=不设置，官方档位 off/low/high/max）。 */
  modelReasoningEffort?: string
  /** 主对话采样温度（agent-request patch temperature；''=不设置）。 */
  modelTemperature?: string
  /** 主对话输出上限（agent-request patch maxTokens；''=不设置）。 */
  modelMaxTokens?: string
  /** 子代理思维程度（agent-request patch，audience=subagent；''=不设置）。 */
  subagentReasoningEffort?: string
  /** 子代理采样温度（agent-request patch，audience=subagent；''=不设置）。 */
  subagentTemperature?: string
  /** 子代理输出上限（agent-request patch，audience=subagent；''=不设置）。 */
  subagentMaxTokens?: string
  /** 委派工具集白名单（toolFilter.allow；支持数组或逗号/空格分隔字符串）。 */
  toolFilterAllow?: string[] | string
  /** 委派工具集黑名单（toolFilter.deny）。 */
  toolFilterDeny?: string[] | string
  /** 委派递归深度上限（0 禁止委派 / provider-managed / 正整数；YAML 字符串标量兼容）。 */
  maxDepth?: number | 'provider-managed' | string
  /** 注入 kind 白名单（context-gate allowKinds；数组或逗号分隔字符串）。 */
  allowKinds?: string[] | string
  /** custom-fallback 锚定词（prompt-injector params.firstTurnWord）。 */
  firstTurnWord?: string
  /** 首轮输出封顶（bootstrapMaxTokens）；0 或未设置 = 本项目默认无封顶。 */
  bootstrapMaxTokens?: number
  /** 使用 PTC 模式；undefined = 模板/引擎默认（false，opt-in）。 */
  usePtcMode?: boolean | undefined
  /** 门控晋升：首段 reasoning minimal-like + 工具调用才晋升（tool-bootstrap 参数桥扁平键）。 */
  promoteGate?: boolean
  /** 无工具首响应 / 首轮 turn/end 即晋升。 */
  promoteAfterFirstResponse?: boolean
  /** 门控回退：步数达上限强制晋升（默认 4）。 */
  maxPromoteSteps?: number
  /** 首轮工具窄化集（覆盖行默认 [bash, str_replace_editor]；必须非空）。 */
  bootstrapTools?: string[] | string
  /** 压缩后恢复工具集（模型中途继续工作的核心工具）。 */
  compactionTools?: string[] | string
  /** phase-1 提示词段只留 persona。 */
  personaSectionsOnly?: boolean
  /** 晋升后 persona 附加工作目录行。 */
  workspaceLine?: boolean
  /** context-gate phase-1 消息源白名单（空 = 不启用）。 */
  messageSources?: string[] | string
  /** 晋升后延迟注入的 source kind。 */
  deferredSources?: string[] | string
  /** 延迟注入宽限步数。 */
  deferredGraceSteps?: number
  /** 晋升后 agent-instructions 全文 → 一次性 hint。 */
  instructionHint?: boolean
  /** phase-1 persona 追加的首次调用指令行。 */
  phase1FirstCallInstruction?: string
  /** 渐进披露阶段定义 [{ name, tools }]；声明即激活多级阶段窄化。 */
  stages?: Array<{ name: string; tools: string[] }>
  /** 阶段预放档数（默认 1）。 */
  stagePreUnlock?: number
  /** 阶段推进工具名（默认 phase_advance）。 */
  stageAdvanceTool?: string
  /** 阶段推进工具描述。 */
  stageAdvanceDescription?: string
  /** 阶段状态 section 模板（{{stage}}/{{stageName}}/{{unlocked}}/{{total}}；空 = 不注入）。 */
  stageSectionTemplate?: string
  /** 子代理也启用主对话工具过滤。 */
  toolFilterSubagents?: boolean
  /** str-replace-editor 最大输出字符数（参数桥默认官方值 16000；由引擎能力卡编辑）。 */
  strReplaceEditorMaxOutputChars?: number
  /** 前置锚定轮（anchor-turn 行）：用户首条真实消息前 prepend 合成锚定轮；false = 行挂载但禁用。 */
  anchorTurn?: boolean
  /** 前置锚定轮自定义锚定文本（空 = 引擎默认 "This round is a test…"）。 */
  anchorTurnText?: string
  /** 轨迹深度门（deliberation-gate 行）：首工具调用前流式深思 < 下限时 deny 一次；false = 行挂载但禁用。 */
  deliberationGate?: boolean
  /** 轨迹深度门深思下限（字符数；默认 400）。 */
  deliberationMinChars?: number
  /** 轨迹深度门每轮最大 deny 次数（默认 1）。 */
  deliberationMaxGatesPerTurn?: number
  /** 深思维持节拍（cot-drip 行）：每 N 次工具结果滴入一条 "We…" 重申；false = 行挂载但禁用。 */
  cotDrip?: boolean
  /** 深思维持节拍间隔（工具结果数；默认 4；0 = 禁用滴入）。 */
  cotDripEvery?: number
  /** 深思维持节拍每轮最大提醒条数（默认 1）。 */
  cotDripMaxPerTurn?: number
}

/**
 * 引擎行为参数键唯一权威（数组字面量 = 运行时事实）。
 * 与 EngineParams 接口双向相等断言：新增参数必须同时改接口与列表，漏改任一侧
 * typecheck 失败（防历史事故：PARAM_KEYS 漏 25 键混入 variables.yml 污染注入）。
 */
export const ENGINE_PARAM_KEYS = [
  // 锚定/引导/注入。
  'firstTurnAnchor', 'firstTurnText', 'firstTurnCustom',
  'guideText', 'guideCustom', 'guideEnabled', 'injectPrompt',
  // 模型路由与模型参数（agent-request patch）。
  'modelProvider', 'modelName',
  'subagentModelProvider', 'subagentModelName',
  'modelReasoningEffort', 'modelTemperature', 'modelMaxTokens',
  'subagentReasoningEffort', 'subagentTemperature', 'subagentMaxTokens',
  // 委派与工具过滤。
  'toolFilterAllow', 'toolFilterDeny', 'maxDepth',
  'allowKinds', 'firstTurnWord', 'bootstrapMaxTokens', 'usePtcMode',
  // 晋升门控（tool-bootstrap 参数桥）。
  'promoteGate', 'promoteAfterFirstResponse', 'maxPromoteSteps',
  'bootstrapTools', 'compactionTools', 'personaSectionsOnly', 'workspaceLine',
  'phase1FirstCallInstruction',
  // context-gate 注入门控。
  'messageSources', 'deferredSources', 'deferredGraceSteps', 'instructionHint',
  // 渐进披露（stages 模式）。
  'stages', 'stagePreUnlock', 'stageAdvanceTool', 'stageAdvanceDescription', 'stageSectionTemplate',
  // 工具行级参数。
  'toolFilterSubagents', 'strReplaceEditorMaxOutputChars',
  // 锚定/深思可选模块（anchor-turn / deliberation-gate / cot-drip 行）。
  'anchorTurn', 'anchorTurnText',
  'deliberationGate', 'deliberationMinChars', 'deliberationMaxGatesPerTurn',
  'cotDrip', 'cotDripEvery', 'cotDripMaxPerTurn',
] as const

export type EngineParamKey = typeof ENGINE_PARAM_KEYS[number]

/** 双向相等断言工具：两字符串集合完全一致 → true，否则 false。 */
type AssertKeysEqual<A extends string, B extends string> =
  Exclude<A, B> extends never
    ? Exclude<B, A> extends never ? true : false
    : false

/** 编译期断言：EngineParams 接口键与 ENGINE_PARAM_KEYS 必须完全一致（多/漏任一键 → 编译错误）。 */
const _assertEngineParamsKeys: AssertKeysEqual<keyof EngineParams, EngineParamKey> = true

/**
 * writePreset.runtimeOf 实际透传进运行时 params 的引擎参数子集。
 * RuntimeOptions（装配态）与 WritePresetOptions（写入态）都从这里派生，
 * 防止「加参数只改一处、writePreset 忘透传」的静默漂移（如 stageAdvanceDescription 历史事故）。
 */
export type PresetWriterParams = Pick<EngineParams,
  | 'firstTurnAnchor' | 'firstTurnText' | 'firstTurnCustom'
  | 'guideText' | 'guideCustom' | 'guideEnabled' | 'injectPrompt'
  | 'modelProvider' | 'modelName' | 'subagentModelProvider' | 'subagentModelName'
  | 'modelReasoningEffort' | 'modelTemperature' | 'modelMaxTokens'
  | 'subagentReasoningEffort' | 'subagentTemperature' | 'subagentMaxTokens'
  | 'toolFilterAllow' | 'toolFilterDeny' | 'maxDepth'
  | 'allowKinds' | 'firstTurnWord' | 'bootstrapMaxTokens' | 'usePtcMode'
  | 'anchorTurn' | 'anchorTurnText'
  | 'deliberationGate' | 'deliberationMinChars' | 'deliberationMaxGatesPerTurn'
  | 'cotDrip' | 'cotDripEvery' | 'cotDripMaxPerTurn'>

/** writePreset.runtimeOf 实际透传键（与 PresetWriterParams 双向相等断言，防 Pick 漏键）。 */
export const WRITER_PARAM_KEYS = [
  'firstTurnAnchor', 'firstTurnText', 'firstTurnCustom',
  'guideText', 'guideCustom', 'guideEnabled', 'injectPrompt',
  'modelProvider', 'modelName', 'subagentModelProvider', 'subagentModelName',
  'modelReasoningEffort', 'modelTemperature', 'modelMaxTokens',
  'subagentReasoningEffort', 'subagentTemperature', 'subagentMaxTokens',
  'toolFilterAllow', 'toolFilterDeny', 'maxDepth',
  'allowKinds', 'firstTurnWord', 'bootstrapMaxTokens', 'usePtcMode',
  'anchorTurn', 'anchorTurnText',
  'deliberationGate', 'deliberationMinChars', 'deliberationMaxGatesPerTurn',
  'cotDrip', 'cotDripEvery', 'cotDripMaxPerTurn',
] as const

/** 编译期断言：WRITER_PARAM_KEYS 与 PresetWriterParams 键必须一致（Pick 漏键 → 编译错误）。 */
const _assertWriterParamsKeys: AssertKeysEqual<typeof WRITER_PARAM_KEYS[number], keyof PresetWriterParams> = true


/**
 * 数值型引擎参数保存前校验（与 write-preset.modelRequestConfigs 消费规则同源）。
 * 保存层响亮失败（400 逐字段错误），渲染层保持宽容（never-brick）：
 *   - 布尔键：必须是 boolean；
 *   - 数值键（temperature / maxTokens / 步数 / 字符数）：'' = 合法（删键回落默认）；
 *     非空必须可解析为数字并满足各自约束（有限数 / 正整数 / 非负整数）；
 *   - 字符串键：必须是 string（'' = 删键回落默认）；
 *   - 列表键（工具集 / 白名单 / 来源）：必须是 string 或 string[]；
 *   - maxDepth：'' / 'provider-managed' / 非负整数 / 字符串标量；
 *   - stages：{ name, tools } 数组。
 * 未知键（旧内容别名等不兼容键）在保存期响亮失败，不做运行时自动兼容。
 * 注意：内容占位变量（variables）的空字符串是合理设计（世界书动态引用），
 * 本函数只校验引擎行为参数，绝不碰 variables 通道。
 */
export interface EngineParamValueError {
  key: string
  message: string
}

type ParamRule =
  | { kind: 'boolean' }
  | { kind: 'number'; check: (value: number) => string | undefined }
  | { kind: 'string' }
  | { kind: 'string-list' }
  | { kind: 'max-depth' }
  | { kind: 'stages' }

const FINITE_NUMBER: (value: number) => string | undefined = (value) =>
  Number.isFinite(value) ? undefined : '必须是有限数字'
const POSITIVE_INTEGER: (value: number) => string | undefined = (value) =>
  Number.isSafeInteger(value) && value > 0 ? undefined : '必须是正整数'
const NON_NEGATIVE_INTEGER: (value: number) => string | undefined = (value) =>
  Number.isSafeInteger(value) && value >= 0 ? undefined : '必须是非负整数'

/** 全量引擎参数校验规则（键 = ENGINE_PARAM_KEYS 的 canonical 键；缺键 = 不校验该键）。 */
const PARAM_RULES: Record<string, ParamRule> = {
  // 锚定/引导/注入。
  firstTurnAnchor: { kind: 'boolean' },
  firstTurnText: { kind: 'string' },
  firstTurnCustom: { kind: 'boolean' },
  guideText: { kind: 'string' },
  guideCustom: { kind: 'boolean' },
  guideEnabled: { kind: 'boolean' },
  injectPrompt: { kind: 'boolean' },
  // 模型路由与模型参数（agent-request patch）。
  modelProvider: { kind: 'string' },
  modelName: { kind: 'string' },
  subagentModelProvider: { kind: 'string' },
  subagentModelName: { kind: 'string' },
  modelReasoningEffort: { kind: 'string' },
  modelTemperature: { kind: 'number', check: FINITE_NUMBER },
  modelMaxTokens: { kind: 'number', check: POSITIVE_INTEGER },
  subagentReasoningEffort: { kind: 'string' },
  subagentTemperature: { kind: 'number', check: FINITE_NUMBER },
  subagentMaxTokens: { kind: 'number', check: POSITIVE_INTEGER },
  // 委派与工具过滤。
  toolFilterAllow: { kind: 'string-list' },
  toolFilterDeny: { kind: 'string-list' },
  maxDepth: { kind: 'max-depth' },
  allowKinds: { kind: 'string-list' },
  firstTurnWord: { kind: 'string' },
  bootstrapMaxTokens: { kind: 'number', check: POSITIVE_INTEGER },
  usePtcMode: { kind: 'boolean' },
  // 晋升门控（tool-bootstrap 参数桥）。
  promoteGate: { kind: 'boolean' },
  promoteAfterFirstResponse: { kind: 'boolean' },
  maxPromoteSteps: { kind: 'number', check: POSITIVE_INTEGER },
  bootstrapTools: { kind: 'string-list' },
  compactionTools: { kind: 'string-list' },
  personaSectionsOnly: { kind: 'boolean' },
  workspaceLine: { kind: 'boolean' },
  phase1FirstCallInstruction: { kind: 'string' },
  // context-gate 注入门控。
  messageSources: { kind: 'string-list' },
  deferredSources: { kind: 'string-list' },
  deferredGraceSteps: { kind: 'number', check: NON_NEGATIVE_INTEGER },
  instructionHint: { kind: 'boolean' },
  // 渐进披露（stages 模式）。
  stages: { kind: 'stages' },
  stagePreUnlock: { kind: 'number', check: NON_NEGATIVE_INTEGER },
  stageAdvanceTool: { kind: 'string' },
  stageAdvanceDescription: { kind: 'string' },
  stageSectionTemplate: { kind: 'string' },
  // 工具行级参数。
  toolFilterSubagents: { kind: 'boolean' },
  strReplaceEditorMaxOutputChars: { kind: 'number', check: POSITIVE_INTEGER },
  // 锚定/深思可选模块。
  anchorTurn: { kind: 'boolean' },
  anchorTurnText: { kind: 'string' },
  deliberationGate: { kind: 'boolean' },
  deliberationMinChars: { kind: 'number', check: POSITIVE_INTEGER },
  deliberationMaxGatesPerTurn: { kind: 'number', check: POSITIVE_INTEGER },
  cotDrip: { kind: 'boolean' },
  cotDripEvery: { kind: 'number', check: NON_NEGATIVE_INTEGER },
  cotDripMaxPerTurn: { kind: 'number', check: POSITIVE_INTEGER },
}

/** 校验单个键值；返回错误消息（undefined = 通过）。 */
function validateParamValue(key: string, rule: ParamRule, value: unknown): string | undefined {
  switch (rule.kind) {
    case 'boolean':
      return typeof value === 'boolean' ? undefined : `${key}: 必须是布尔值`
    case 'number': {
      // '' 是合法删键值（留空 = 不设置）。
      if (value === '') return undefined
      if (typeof value === 'number') {
        if (!Number.isFinite(value)) return `${key}: 必须是有限数字（留空 = 不设置）`
        const reason = rule.check(value)
        return reason === undefined ? undefined : `${key}: ${reason}（留空 = 不设置）`
      }
      if (typeof value === 'string') {
        const text = value.trim()
        if (text.length === 0) return `${key}: 必须是数字（留空 = 不设置）`
        const numeric = Number(text)
        if (Number.isNaN(numeric)) return `${key}: 必须是数字（留空 = 不设置）`
        const reason = rule.check(numeric)
        return reason === undefined ? undefined : `${key}: ${reason}（留空 = 不设置）`
      }
      return `${key}: 必须是数字或数字字符串（留空 = 不设置）`
    }
    case 'string':
      return typeof value === 'string' ? undefined : `${key}: 必须是字符串`
    case 'string-list':
      if (typeof value === 'string') return undefined
      if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return undefined
      return `${key}: 必须是字符串或字符串数组`
    case 'max-depth':
      if (value === '' || value === 'provider-managed') return undefined
      if (typeof value === 'number') {
        return Number.isSafeInteger(value) && value >= 0
          ? undefined
          : `${key}: 必须是非负整数、provider-managed 或字符串`
      }
      if (typeof value === 'string') return undefined
      return `${key}: 必须是非负整数、provider-managed 或字符串`
    case 'stages': {
      // 空数组 = 删键（清空全部阶段）；空串兼容 UI 清空。
      if (value === '' || (Array.isArray(value) && value.length === 0)) return undefined
      if (!Array.isArray(value)) return `${key}: 必须是阶段数组`
      for (const [index, stage] of value.entries()) {
        if (stage === null || typeof stage !== 'object' || Array.isArray(stage)) {
          return `${key}[${index}]: 必须是 { name, tools } 对象`
        }
        const record = stage as Record<string, unknown>
        if (typeof record.name !== 'string' || record.name.trim().length === 0) {
          return `${key}[${index}]: name 必须是非空字符串`
        }
        if (!Array.isArray(record.tools) || !record.tools.every((tool) => typeof tool === 'string')) {
          return `${key}[${index}]: tools 必须是字符串数组`
        }
      }
      return undefined
    }
  }
}

/**
 * 校验参数键值（键集合合法性由调用方白名单先行校验，本函数同样拒绝未知键）。
 * 返回逐字段错误；空数组 = 通过。类型收窄：布尔/字符串/数值/列表各按 canonical
 * 规则校验；'' 是合法删键值，其余非法类型与越界值在保存层响亮失败。
 */
export function validateEngineParamValues(overrides: Record<string, unknown>): EngineParamValueError[] {
  const errors: EngineParamValueError[] = []
  for (const [key, value] of Object.entries(overrides)) {
    // undefined/null 由保存层跳过。
    if (value === undefined || value === null) continue
    const rule = PARAM_RULES[key]
    if (rule === undefined) {
      errors.push({ key, message: `${key}: 未知参数键（旧键已移除运行时兼容，请用迁移脚本清理）` })
      continue
    }
    const message = validateParamValue(key, rule, value)
    if (message !== undefined) errors.push({ key, message })
  }
  return errors
}
