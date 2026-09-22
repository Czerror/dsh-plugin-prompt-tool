/** 插件配置、settings 数据模型与默认常量（settings 接口层）。 */
import z from '@deepseek-ai/schemastery'
import type { Volatile } from '@deepseek-ai/cordis'
import type { PromptConfigSpec } from './host/prompt-configs.ts'
import { DEFAULT_PRESET_ORDER } from './host/paths.ts'
import { DEFAULT_PRESET_ID } from './shared/preset-ids.ts'
import type { PresetWriterParams } from './shared/engine-params.ts'

export const NS = 'prompt-tool' as const

/** 引擎行为参数键：定义见 shared/param-keys.ts（write-preset 合并过滤共用）。 */
export { PARAM_KEYS } from './shared/param-keys.ts'

export interface Config {
  /** 是否生成注入预设（默认 true）。 */
  writePreset: Volatile<boolean>
  /** 预设模板名（默认 pt-standard：与宿主内置 standard 同名的用户目录会被遮蔽）。 */
  presetTemplate: Volatile<string>
  /** 生成 preset 的显示顺序。 */
  presetOrder: Volatile<number>
  /** preset.md 缺失或不可读时使用的文本。 */
  fallbackText: Volatile<string>
}

// 官方插件配置范式：同名 interface Config 与 Schemastery schema 成对导出，
// 框架在插件加载时校验并填充默认值。
export const Config = z.object({
  writePreset: z.boolean().default(true).volatile(),
  presetTemplate: z.string().default(DEFAULT_PRESET_ID).volatile(),
  presetOrder: z.natural().default(DEFAULT_PRESET_ORDER).volatile(),
  fallbackText: z.string().default('').volatile(),
})

export interface PromptSettings {
  /** 运行时检测：是否检测到任何模型服务商（不写入 settings）。 */
  modelsAvailable: boolean
  /** 生成 preset 的显示顺序。 */
  presetOrder: number
  /** preset.md 缺失或不可读时使用的文本。 */
  fallbackText: string
  writePreset: boolean
  presetTemplate: string
}

export const PromptSettingsSchema: z<PromptSettings> = z.object({
  modelsAvailable: z.boolean().default(true),
  presetOrder: z.natural().default(DEFAULT_PRESET_ORDER),
  fallbackText: z.string().default(''),
  writePreset: z.boolean().default(true),
  presetTemplate: z.string().default(DEFAULT_PRESET_ID),
})

/**
 * 运行时装配态：settings 轴 + 引擎参数（契约来自 shared/engine-params.ts）。
 * 引擎参数统一从 PresetWriterParams 继承（可选），此处仅对「schema 默认值保证必有值」
 * 的首层参数做必填重声明——TS 强制与契约类型兼容，签名漂移变成编译错误。
 * 可选尾（maxDepth / firstTurnWord / instructionHint 等）由 PresetWriterParams 继承，
 * 不再逐字段手写。
 */
export interface RuntimeOptions extends PresetWriterParams {
  writePreset: boolean
  presetTemplate: string
  /** 生成 preset 的显示顺序。 */
  presetOrder: number
  /** preset.md 缺失或不可读时使用的文本。 */
  fallbackText: string
  injectPrompt: boolean
  firstTurnAnchor: boolean
  firstTurnText: string
  firstTurnCustom: boolean
  guideText: string
  guideCustom: boolean
  /** 每轮引导独立开关（undefined = 跟随 firstTurnAnchor）。 */
  guideEnabled?: boolean
  /** 模型路由 provider（主对话直派子代理与委派子代理通用）；与模型名同时非空时生效。 */
  modelProvider: string
  /** 模型名；与 provider 同时非空时生效。 */
  modelName: string
  /** 子代理固定模型路由 provider；与子代理模型名同时非空时生效。 */
  subagentModelProvider: string
  /** 子代理固定模型名；与 provider 同时非空时生效。 */
  subagentModelName: string
  /** 主对话思维程度（agent-request patch reasoningEffort；''=不设置）。 */
  modelReasoningEffort: string
  /** 主对话采样温度（agent-request patch temperature；''=不设置）。 */
  modelTemperature: string
  /** 主对话输出上限（agent-request patch maxTokens；''=不设置）。 */
  modelMaxTokens: string
  /** 子代理思维程度（agent-request patch，audience=subagent；''=不设置）。 */
  subagentReasoningEffort: string
  /** 子代理采样温度（agent-request patch，audience=subagent；''=不设置）。 */
  subagentTemperature: string
  /** 子代理输出上限（agent-request patch，audience=subagent；''=不设置）。 */
  subagentMaxTokens: string
  /** 用户自定义提示词配置（settings 数组）。 */
  promptConfigs: PromptConfigSpec[]
}
