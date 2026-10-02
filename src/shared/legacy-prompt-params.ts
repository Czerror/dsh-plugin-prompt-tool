/** 旧规则快捷参数只用于读取与旧 API 兼容；新编辑器直接保存规则实例。 */
export const LEGACY_PROMPT_PARAM_DEFINITIONS = {
  firstTurnAnchor: { kind: 'boolean', targets: ['near-anchor'] },
  firstTurnText: { kind: 'string', targets: ['near-anchor', 'prompt-injector'] },
  firstTurnCustom: { kind: 'boolean', targets: ['near-anchor'] },
  guideText: { kind: 'string', targets: ['router-guide'] },
  guideCustom: { kind: 'boolean', targets: ['router-guide'] },
  guideEnabled: { kind: 'boolean', targets: ['router-guide'] },
  injectPrompt: { kind: 'boolean', targets: ['prompt-injector'] },
  firstTurnWord: { kind: 'string', targets: ['prompt-injector'] },
  buildPattern: { kind: 'pattern', targets: ['near-anchor'] },
  complexPattern: { kind: 'pattern', targets: ['near-anchor', 'router-guide'] },
  firstTurnBuild: { kind: 'string', targets: ['near-anchor', 'prompt-injector'] },
  firstTurnInspect: { kind: 'string', targets: ['near-anchor', 'prompt-injector'] },
  firstTurnDeep: { kind: 'string', targets: ['near-anchor', 'prompt-injector'] },
  guideWeak: { kind: 'string', targets: ['router-guide'] },
  guideDeep: { kind: 'string', targets: ['router-guide'] },
} as const

export type LegacyPromptParamKey = keyof typeof LEGACY_PROMPT_PARAM_DEFINITIONS
export type LegacyPromptParams = {
  [K in LegacyPromptParamKey]?: typeof LEGACY_PROMPT_PARAM_DEFINITIONS[K]['kind'] extends 'boolean' ? boolean : string
}
export const LEGACY_PROMPT_PARAM_KEYS = Object.keys(LEGACY_PROMPT_PARAM_DEFINITIONS) as LegacyPromptParamKey[]
export const isLegacyPromptParam = (key: string): key is LegacyPromptParamKey => Object.hasOwn(LEGACY_PROMPT_PARAM_DEFINITIONS, key)
export const legacyPromptParamPath = (key: LegacyPromptParamKey): string[] => ['layerSettings', 'pre-step', key]
