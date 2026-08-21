/** settings bridge 客户端传输与载荷解析层（无 react 依赖；UI 状态见 prompt-tool-store）。 */
import type { PromptConfigDraft, EngineMeta } from './prompt-tool-types.ts'
import { SETTINGS_BRIDGE_PREFIX, type BridgeErrorPayload } from '../shared/bridge-contract.ts'

export interface BridgeSettingsView { ns: string; value: unknown; base?: unknown; revision: number }
export type BridgeResult<T> = { ok: true; value: T; providers?: string[]; modelCatalog?: Record<string, string[]>; activeSkillsDirs?: string[]; skillCatalog?: SkillCatalogEntry[]; templatePreStepCount?: number; presetParams?: Record<string, unknown> } | BridgeErrorPayload

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
  mainPersona: string
  subagentPersona: string
  toolFilterAllow: string
  toolFilterDeny: string
  maxDepth: string
  allowKinds: string
  firstTurnWord: string
  bootstrapMaxTokens: number
  usePtcMode: boolean
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
  mainPersona: '',
  subagentPersona: '',
  toolFilterAllow: '',
  toolFilterDeny: '',
  maxDepth: '',
  allowKinds: '',
  firstTurnWord: '',
  bootstrapMaxTokens: 0,
  usePtcMode: true,
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

export async function bridgePost<T>(path: string, body: unknown): Promise<BridgeResult<T>> {
  try {
    const response = await fetch(SETTINGS_BRIDGE_PREFIX + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const payload = await response.json() as unknown
    if (payload !== null && typeof payload === 'object') return payload as BridgeResult<T>
    return { ok: false, message: 'settings bridge unavailable' }
  } catch (error) {
    return { ok: false, message: errorMessage(error) }
  }
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
    // 预设级参数（mainPersona/subagentPersona/toolFilterAllow/toolFilterDeny/maxDepth/allowKinds/firstTurnWord）
    // 不进 settings namespace：默认空，由 /param-overrides 读回后填充（store.load paramPatch）。
    mainPersona: '',
    subagentPersona: '',
    toolFilterAllow: '',
    toolFilterDeny: '',
    maxDepth: '',
    allowKinds: '',
    firstTurnWord: '',
    bootstrapMaxTokens: readNumber(value, 'bootstrapMaxTokens', readNumber(base, 'bootstrapMaxTokens', 0)),
    usePtcMode: readBoolean(value, 'usePtcMode', readBoolean(base, 'usePtcMode', true)),
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
