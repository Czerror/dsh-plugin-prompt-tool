/**
 * 引擎行为参数契约（单一来源）。
 *
 * 这是「可配置引擎参数」的类型唯一权威：所有消费引擎参数的接口（RuntimeOptions /
 * BuildCordisOptions / WritePresetOptions）从这里派生，不再各自手写一遍字段
 * （此前 5 处重复声明导致同字段签名漂移，如 maxDepth / usePtcMode）。
 *
 * 分层约定：
 *  - 本文件 = 引擎参数「契约层」（类型）：参数桥/模板/UI 可配置的键与类型；
 *  - ENGINE_PARAM_DEFINITIONS 统一键、校验、卡片、默认草稿与组合映射；
 *    Record<keyof EngineParams, ...> 强制完整覆盖，ENGINE_PARAM_KEYS 与 PARAM_KEYS 从其派生；
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
  /** 各能力的受众/晋升信号独立配置，不建立跨模块全局顺序。 */
  bootstrapSubagents?: boolean
  bootstrapPromoteOn?: string
  contextGateEnabled?: boolean
  contextGateSubagents?: boolean
  contextGatePromoteOn?: string
  ptcSubagents?: boolean
  ptcPromoteOn?: string
  toolFilterEnabled?: boolean
  anchorTurnSubagents?: boolean
  deliberationSubagents?: boolean
  deliberationGateText?: string
  cotDripSubagents?: boolean
  cotDripText?: string
  /** 自定义模型工具在执行前需用户批准的执行器种类。 */
  customToolRequireApproval?: string[] | string
}

export type EngineParamKey = keyof EngineParams

/** 双向相等断言工具：两字符串集合完全一致 → true，否则 false。 */
type AssertKeysEqual<A extends string, B extends string> =
  Exclude<A, B> extends never
    ? Exclude<B, A> extends never ? true : false
    : false

/**
 * writePreset.runtimeOf 实际透传进运行时 params 的引擎参数子集。
 * RuntimeOptions（装配态）与 WritePresetOptions（写入态）都从这里派生，
 * 防止「加参数只改一处、writePreset 忘透传」的静默漂移（如 stageAdvanceDescription 历史事故）。
 */
export type PresetWriterParams = Partial<EngineParams>

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
  | { kind: 'string'; options?: readonly string[] }
  | { kind: 'string-list'; options?: readonly string[] }
  | { kind: 'max-depth' }
  | { kind: 'stages' }

const FINITE_NUMBER: (value: number) => string | undefined = (value) =>
  Number.isFinite(value) ? undefined : '必须是有限数字'
const POSITIVE_INTEGER: (value: number) => string | undefined = (value) =>
  Number.isSafeInteger(value) && value > 0 ? undefined : '必须是正整数'
const NON_NEGATIVE_INTEGER: (value: number) => string | undefined = (value) =>
  Number.isSafeInteger(value) && value >= 0 ? undefined : '必须是非负整数'
const PROMOTE_ON = ['either', 'tool-call', 'assistant-message'] as const

export type EngineParamDefinition = ParamRule & {
  card: string
  label: string
  /** 未配置时的编辑草稿；不等于强制写入运行时默认值。 */
  defaultValue: string | number | boolean | undefined | { name: string; tools: string }[]
  module?: { row: string; key?: string; mode?: 'positive' | 'nonempty-list' | 'editor-default' | 'optional-cap' }
}

/** 类型、校验、卡片归属、草稿默认值和组合行映射的唯一运行时目录。 */
export const ENGINE_PARAM_DEFINITIONS: Record<EngineParamKey, EngineParamDefinition> = {
  firstTurnAnchor: { kind: 'boolean', defaultValue: false, card: 'prompt-defaults', label: '首轮锚定' },
  firstTurnText: { kind: 'string', defaultValue: '', card: 'prompt-defaults', label: '首轮锚定文本' },
  firstTurnCustom: { kind: 'boolean', defaultValue: false, card: 'prompt-defaults', label: '使用自定义锚定文本' },
  guideText: { kind: 'string', defaultValue: '', card: 'prompt-defaults', label: '每轮引导文本' },
  guideCustom: { kind: 'boolean', defaultValue: false, card: 'prompt-defaults', label: '使用自定义引导文本' },
  guideEnabled: { kind: 'boolean', defaultValue: undefined, card: 'prompt-defaults', label: '每轮引导（未设置时跟随锚定）' },
  injectPrompt: { kind: 'boolean', defaultValue: true, card: 'prompt-defaults', label: '锚定确认后注入内容' },
  modelProvider: { kind: 'string', defaultValue: '', card: 'main-model', label: '模型服务商' },
  modelName: { kind: 'string', defaultValue: '', card: 'main-model', label: '模型' },
  subagentModelProvider: { kind: 'string', defaultValue: '', card: 'subagent-model', label: '子代理模型服务商' },
  subagentModelName: { kind: 'string', defaultValue: '', card: 'subagent-model', label: '子代理模型' },
  modelReasoningEffort: { kind: 'string', defaultValue: '', card: 'main-model', label: '思维程度' },
  modelTemperature: { kind: 'number', check: FINITE_NUMBER, defaultValue: '', card: 'main-model', label: '采样温度' },
  modelMaxTokens: { kind: 'number', check: POSITIVE_INTEGER, defaultValue: '', card: 'main-model', label: '输出上限' },
  subagentReasoningEffort: { kind: 'string', defaultValue: '', card: 'subagent-model', label: '子代理思维程度' },
  subagentTemperature: { kind: 'number', check: FINITE_NUMBER, defaultValue: '', card: 'subagent-model', label: '子代理采样温度' },
  subagentMaxTokens: { kind: 'number', check: POSITIVE_INTEGER, defaultValue: '', card: 'subagent-model', label: '子代理输出上限' },
  toolFilterAllow: { kind: 'string-list', defaultValue: '', card: 'tool-filter', label: '工具白名单', module: { row: 'tool-filter', key: 'allow', mode: 'nonempty-list' } },
  toolFilterDeny: { kind: 'string-list', defaultValue: '', card: 'tool-filter', label: '工具黑名单', module: { row: 'tool-filter', key: 'deny', mode: 'nonempty-list' } },
  maxDepth: { kind: 'max-depth', defaultValue: '', card: 'subagent-tools', label: '递归深度' },
  allowKinds: { kind: 'string-list', defaultValue: '', card: 'context-gate', label: '注入 kind 白名单', module: { row: 'context-gate' } },
  firstTurnWord: { kind: 'string', defaultValue: '', card: 'prompt-defaults', label: '锚定确认词' },
  bootstrapMaxTokens: { kind: 'number', check: NON_NEGATIVE_INTEGER, defaultValue: 0, card: 'tool-bootstrap', label: '首轮输出封顶（0 不封顶）', module: { row: 'tool-bootstrap', mode: 'optional-cap' } },
  usePtcMode: { kind: 'boolean', defaultValue: false, card: 'code-presentation', label: 'PTC 呈现', module: { row: 'code-presentation' } },
  promoteGate: { kind: 'boolean', defaultValue: false, card: 'tool-bootstrap', label: '门控晋升', module: { row: 'tool-bootstrap' } },
  promoteAfterFirstResponse: { kind: 'boolean', defaultValue: false, card: 'tool-bootstrap', label: '首响应即晋升', module: { row: 'tool-bootstrap' } },
  maxPromoteSteps: { kind: 'number', check: NON_NEGATIVE_INTEGER, defaultValue: 0, card: 'tool-bootstrap', label: '门控回退步数（0 默认）', module: { row: 'tool-bootstrap' } },
  bootstrapTools: { kind: 'string-list', defaultValue: '', card: 'tool-bootstrap', label: '首轮窄化集', module: { row: 'tool-bootstrap' } },
  compactionTools: { kind: 'string-list', defaultValue: '', card: 'tool-bootstrap', label: '压缩后恢复集', module: { row: 'tool-bootstrap' } },
  personaSectionsOnly: { kind: 'boolean', defaultValue: false, card: 'tool-bootstrap', label: '首轮只留人设', module: { row: 'tool-bootstrap' } },
  workspaceLine: { kind: 'boolean', defaultValue: false, card: 'tool-bootstrap', label: '工作目录行', module: { row: 'tool-bootstrap' } },
  phase1FirstCallInstruction: { kind: 'string', defaultValue: '', card: 'tool-bootstrap', label: '首次调用指令', module: { row: 'tool-bootstrap' } },
  messageSources: { kind: 'string-list', defaultValue: '', card: 'context-gate', label: '消息来源白名单', module: { row: 'context-gate' } },
  deferredSources: { kind: 'string-list', defaultValue: '', card: 'context-gate', label: '延迟注入来源', module: { row: 'context-gate' } },
  deferredGraceSteps: { kind: 'number', check: NON_NEGATIVE_INTEGER, defaultValue: 0, card: 'context-gate', label: '延迟注入宽限步数', module: { row: 'context-gate' } },
  instructionHint: { kind: 'boolean', defaultValue: false, card: 'context-gate', label: '指令路径提示', module: { row: 'context-gate' } },
  stages: { kind: 'stages', defaultValue: [], card: 'tool-bootstrap', label: '渐进披露阶段', module: { row: 'tool-bootstrap' } },
  stagePreUnlock: { kind: 'number', check: NON_NEGATIVE_INTEGER, defaultValue: 1, card: 'tool-bootstrap', label: '预放档数', module: { row: 'tool-bootstrap' } },
  stageAdvanceTool: { kind: 'string', defaultValue: '', card: 'tool-bootstrap', label: '阶段推进工具名', module: { row: 'tool-bootstrap' } },
  stageAdvanceDescription: { kind: 'string', defaultValue: '', card: 'tool-bootstrap', label: '阶段推进工具描述', module: { row: 'tool-bootstrap' } },
  stageSectionTemplate: { kind: 'string', defaultValue: '', card: 'tool-bootstrap', label: '阶段状态模板', module: { row: 'tool-bootstrap' } },
  toolFilterSubagents: { kind: 'boolean', defaultValue: false, card: 'tool-filter', label: '子代理同过滤', module: { row: 'tool-filter', key: 'includeSubagents' } },
  strReplaceEditorMaxOutputChars: { kind: 'number', check: POSITIVE_INTEGER, defaultValue: 16000, card: 'str-replace-editor', label: '编辑器输出上限', module: { row: 'str-replace-editor', key: 'maxOutputChars', mode: 'editor-default' } },
  anchorTurn: { kind: 'boolean', defaultValue: false, card: 'anchor-turn', label: '前置锚定轮', module: { row: 'anchor-turn', key: 'enabled' } },
  anchorTurnText: { kind: 'string', defaultValue: '', card: 'anchor-turn', label: '锚定轮文本', module: { row: 'anchor-turn', key: 'text' } },
  deliberationGate: { kind: 'boolean', defaultValue: false, card: 'deliberation-gate', label: '轨迹深度门', module: { row: 'deliberation-gate', key: 'enabled' } },
  deliberationMinChars: { kind: 'number', check: NON_NEGATIVE_INTEGER, defaultValue: 0, card: 'deliberation-gate', label: '深思下限（0 默认）', module: { row: 'deliberation-gate', key: 'minChars', mode: 'positive' } },
  deliberationMaxGatesPerTurn: { kind: 'number', check: NON_NEGATIVE_INTEGER, defaultValue: 0, card: 'deliberation-gate', label: '每轮最大门控（0 默认）', module: { row: 'deliberation-gate', key: 'maxGatesPerTurn', mode: 'positive' } },
  cotDrip: { kind: 'boolean', defaultValue: false, card: 'cot-drip', label: '深思维持节拍', module: { row: 'cot-drip', key: 'enabled' } },
  cotDripEvery: { kind: 'number', check: NON_NEGATIVE_INTEGER, defaultValue: 0, card: 'cot-drip', label: '节拍间隔（0 默认；禁用请关闭节拍）', module: { row: 'cot-drip', key: 'every', mode: 'positive' } },
  cotDripMaxPerTurn: { kind: 'number', check: NON_NEGATIVE_INTEGER, defaultValue: 0, card: 'cot-drip', label: '每轮最大提醒（0 默认）', module: { row: 'cot-drip', key: 'maxPerTurn', mode: 'positive' } },
  bootstrapSubagents: { kind: 'boolean', defaultValue: false, card: 'tool-bootstrap', label: '子代理参与工具晋升', module: { row: 'tool-bootstrap', key: 'includeSubagents' } },
  bootstrapPromoteOn: { kind: 'string', options: PROMOTE_ON, defaultValue: '', card: 'tool-bootstrap', label: '工具晋升信号', module: { row: 'tool-bootstrap', key: 'promoteOn' } },
  contextGateEnabled: { kind: 'boolean', defaultValue: true, card: 'context-gate', label: '启用上下文门控', module: { row: 'context-gate', key: 'enabled' } },
  contextGateSubagents: { kind: 'boolean', defaultValue: false, card: 'context-gate', label: '子代理参与上下文门控', module: { row: 'context-gate', key: 'includeSubagents' } },
  contextGatePromoteOn: { kind: 'string', options: PROMOTE_ON, defaultValue: '', card: 'context-gate', label: '上下文晋升信号', module: { row: 'context-gate', key: 'promoteOn' } },
  ptcSubagents: { kind: 'boolean', defaultValue: false, card: 'code-presentation', label: '子代理参与 PTC 晋升', module: { row: 'code-presentation', key: 'includeSubagents' } },
  ptcPromoteOn: { kind: 'string', options: PROMOTE_ON, defaultValue: '', card: 'code-presentation', label: 'PTC 晋升信号', module: { row: 'code-presentation', key: 'promoteOn' } },
  toolFilterEnabled: { kind: 'boolean', defaultValue: true, card: 'tool-filter', label: '启用工具过滤', module: { row: 'tool-filter', key: 'enabled' } },
  anchorTurnSubagents: { kind: 'boolean', defaultValue: false, card: 'anchor-turn', label: '子代理参与锚定轮', module: { row: 'anchor-turn', key: 'includeSubagents' } },
  deliberationSubagents: { kind: 'boolean', defaultValue: false, card: 'deliberation-gate', label: '子代理参与深思门控', module: { row: 'deliberation-gate', key: 'includeSubagents' } },
  deliberationGateText: { kind: 'string', defaultValue: '', card: 'deliberation-gate', label: '深思门控提示文本', module: { row: 'deliberation-gate', key: 'gateText' } },
  cotDripSubagents: { kind: 'boolean', defaultValue: false, card: 'cot-drip', label: '子代理参与深思节拍', module: { row: 'cot-drip', key: 'includeSubagents' } },
  cotDripText: { kind: 'string', defaultValue: '', card: 'cot-drip', label: '深思节拍提示文本', module: { row: 'cot-drip', key: 'text' } },
  customToolRequireApproval: { kind: 'string-list', options: ['shell', 'http', 'delegate', 'fs', 'ask-user'], defaultValue: '', card: 'tool-config-engine', label: '执行前需用户批准的工具种类', module: { row: 'tool-config-engine', key: 'requireApproval' } },
}

export const ENGINE_PARAM_KEYS = Object.keys(ENGINE_PARAM_DEFINITIONS) as EngineParamKey[]

/** writePreset.runtimeOf 实际透传键：全部引擎参数可直接进入兼容 writer。 */
export const WRITER_PARAM_KEYS = ENGINE_PARAM_KEYS

/** 编译期断言：WRITER_PARAM_KEYS 与 PresetWriterParams 键必须一致。 */
const _assertWriterParamsKeys: AssertKeysEqual<typeof WRITER_PARAM_KEYS[number], keyof PresetWriterParams> = true

/** 已有逗号分隔/flow-array 语义，client 与生成器共享。 */
export function engineParamList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter((item) => item.length > 0)
  if (typeof value !== 'string') return []
  const text = value.trim()
  const inner = text.startsWith('[') && text.endsWith(']') ? text.slice(1, -1) : text
  return inner.split(',').map((item) => item.trim()).filter(Boolean)
}

/** 仅生成声明字段的行配置；复杂的子代理授权仍由 host 所有者处理。 */
export function buildEngineModuleParams(params: Record<string, unknown>): Record<string, Record<string, unknown>> {
  const result: Record<string, Record<string, unknown>> = {}
  for (const key of ENGINE_PARAM_KEYS) {
    const definition = ENGINE_PARAM_DEFINITIONS[key]
    const binding = definition.module
    if (binding === undefined) continue
    let value = params[key]
    if (binding.mode === 'editor-default') {
      if (typeof value === 'string' && value.trim().length > 0) value = Number(value)
      value = typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : definition.defaultValue
    }
    if (value === undefined || value === null) continue
    if (definition.kind === 'boolean') value = value === true
    else if (definition.kind === 'string-list') value = engineParamList(value)
    else if (definition.kind === 'string' && (typeof value !== 'string' || value.length === 0)) continue
    else if (definition.kind === 'number') {
      if (typeof value === 'string' && value.trim().length > 0) value = Number(value)
      if (typeof value !== 'number' || definition.check(value) !== undefined) continue
    }
    if (binding.mode === 'positive' && typeof value === 'number' && value <= 0) continue
    if (binding.mode === 'nonempty-list' && Array.isArray(value) && value.length === 0) continue
    // undefined 是内部删键指令：显式 0 必须清除组合自带封顶，而不是回填旧值。
    if (binding.mode === 'optional-cap' && value === 0) value = undefined
    const config = result[binding.row] ??= {}
    config[binding.key ?? key] = value
  }
  return result
}

/** 仅投影已登记字段，绝不把任意行配置/路径/凭据泄露给浏览器。 */
export function moduleParamFallbacks(configs: Record<string, Record<string, unknown>>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const key of ENGINE_PARAM_KEYS) {
    const binding = ENGINE_PARAM_DEFINITIONS[key].module
    if (binding === undefined) continue
    const value = configs[binding.row]?.[binding.key ?? key]
    if (value !== undefined) result[key] = value
  }
  return result
}

/** 校验单个键值；返回错误消息（undefined = 通过）。 */
function validateParamValue(key: string, rule: ParamRule, value: unknown): string | undefined {
  if (value === '') return undefined
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
      if (typeof value !== 'string') return `${key}: 必须是字符串`
      return value === '' || rule.options === undefined || rule.options.includes(value)
        ? undefined : `${key}: 必须为 ${rule.options.join('/')} 或留空`
    case 'string-list':
      if (typeof value === 'string' || (Array.isArray(value) && value.every((item) => typeof item === 'string'))) {
        return rule.options !== undefined && engineParamList(value).some((item) => !rule.options!.includes(item))
          ? `${key}: 只允许 ${rule.options.join('/')}` : undefined
      }
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
    const rule = Object.hasOwn(ENGINE_PARAM_DEFINITIONS, key) ? ENGINE_PARAM_DEFINITIONS[key as EngineParamKey] : undefined
    if (rule === undefined) {
      errors.push({ key, message: `${key}: 未知参数键（旧键已移除运行时兼容，请用迁移脚本清理）` })
      continue
    }
    const message = validateParamValue(key, rule, value)
    if (message !== undefined) errors.push({ key, message })
  }
  return errors
}
