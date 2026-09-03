/** preset.yml params 与客户端字段之间的纯转换。 */
import type { Fields } from './prompt-tool-fields.ts'
import { deepEqual } from './dirty-state.ts'

const joinList = (value: unknown): string | undefined =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').join(', ')
    : typeof value === 'string' ? value : undefined

/** 引擎 params 读回为 UI 草稿字段。 */
export function readParamOverridesPatch(source: Record<string, unknown>): Partial<Fields> {
  const patch: Partial<Fields> = {}
  const stringKeys = [
    'firstTurnText', 'guideText', 'modelProvider', 'modelName', 'subagentModelProvider', 'subagentModelName',
    'modelReasoningEffort', 'modelTemperature', 'modelMaxTokens', 'subagentReasoningEffort',
    'subagentTemperature', 'subagentMaxTokens', 'firstTurnWord', 'stageAdvanceTool',
    'stageAdvanceDescription', 'stageSectionTemplate', 'phase1FirstCallInstruction', 'anchorTurnText',
  ] as const
  const booleanKeys = [
    'firstTurnAnchor', 'firstTurnCustom', 'guideCustom', 'guideEnabled', 'usePtcMode', 'injectPrompt',
    'promoteGate', 'promoteAfterFirstResponse', 'personaSectionsOnly', 'workspaceLine', 'instructionHint',
    'anchorTurn', 'deliberationGate', 'cotDrip',
  ] as const
  const numberKeys = [
    'bootstrapMaxTokens', 'maxPromoteSteps', 'stagePreUnlock', 'deferredGraceSteps',
    'deliberationMinChars', 'deliberationMaxGatesPerTurn', 'cotDripEvery', 'cotDripMaxPerTurn',
    'strReplaceEditorMaxOutputChars',
  ] as const
  const listKeys = [
    'toolFilterAllow', 'toolFilterDeny', 'allowKinds', 'bootstrapTools', 'compactionTools',
    'messageSources', 'deferredSources',
  ] as const

  for (const key of stringKeys) if (typeof source[key] === 'string') patch[key] = source[key]
  for (const key of booleanKeys) if (typeof source[key] === 'boolean') patch[key] = source[key]
  for (const key of numberKeys) if (typeof source[key] === 'number') patch[key] = source[key]
  for (const key of listKeys) {
    const value = joinList(source[key])
    if (value !== undefined) patch[key] = value
  }
  if (source.maxDepth !== undefined && source.maxDepth !== null && source.maxDepth !== '') {
    patch.maxDepth = String(source.maxDepth)
  }
  if (Array.isArray(source.stages)) {
    patch.stages = source.stages
      .filter((stage): stage is { name?: unknown; tools?: unknown } => stage !== null && typeof stage === 'object')
      .map((stage) => ({
        name: typeof stage.name === 'string' ? stage.name : '',
        tools: Array.isArray(stage.tools)
          ? stage.tools.filter((item): item is string => typeof item === 'string').join(', ')
          : '',
      }))
  }
  return patch
}

const splitList = (value: string): string[] => value.split(',').map((item) => item.trim()).filter(Boolean)

export interface ParamOverrideBuildOptions {
  loadedKeys: ReadonlySet<string>
  autoModelProvider?: string
  autoSubagentModelProvider?: string
}

/** UI 草稿按“已有键或偏离默认值”规则生成 params 写入载荷。 */
export function buildParamOverrides(fields: Fields, options: ParamOverrideBuildOptions): Record<string, unknown> {
  const emit = (key: string, value: unknown, empty: unknown): Record<string, unknown> =>
    options.loadedKeys.has(key) || !deepEqual(value, empty) ? { [key]: value } : {}
  const overrides: Record<string, unknown> = {
    ...emit('firstTurnAnchor', fields.firstTurnAnchor, false),
    ...emit('firstTurnText', fields.firstTurnText, ''),
    ...emit('firstTurnCustom', fields.firstTurnCustom, false),
    ...emit('guideText', fields.guideText, ''),
    ...emit('guideCustom', fields.guideCustom, false),
    ...emit('guideEnabled', fields.guideEnabled, undefined),
    ...emit('usePtcMode', fields.usePtcMode, false),
    ...emit('injectPrompt', fields.injectPrompt, true),
    ...emit('modelProvider', fields.modelProvider, ''),
    ...emit('modelName', fields.modelName, ''),
    ...emit('subagentModelProvider', fields.subagentModelProvider, ''),
    ...emit('subagentModelName', fields.subagentModelName, ''),
    ...emit('modelReasoningEffort', fields.modelReasoningEffort, ''),
    ...emit('modelTemperature', fields.modelTemperature, ''),
    ...emit('modelMaxTokens', fields.modelMaxTokens, ''),
    ...emit('subagentReasoningEffort', fields.subagentReasoningEffort, ''),
    ...emit('subagentTemperature', fields.subagentTemperature, ''),
    ...emit('subagentMaxTokens', fields.subagentMaxTokens, ''),
    ...emit('toolFilterAllow', splitList(fields.toolFilterAllow), []),
    ...emit('toolFilterDeny', splitList(fields.toolFilterDeny), []),
    ...emit('toolFilterSubagents', fields.toolFilterSubagents, false),
    ...emit('maxDepth', fields.maxDepth === '' ? '' : fields.maxDepth === 'provider-managed' ? 'provider-managed' : Number(fields.maxDepth), ''),
    ...emit('allowKinds', splitList(fields.allowKinds), []),
    ...emit('firstTurnWord', fields.firstTurnWord, ''),
    ...emit('bootstrapMaxTokens', fields.bootstrapMaxTokens, 0),
    ...emit('promoteGate', fields.promoteGate, false),
    ...emit('promoteAfterFirstResponse', fields.promoteAfterFirstResponse, false),
    ...emit('maxPromoteSteps', fields.maxPromoteSteps, 0),
    ...emit('bootstrapTools', splitList(fields.bootstrapTools), []),
    ...emit('compactionTools', splitList(fields.compactionTools), []),
    ...emit('stages', fields.stages
      .map((stage) => ({ name: stage.name.trim(), tools: splitList(stage.tools) }))
      .filter((stage) => stage.name.length > 0 && stage.tools.length > 0), []),
    ...emit('stagePreUnlock', fields.stagePreUnlock, 1),
    ...emit('stageAdvanceTool', fields.stageAdvanceTool, ''),
    ...emit('stageAdvanceDescription', fields.stageAdvanceDescription, ''),
    ...emit('stageSectionTemplate', fields.stageSectionTemplate, ''),
    ...emit('personaSectionsOnly', fields.personaSectionsOnly, false),
    ...emit('workspaceLine', fields.workspaceLine, false),
    ...emit('phase1FirstCallInstruction', fields.phase1FirstCallInstruction, ''),
    ...emit('instructionHint', fields.instructionHint, false),
    ...emit('messageSources', splitList(fields.messageSources), []),
    ...emit('deferredSources', splitList(fields.deferredSources), []),
    ...emit('deferredGraceSteps', fields.deferredGraceSteps, 0),
    ...emit('anchorTurn', fields.anchorTurn, false),
    ...emit('anchorTurnText', fields.anchorTurnText, ''),
    ...emit('deliberationGate', fields.deliberationGate, false),
    ...emit('deliberationMinChars', fields.deliberationMinChars, 0),
    ...emit('deliberationMaxGatesPerTurn', fields.deliberationMaxGatesPerTurn, 0),
    ...emit('cotDrip', fields.cotDrip, false),
    ...emit('cotDripEvery', fields.cotDripEvery, 0),
    ...emit('cotDripMaxPerTurn', fields.cotDripMaxPerTurn, 0),
    ...emit('strReplaceEditorMaxOutputChars', fields.strReplaceEditorMaxOutputChars, 16000),
  }
  const modelProviderIsDisplayOnly = !options.loadedKeys.has('modelProvider')
    && fields.modelName.length === 0 && fields.modelProvider === options.autoModelProvider
  const subagentProviderIsDisplayOnly = !options.loadedKeys.has('subagentModelProvider')
    && fields.subagentModelName.length === 0 && fields.subagentModelProvider === options.autoSubagentModelProvider
  if (modelProviderIsDisplayOnly) delete overrides.modelProvider
  if (subagentProviderIsDisplayOnly) delete overrides.subagentModelProvider
  return overrides
}
