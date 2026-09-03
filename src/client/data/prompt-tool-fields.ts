/** 提示词工具客户端状态模型与稳定默认值（无网络、无 React）。 */
import type { EngineParamKey } from '../../shared/engine-params.ts'
import type { EngineMeta, PromptConfigDraft } from '../prompt-tool-types.ts'

/** 本项目默认不设上限时的显示值（adapter 默认 maxTokens）。 */
export const DEFAULT_BOOTSTRAP_DISPLAY = '256000'

/** 宿主默认模型回显（agent-default-model settings：provider/model/reasoningEffort；插件参数未设置 = 继承宿主）。 */
export interface HostDefaultModel {
  provider?: string
  model?: string
  reasoningEffort?: string
}

export interface SkillCatalogEntry {
  folder: string
  name: string
  description: string
  valid: boolean
  /** 来源技能目录绝对路径。 */
  dir?: string
  /** 同名标记：多目录存在相同 folder 时 UI 标注。 */
  duplicate?: boolean
  issue?: string
  modelInvocable: boolean
  userInvocable: boolean
}

export interface Fields {
  promptText: string
  promptPath: string
  agentsText: string
  agentsPath: string
  injectAgentsPrompt: boolean
  firstTurnAnchor: boolean
  firstTurnText: string
  firstTurnCustom: boolean
  guideText: string
  guideCustom: boolean
  /** 每轮引导独立开关；undefined = 跟随 firstTurnAnchor。 */
  guideEnabled: boolean | undefined
  modelProvider: string
  modelName: string
  subagentModelProvider: string
  subagentModelName: string
  modelReasoningEffort: string
  modelTemperature: string
  modelMaxTokens: string
  subagentReasoningEffort: string
  subagentTemperature: string
  subagentMaxTokens: string
  toolFilterAllow: string
  toolFilterDeny: string
  /** 子代理也启用主对话工具过滤。 */
  toolFilterSubagents: boolean
  maxDepth: string
  allowKinds: string
  firstTurnWord: string
  bootstrapMaxTokens: number
  usePtcMode: boolean
  /** 门控晋升：首段 reasoning minimal-like + 工具调用才晋升（tool-bootstrap 参数桥）。 */
  promoteGate: boolean
  /** 无工具首响应 / 首轮 turn/end 即晋升。 */
  promoteAfterFirstResponse: boolean
  /** 门控回退步数上限（0 = 引擎默认 4）。 */
  maxPromoteSteps: number
  /** 首轮工具窄化集（逗号分隔；覆盖行默认）。 */
  bootstrapTools: string
  /** 压缩后恢复工具集（逗号分隔）。 */
  compactionTools: string
  /** 渐进披露阶段定义（UI 草稿形态：tools 逗号分隔字符串；非空 = 激活多级阶段窄化）。 */
  stages: StageDraft[]
  /** 预放档数（0 = 引擎默认 1）。 */
  stagePreUnlock: number
  /** 阶段推进工具名（空 = 默认 phase_advance）。 */
  stageAdvanceTool: string
  /** 阶段推进工具描述。 */
  stageAdvanceDescription: string
  /** 阶段状态 section 模板（{{stage}}/{{stageName}}/{{unlocked}}/{{total}}；空 = 不注入）。 */
  stageSectionTemplate: string
  /** phase-1 提示词段只留 persona。 */
  personaSectionsOnly: boolean
  /** 晋升后 persona 附加工作目录行。 */
  workspaceLine: boolean
  /** phase-1 persona 追加的首次调用指令行。 */
  phase1FirstCallInstruction: string
  /** 晋升后 agent-instructions 全文 → 一次性 hint（context-gate）。 */
  instructionHint: boolean
  /** context-gate phase-1 消息源白名单（逗号分隔；空 = 不启用）。 */
  messageSources: string
  /** 晋升后延迟注入的 source kind（逗号分隔）。 */
  deferredSources: string
  /** 延迟注入宽限步数（0 = 不延迟）。 */
  deferredGraceSteps: number
  /** 前置锚定轮（anchor-turn 行；需模块列表已挂行）。 */
  anchorTurn: boolean
  /** 前置锚定轮自定义锚定文本（空 = 引擎默认）。 */
  anchorTurnText: string
  /** 轨迹深度门（deliberation-gate 行；需模块列表已挂行）。 */
  deliberationGate: boolean
  /** 深思下限字符数（0 = 回落行默认 400）。 */
  deliberationMinChars: number
  /** 每轮最大门控次数（0 = 回落行默认 1）。 */
  deliberationMaxGatesPerTurn: number
  /** 深思维持节拍（cot-drip 行；需模块列表已挂行）。 */
  cotDrip: boolean
  /** 节拍间隔工具结果数（0 = 回落行默认 4）。 */
  cotDripEvery: number
  /** 每轮最大提醒条数（0 = 回落行默认 1）。 */
  cotDripMaxPerTurn: number
  /** str-replace-editor 最大输出字符数；16000 = 官方默认。 */
  strReplaceEditorMaxOutputChars: number
  injectPrompt: boolean
  skillSwitches: Record<string, boolean>
  skillOrder: string[]
  skillCatalog: SkillCatalogEntry[]
  /** 用户技能目录列表（按添加顺序）；空 = 默认副本。 */
  skillsDirs: string[]
  /** 实际生效目录列表（空配置 = [默认副本路径]）。 */
  activeSkillsDirs: string[]
  /** 生效目录存在性（path → 是否存在）。 */
  skillsDirExists: Record<string, boolean>
  skillRankBase: number
  residentAgentsPath: string
  presetDir: string
  presetOrder: number
  fallbackText: string
  writeAgents: boolean
  writePreset: boolean
  presetTemplate: string
  promptConfigs: PromptConfigDraft[]
}

/** 渐进披露阶段草稿（UI 编辑形态；persist 时转引擎形态 [{name, tools: string[]}]）。 */
export interface StageDraft {
  name: string
  tools: string
}

/** 是否存在未填完的阶段草稿；保存后不能立即重载，否则空行会被服务端过滤并从 UI 消失。 */
export const hasIncompleteStageDrafts = (stages: StageDraft[]): boolean =>
  stages.some((stage) => stage.name.trim().length === 0 || stage.tools.trim().length === 0)

export const EMPTY_META: EngineMeta = {
  layers: [],
  strategies: [],
  slotKinds: [],
  positions: [],
  dedupes: [],
  promotions: [],
  audienceModes: [],
  modelScopes: [],
  roles: [],
  mergeModes: [],
  fills: [],
  layerFieldPolicies: {},
  layerLabels: {},
}
export const EMPTY_FIELDS: Fields = {
  promptText: '',
  promptPath: '',
  agentsText: '',
  agentsPath: '',
  injectAgentsPrompt: false,
  firstTurnAnchor: false,
  firstTurnText: '',
  firstTurnCustom: false,
  guideText: '',
  guideCustom: false,
  guideEnabled: undefined,
  modelProvider: '',
  modelName: '',
  subagentModelProvider: '',
  subagentModelName: '',
  modelReasoningEffort: '',
  modelTemperature: '',
  modelMaxTokens: '',
  subagentReasoningEffort: '',
  subagentTemperature: '',
  subagentMaxTokens: '',
  toolFilterAllow: '',
  toolFilterDeny: '',
  toolFilterSubagents: false,
  maxDepth: '',
  allowKinds: '',
  firstTurnWord: '',
  bootstrapMaxTokens: 0,
  usePtcMode: false,
  stages: [],
  stagePreUnlock: 1,
  stageAdvanceTool: '',
  stageAdvanceDescription: '',
  stageSectionTemplate: '',
  promoteGate: false,
  promoteAfterFirstResponse: false,
  maxPromoteSteps: 0,
  bootstrapTools: '',
  compactionTools: '',
  personaSectionsOnly: false,
  workspaceLine: false,
  phase1FirstCallInstruction: '',
  instructionHint: false,
  messageSources: '',
  deferredSources: '',
  deferredGraceSteps: 0,
  anchorTurn: false,
  anchorTurnText: '',
  deliberationGate: false,
  deliberationMinChars: 0,
  deliberationMaxGatesPerTurn: 0,
  cotDrip: false,
  cotDripEvery: 0,
  cotDripMaxPerTurn: 0,
  strReplaceEditorMaxOutputChars: 16000,
  injectPrompt: true,
  skillSwitches: {},
  skillOrder: [],
  skillCatalog: [],
  skillsDirs: [],
  activeSkillsDirs: [],
  skillsDirExists: {},
  skillRankBase: 250,
  residentAgentsPath: '',
  presetDir: '',
  presetOrder: 5,
  fallbackText: '',
  writeAgents: true,
  writePreset: true,
  presetTemplate: 'anchored',
  promptConfigs: [],
}
/** 编译期契约：所有引擎参数键都必须进入 Fields，防止 host 新增参数后 client 静默丢弃。 */
type MissingEngineParamKeys = Exclude<EngineParamKey, keyof Fields>
const _assertEngineParamsInFields: MissingEngineParamKeys[] = []
