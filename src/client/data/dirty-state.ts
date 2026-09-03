/** 客户端脏检测、保存快照与保存后重载判定（纯逻辑）。 */
import type { PromptConfigDraft } from '../prompt-tool-types.ts'
import { hasIncompleteStageDrafts, type Fields, type StageDraft } from './prompt-tool-fields.ts'
export interface SwitchSnapshot {
  injectAgentsPrompt: boolean
  firstTurnAnchor: boolean
  firstTurnText: string
  firstTurnCustom: boolean
  guideText: string
  guideCustom: boolean
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
  bootstrapMaxTokens: number
  usePtcMode: boolean
  stages: StageDraft[]
  stagePreUnlock: number
  stageAdvanceTool: string
  stageAdvanceDescription: string
  stageSectionTemplate: string
  promoteGate: boolean
  promoteAfterFirstResponse: boolean
  maxPromoteSteps: number
  bootstrapTools: string
  compactionTools: string
  personaSectionsOnly: boolean
  workspaceLine: boolean
  phase1FirstCallInstruction: string
  instructionHint: boolean
  messageSources: string
  deferredSources: string
  deferredGraceSteps: number
  anchorTurn: boolean
  anchorTurnText: string
  deliberationGate: boolean
  deliberationMinChars: number
  deliberationMaxGatesPerTurn: number
  cotDrip: boolean
  cotDripEvery: number
  cotDripMaxPerTurn: number
  strReplaceEditorMaxOutputChars: number
  injectPrompt: boolean
  skillSwitches: Record<string, boolean>
  skillOrder: string[]
  skillsDirs: string[]
  skillRankBase: number
  residentAgentsPath: string
  presetDir: string
  presetOrder: number
  fallbackText: string
  writeAgents: boolean
  writePreset: boolean
}

export const EMPTY_SWITCHES: SwitchSnapshot = {
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
  skillsDirs: [],
  skillRankBase: 250,
  residentAgentsPath: '',
  presetDir: '',
  presetOrder: 5,
  fallbackText: '',
  writeAgents: true,
  writePreset: true,
}

/**
 * promptConfigs 脏检测：引用比较为主，但两个空数组内容相同必须判「不脏」。
 * store 初始化时 fields=EMPTY_FIELDS.promptConfigs（模块级常量 []）而
 * savedConfigs 是 useState([]) 新字面量，引用不同——纯引用比较会误判脏，
 * 挂载 800ms 后把空数组自动保存进 preset.yml，清空大预设的全部配置卡。
 */
export const promptConfigsDirty = (current: PromptConfigDraft[], saved: PromptConfigDraft[]): boolean =>
  current !== saved && !(current.length === 0 && saved.length === 0)

export const snapshotSwitches = (fields: Fields): SwitchSnapshot => ({
  injectAgentsPrompt: fields.injectAgentsPrompt,
  firstTurnAnchor: fields.firstTurnAnchor,
  firstTurnText: fields.firstTurnText,
  firstTurnCustom: fields.firstTurnCustom,
  guideText: fields.guideText,
  guideCustom: fields.guideCustom,
  guideEnabled: fields.guideEnabled,
  modelProvider: fields.modelProvider,
  modelName: fields.modelName,
  subagentModelProvider: fields.subagentModelProvider,
  subagentModelName: fields.subagentModelName,
  modelReasoningEffort: fields.modelReasoningEffort,
  modelTemperature: fields.modelTemperature,
  modelMaxTokens: fields.modelMaxTokens,
  subagentReasoningEffort: fields.subagentReasoningEffort,
  subagentTemperature: fields.subagentTemperature,
  subagentMaxTokens: fields.subagentMaxTokens,
  bootstrapMaxTokens: fields.bootstrapMaxTokens,
  usePtcMode: fields.usePtcMode,
  stages: fields.stages.map((stage) => ({ ...stage })),
  stagePreUnlock: fields.stagePreUnlock,
  stageAdvanceTool: fields.stageAdvanceTool,
  stageAdvanceDescription: fields.stageAdvanceDescription,
  stageSectionTemplate: fields.stageSectionTemplate,
  promoteGate: fields.promoteGate,
  promoteAfterFirstResponse: fields.promoteAfterFirstResponse,
  maxPromoteSteps: fields.maxPromoteSteps,
  bootstrapTools: fields.bootstrapTools,
  compactionTools: fields.compactionTools,
  personaSectionsOnly: fields.personaSectionsOnly,
  workspaceLine: fields.workspaceLine,
  phase1FirstCallInstruction: fields.phase1FirstCallInstruction,
  instructionHint: fields.instructionHint,
  messageSources: fields.messageSources,
  deferredSources: fields.deferredSources,
  deferredGraceSteps: fields.deferredGraceSteps,
  anchorTurn: fields.anchorTurn,
  anchorTurnText: fields.anchorTurnText,
  deliberationGate: fields.deliberationGate,
  deliberationMinChars: fields.deliberationMinChars,
  deliberationMaxGatesPerTurn: fields.deliberationMaxGatesPerTurn,
  cotDrip: fields.cotDrip,
  cotDripEvery: fields.cotDripEvery,
  cotDripMaxPerTurn: fields.cotDripMaxPerTurn,
  strReplaceEditorMaxOutputChars: fields.strReplaceEditorMaxOutputChars,
  injectPrompt: fields.injectPrompt,
  skillSwitches: { ...fields.skillSwitches },
  skillOrder: [...fields.skillOrder],
  skillsDirs: [...fields.skillsDirs],
  skillRankBase: fields.skillRankBase,
  residentAgentsPath: fields.residentAgentsPath,
  presetDir: fields.presetDir,
  presetOrder: fields.presetOrder,
  fallbackText: fields.fallbackText,
  writeAgents: fields.writeAgents,
  writePreset: fields.writePreset,
})

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** 深比较 snapshot 内的数组/record；不使用 JSON.stringify，避免键顺序影响脏检测。 */
export const deepEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, index) => deepEqual(item, b[index]))
  }
  if (isPlainRecord(a) || isPlainRecord(b)) {
    if (!isPlainRecord(a) || !isPlainRecord(b)) return false
    const keys = new Set([...Object.keys(a), ...Object.keys(b)])
    for (const key of keys) {
      if (!deepEqual(a[key], b[key])) return false
    }
    return true
  }
  return false
}

/** 全字段结构化比较：SwitchSnapshot 声明的每个键都参与，防止新增参数漏比较。 */
export const switchesEqual = (a: SwitchSnapshot, b: SwitchSnapshot): boolean => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const key of keys) {
    if (!deepEqual(a[key as keyof SwitchSnapshot], b[key as keyof SwitchSnapshot])) return false
  }
  return true
}

/** 参数保存后仅在草稿未继续变化且没有未完成阶段时重载。 */
export const shouldReloadAfterParamSave = (current: SwitchSnapshot, saved: SwitchSnapshot): boolean =>
  switchesEqual(current, saved) && !hasIncompleteStageDrafts(saved.stages)
