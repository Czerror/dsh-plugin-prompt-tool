/** settings/bootstrap 载荷到客户端 Fields 的纯映射。 */
import type { PromptConfigDraft } from '../prompt-tool-types.ts'
import type { BridgeResult, BridgeSettingsView } from './bridge-transport.ts'
import type { Fields, SkillCatalogEntry } from './prompt-tool-fields.ts'
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
      for (const entry of [base, value, res.ok ? { skillsDirExists: res.skillsDirExists } : {}]) {
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
/** /bootstrap 已携带 descriptor；归一成 fieldsFromView 使用的结果形状。 */
export function bridgeViewFromBoot(boot: BridgeResult<BridgeSettingsView>): BridgeResult<BridgeSettingsView> {
  if (!boot.ok) return boot
  return {
    ok: true,
    value: {
      ns: 'prompt-tool',
      value: boot.value.value,
      base: boot.value.base,
      revision: boot.value.revision,
    },
    providers: boot.providers,
    modelCatalog: boot.modelCatalog,
    activeSkillsDirs: boot.activeSkillsDirs,
    skillsDirExists: boot.skillsDirExists,
    skillCatalog: boot.skillCatalog,
    templatePreStepCount: boot.templatePreStepCount,
    presetParams: boot.presetParams,
    hostDefaultModel: boot.hostDefaultModel,
  }
}

/** 合并 preset.yml params；只接受与既有字段类型一致的值。 */
export function mergePresetParams(fields: Fields, params: Record<string, unknown> | undefined): Fields {
  if (params === undefined) return fields
  const next = { ...fields }
  const target = next as unknown as Record<string, unknown>
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || key === 'promptConfigs') continue
    const current = target[key]
    if (current === undefined) continue
    if (key === 'guideEnabled' && typeof value === 'boolean') target[key] = value
    else if (typeof current === typeof value && ['boolean', 'number', 'string'].includes(typeof current)) target[key] = value
  }
  return next
}
