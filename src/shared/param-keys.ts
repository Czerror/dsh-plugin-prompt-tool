/**
 * 引擎行为参数键（按预设存储：激活预设 preset.yml 的 params + promptConfigs）。
 * 不进 Config schema、不进 settings namespace——每预设一份，随预设走（官方范式：
 * Config = 部署轴，引擎行为在预设文件）。
 *
 * 这些键在 UI 有专门编辑入口（模型设置 / 工具与深度 / 开关），writePreset 把
 * 预设级 params 合并进每条 promptConfig 的 params 时排除——「params（高级参数
 * JSON）」框只保留内容变量与配置自身策略参数，避免 UI 已管理的参数冗余回写。
 * 放 shared：host（write-preset）与 config/settings-bridge 共用，单一来源。
 */
export const PARAM_KEYS: ReadonlySet<string> = new Set([
  'firstTurnAnchor', 'firstTurnText', 'firstTurnCustom',
  'guideText', 'guideCustom',
  'modelProvider', 'modelName',
  'subagentModelProvider', 'subagentModelName',
  'modelReasoningEffort', 'modelTemperature', 'modelMaxTokens',
  'subagentReasoningEffort', 'subagentTemperature', 'subagentMaxTokens',
  'subagentPersona',
  'toolFilterAllow', 'toolFilterDeny', 'maxDepth', 'allowKinds', 'firstTurnWord',
  'bootstrapMaxTokens', 'usePtcMode', 'injectPrompt',
  'promptConfigs',
])
