/** settings bridge 客户端传输与载荷解析层（无 react 依赖；UI 状态见 prompt-tool-store）。 */
import type { PromptConfigDraft, EngineMeta } from './prompt-tool-types.ts'
import type { EngineParamKey } from '../shared/engine-params.ts'
import { MAX_BRIDGE_BODY_BYTES, SETTINGS_BRIDGE_PREFIX, type BridgeErrorPayload } from '../shared/bridge-contract.ts'

export interface BridgeSettingsView { ns: string; value: unknown; base?: unknown; revision: number }
export type BridgeResult<T> = { ok: true; value: T; providers?: string[]; modelCatalog?: Record<string, string[]>; activeSkillsDirs?: string[]; skillCatalog?: SkillCatalogEntry[]; templatePreStepCount?: number; presetParams?: Record<string, unknown>; hostDefaultModel?: { provider?: string; model?: string; reasoningEffort?: string }; meta?: { meta: EngineMeta }; overrides?: { overrides: Record<string, unknown> }; variables?: { variables: Record<string, string>; enabled: boolean }; promptConfigs?: { promptConfigs: PromptConfigDraft[] } } | BridgeErrorPayload

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

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

const readString = (source: Record<string, unknown>, key: string): string | undefined => {
  const value = source[key]
  return typeof value === 'string' ? value : undefined
}

const readStringArray = (source: Record<string, unknown>, key: string): string[] => {
  const value = source[key]
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}

const readBoolean = (source: Record<string, unknown>, key: string, fallback: boolean): boolean => {
  const value = source[key]
  return typeof value === 'boolean' ? value : fallback
}

const readNumber = (source: Record<string, unknown>, key: string, fallback: number): number => {
  const value = source[key]
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : fallback
}

const readSkillSwitches = (source: Record<string, unknown>, key: string): Record<string, boolean> => {
  const value = source[key]
  if (value === null || typeof value !== 'object') return {}
  const entries = Object.entries(value as Record<string, unknown>)
  const result: Record<string, boolean> = {}
  for (const [name, enabled] of entries) {
    if (typeof enabled === 'boolean') result[name] = enabled
  }
  return result
}

const readSkillCatalog = (source: Record<string, unknown>, key: string): SkillCatalogEntry[] => {
  const value = source[key]
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (entry === null || typeof entry !== 'object') return []
    const record = entry as Record<string, unknown>
    const folder = readString(record, 'folder')
    const name = readString(record, 'name')
    if (folder === undefined || name === undefined) return []
    return [{
      folder,
      name,
      description: readString(record, 'description') ?? '',
      // 向后兼容旧宿主：旧版 /describe 只返回 folder/name/description（且旧扫描
      // 已过滤非法名），缺字段按旧语义默认 true；新版宿主显式携带 valid=false。
      valid: readBoolean(record, 'valid', true),
      ...(typeof record.dir === 'string' && record.dir.length > 0 ? { dir: record.dir } : {}),
      ...(record.duplicate === true ? { duplicate: true } : {}),
      ...(typeof record.issue === 'string' && record.issue.length > 0 ? { issue: record.issue } : {}),
      modelInvocable: readBoolean(record, 'modelInvocable', true),
      userInvocable: readBoolean(record, 'userInvocable', true),
    }]
  })
}

const readPromptConfigs = (source: Record<string, unknown>, key: string): PromptConfigDraft[] => {
  const value = source[key]
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (entry === null || typeof entry !== 'object') return []
    const record = entry as Record<string, unknown>
    return typeof record.id === 'string' && record.id.length > 0 ? [entry as PromptConfigDraft] : []
  })
}

export const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error)

const isBridgeResultPayload = (payload: unknown): payload is BridgeResult<unknown> => {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return false
  const record = payload as Record<string, unknown>
  if (typeof record.ok !== 'boolean') return false
  return !record.ok || 'value' in record
}

async function readBridgeResponse<T>(response: Response): Promise<BridgeResult<T>> {
  const payload = await response.json() as unknown
  if (isBridgeResultPayload(payload)) return payload as BridgeResult<T>
  return { ok: false, message: `invalid settings bridge payload (HTTP ${response.status})` }
}

export async function bridgePost<T>(path: string, body: unknown): Promise<BridgeResult<T>> {
  try {
    const response = await fetch(SETTINGS_BRIDGE_PREFIX + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return await readBridgeResponse<T>(response)
  } catch (error) {
    return { ok: false, message: errorMessage(error) }
  }
}

/** 原始文件流上传；用于避开 JSON/base64 的额外膨胀。 */
export async function bridgeUpload<T>(path: string, file: Blob, fileName: string): Promise<BridgeResult<T>> {
  try {
    const response = await fetch(SETTINGS_BRIDGE_PREFIX + path, {
      method: 'POST',
      headers: {
        'content-type': file.type || 'application/octet-stream',
        'x-file-name': encodeURIComponent(fileName),
      },
      body: file,
    })
    return await readBridgeResponse<T>(response)
  } catch (error) {
    return { ok: false, message: errorMessage(error) }
  }
}

/** JSON 包装字段和少量路径元数据预留 4KiB，避免临界文件刚好超限。 */
export function shouldStreamJsonFile(file: Blob): boolean {
  return file.size >= MAX_BRIDGE_BODY_BYTES - 4 * 1024
}

export function fieldsFromView(res: BridgeResult<BridgeSettingsView>): Fields {
  const ns = res.ok ? res.value : undefined
  const value = asRecord(ns?.value)
  const base = asRecord(ns?.base)
  const next: Fields = {
    promptText: readString(value, 'promptText') ?? readString(base, 'promptText') ?? '',
    promptPath: readString(value, 'promptPath') ?? readString(base, 'promptPath') ?? '',
    agentsText: readString(value, 'agentsText') ?? readString(base, 'agentsText') ?? '',
    agentsPath: readString(value, 'agentsPath') ?? readString(base, 'agentsPath') ?? '',
    injectAgentsPrompt: readBoolean(value, 'injectAgentsPrompt', readBoolean(base, 'injectAgentsPrompt', false)),
    firstTurnAnchor: readBoolean(value, 'firstTurnAnchor', readBoolean(base, 'firstTurnAnchor', false)),
    firstTurnText: readString(value, 'firstTurnText') ?? readString(base, 'firstTurnText') ?? '',
    firstTurnCustom: readBoolean(value, 'firstTurnCustom', readBoolean(base, 'firstTurnCustom', false)),
    guideText: readString(value, 'guideText') ?? readString(base, 'guideText') ?? '',
    guideCustom: readBoolean(value, 'guideCustom', readBoolean(base, 'guideCustom', false)),
    guideEnabled: typeof value.guideEnabled === 'boolean' ? value.guideEnabled
      : typeof base.guideEnabled === 'boolean' ? base.guideEnabled
      : undefined,
    modelProvider: readString(value, 'modelProvider') ?? readString(base, 'modelProvider') ?? '',
    modelName: readString(value, 'modelName') ?? readString(base, 'modelName') ?? '',
    subagentModelProvider: readString(value, 'subagentModelProvider') ?? readString(base, 'subagentModelProvider') ?? '',
    subagentModelName: readString(value, 'subagentModelName') ?? readString(base, 'subagentModelName') ?? '',
    modelReasoningEffort: readString(value, 'modelReasoningEffort') ?? readString(base, 'modelReasoningEffort') ?? '',
    modelTemperature: readString(value, 'modelTemperature') ?? readString(base, 'modelTemperature') ?? '',
    modelMaxTokens: readString(value, 'modelMaxTokens') ?? readString(base, 'modelMaxTokens') ?? '',
    subagentReasoningEffort: readString(value, 'subagentReasoningEffort') ?? readString(base, 'subagentReasoningEffort') ?? '',
    subagentTemperature: readString(value, 'subagentTemperature') ?? readString(base, 'subagentTemperature') ?? '',
    subagentMaxTokens: readString(value, 'subagentMaxTokens') ?? readString(base, 'subagentMaxTokens') ?? '',
    // 预设级参数（toolFilterAllow/toolFilterDeny/maxDepth/allowKinds/firstTurnWord）
    // 不进 settings namespace：默认空，由 /param-overrides 读回后填充（store.load paramPatch）。
    toolFilterAllow: '',
    toolFilterDeny: '',
    toolFilterSubagents: false,
    maxDepth: '',
    allowKinds: '',
    firstTurnWord: '',
    bootstrapMaxTokens: readNumber(value, 'bootstrapMaxTokens', readNumber(base, 'bootstrapMaxTokens', 0)),
    usePtcMode: readBoolean(value, 'usePtcMode', readBoolean(base, 'usePtcMode', false)),
    // 渐进披露（stages 模式）：预设级参数，由 /param-overrides 读回后填充。
    stages: [],
    stagePreUnlock: 1,
    stageAdvanceTool: '',
    stageAdvanceDescription: '',
    stageSectionTemplate: '',
    // 晋升门控（tool-bootstrap 参数桥）：预设级参数，由 /param-overrides + presetParams 填充。
    promoteGate: false,
    promoteAfterFirstResponse: false,
    maxPromoteSteps: 0,
    bootstrapTools: '',
    compactionTools: '',
    personaSectionsOnly: false,
    workspaceLine: false,
    phase1FirstCallInstruction: '',
    instructionHint: false,
    // context-gate 注入门控（预设级参数，由 /param-overrides 填充）。
    messageSources: '',
    deferredSources: '',
    deferredGraceSteps: 0,
    // 锚定/深思可选模块（anchor-turn / deliberation-gate / cot-drip 参数桥）。
    anchorTurn: readBoolean(value, 'anchorTurn', readBoolean(base, 'anchorTurn', false)),
    anchorTurnText: readString(value, 'anchorTurnText') ?? readString(base, 'anchorTurnText') ?? '',
    deliberationGate: readBoolean(value, 'deliberationGate', readBoolean(base, 'deliberationGate', false)),
    deliberationMinChars: readNumber(value, 'deliberationMinChars', readNumber(base, 'deliberationMinChars', 0)),
    deliberationMaxGatesPerTurn: readNumber(value, 'deliberationMaxGatesPerTurn', readNumber(base, 'deliberationMaxGatesPerTurn', 0)),
    cotDrip: readBoolean(value, 'cotDrip', readBoolean(base, 'cotDrip', false)),
    cotDripEvery: readNumber(value, 'cotDripEvery', readNumber(base, 'cotDripEvery', 0)),
    cotDripMaxPerTurn: readNumber(value, 'cotDripMaxPerTurn', readNumber(base, 'cotDripMaxPerTurn', 0)),
    strReplaceEditorMaxOutputChars: readNumber(value, 'strReplaceEditorMaxOutputChars',
      readNumber(base, 'strReplaceEditorMaxOutputChars', 16000)),
    injectPrompt: readBoolean(value, 'injectPrompt', readBoolean(base, 'injectPrompt', true)),
    skillSwitches: value.skillSwitches !== undefined || base.skillSwitches !== undefined
      ? { ...readSkillSwitches(base, 'skillSwitches'), ...readSkillSwitches(value, 'skillSwitches') }
      : {},
    skillOrder: readStringArray(value, 'skillOrder').length > 0
      ? readStringArray(value, 'skillOrder')
      : readStringArray(base, 'skillOrder'),
    skillCatalog: res.ok && res.skillCatalog !== undefined && res.skillCatalog.length > 0
      ? res.skillCatalog
      : readSkillCatalog(value, 'skillCatalog').length > 0
        ? readSkillCatalog(value, 'skillCatalog')
        : readSkillCatalog(base, 'skillCatalog'),
    skillsDirs: readStringArray(value, 'skillsDirs').length > 0
      ? readStringArray(value, 'skillsDirs')
      : readStringArray(base, 'skillsDirs'),
    activeSkillsDirs: readStringArray(value, 'activeSkillsDirs').length > 0
      ? readStringArray(value, 'activeSkillsDirs')
      : readStringArray(base, 'activeSkillsDirs'),
    skillsDirExists: (() => {
      const merged: Record<string, boolean> = {}
      for (const entry of [value, base]) {
        const record = entry
        const exists = record.skillsDirExists
        if (exists !== null && typeof exists === 'object' && !Array.isArray(exists)) {
          Object.assign(merged, exists as Record<string, unknown>)
        }
      }
      const result: Record<string, boolean> = {}
      for (const [path, ok] of Object.entries(merged)) {
        if (typeof ok === 'boolean') result[path] = ok
      }
      return result
    })(),
    skillRankBase: readNumber(value, 'skillRankBase', readNumber(base, 'skillRankBase', 250)),
    residentAgentsPath: readString(value, 'residentAgentsPath') ?? readString(base, 'residentAgentsPath') ?? '',
    presetDir: readString(value, 'presetDir') ?? readString(base, 'presetDir') ?? '',
    presetOrder: readNumber(value, 'presetOrder', readNumber(base, 'presetOrder', 5)),
    fallbackText: readString(value, 'fallbackText') ?? readString(base, 'fallbackText') ?? '',
    writeAgents: readBoolean(value, 'writeAgents', readBoolean(base, 'writeAgents', true)),
    writePreset: readBoolean(value, 'writePreset', readBoolean(base, 'writePreset', true)),
    presetTemplate: readString(value, 'presetTemplate') ?? readString(base, 'presetTemplate') ?? 'anchored',
    promptConfigs: value.promptConfigs !== undefined
      ? readPromptConfigs(value, 'promptConfigs')
      : readPromptConfigs(base, 'promptConfigs'),
  }
  return next
}

/** 编译期契约：所有引擎参数键都必须进入 Fields，防止 host 契约新增键后 client 静默丢弃。 */
type MissingEngineParamKeys = Exclude<EngineParamKey, keyof Fields>
const _assertEngineParamsInFields: MissingEngineParamKeys[] = []
