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
  /** str-replace-editor 最大输出字符数（参数桥默认官方值 16000；UI 无专卡，高级参数 JSON 可编辑）。 */
  strReplaceEditorMaxOutputChars?: number
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
  | 'allowKinds' | 'firstTurnWord' | 'bootstrapMaxTokens' | 'usePtcMode'>

/** writePreset.runtimeOf 实际透传键（与 PresetWriterParams 双向相等断言，防 Pick 漏键）。 */
export const WRITER_PARAM_KEYS = [
  'firstTurnAnchor', 'firstTurnText', 'firstTurnCustom',
  'guideText', 'guideCustom', 'guideEnabled', 'injectPrompt',
  'modelProvider', 'modelName', 'subagentModelProvider', 'subagentModelName',
  'modelReasoningEffort', 'modelTemperature', 'modelMaxTokens',
  'subagentReasoningEffort', 'subagentTemperature', 'subagentMaxTokens',
  'toolFilterAllow', 'toolFilterDeny', 'maxDepth',
  'allowKinds', 'firstTurnWord', 'bootstrapMaxTokens', 'usePtcMode',
] as const

/** 编译期断言：WRITER_PARAM_KEYS 与 PresetWriterParams 键必须一致（Pick 漏键 → 编译错误）。 */
const _assertWriterParamsKeys: AssertKeysEqual<typeof WRITER_PARAM_KEYS[number], keyof PresetWriterParams> = true
