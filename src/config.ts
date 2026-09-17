/** 插件配置、settings 数据模型与默认常量（settings 接口层）。 */
import z from '@deepseek-ai/schemastery'
import type { PromptConfigSpec } from './host/prompt-configs.ts'
import { DEFAULT_PRESET_ORDER } from './host/paths.ts'
import type { PresetWriterParams } from './shared/engine-params.ts'
import type { SkillCatalogEntry } from './shared/skills.ts'

export const NS = 'prompt-tool' as const

/** 引擎行为参数键：定义见 shared/param-keys.ts（write-preset 合并过滤共用）。 */
export { PARAM_KEYS } from './shared/param-keys.ts'

export interface Config {
  /** 是否生成注入预设（默认 true）。 */
  writePreset: boolean
  /** 预设模板名（默认 standard）。 */
  presetTemplate: string
  /** 生成 preset 的显示顺序。 */
  presetOrder: number
  /** preset.md 缺失或不可读时使用的文本。 */
  fallbackText: string
}

// 官方插件配置范式：同名 interface Config 与 Schemastery schema 成对导出，
// 框架在插件加载时校验并填充默认值。
export const Config: z<Config> = z.object({
  writePreset: z.boolean().default(true),
  presetTemplate: z.string().default('standard'),
  presetOrder: z.natural().default(DEFAULT_PRESET_ORDER),
  fallbackText: z.string().default(''),
})

export interface PromptSettings {
  /** 运行时检测：是否检测到任何模型服务商（不写入 settings）。 */
  modelsAvailable: boolean
  /** 技能清单：按官方六类技能根扫描的结果 + 注册层屏蔽状态。 */
  skillCatalog: SkillCatalogEntry[]
  /** 用户技能根（技能实体的落点；其余来源由官方各自发现）。 */
  activeSkillsDirs: string[]
  /** 生效目录存在性（path → 目录是否存在，供 UI 状态徽章）。 */
  skillsDirExists: Record<string, boolean>
  /** 生成 preset 的显示顺序。 */
  presetOrder: number
  /** preset.md 缺失或不可读时使用的文本。 */
  fallbackText: string
  writePreset: boolean
  presetTemplate: string
}

export const PromptSettingsSchema: z<PromptSettings> = z.object({
  modelsAvailable: z.boolean().default(true),
  skillCatalog: z.array(z.object({
    id: z.string(),
    name: z.string(),
    description: z.string().default(''),
    folder: z.string(),
    dir: z.string(),
    source: z.union([
      z.const('project-dsh'),
      z.const('project-agents'),
      z.const('custom'),
      z.const('user-dsh'),
      z.const('user-agents'),
      z.const('bundled'),
    ]),
    rank: z.number(),
    valid: z.boolean().default(false),
    issue: z.string().default(''),
    blocked: z.boolean().default(false),
    modelInvocable: z.boolean().default(false),
    userInvocable: z.boolean().default(false),
    winnerId: z.string().default(''),
    path: z.string().default(''),
  })).default([]),
  activeSkillsDirs: z.array(z.string()).default([]),
  skillsDirExists: z.dict(z.boolean()).default({}),
  presetOrder: z.natural().default(DEFAULT_PRESET_ORDER),
  fallbackText: z.string().default(''),
  writePreset: z.boolean().default(true),
  presetTemplate: z.string().default('standard'),
})

/**
 * 运行时装配态：settings 轴 + 引擎参数（契约来自 shared/engine-params.ts）。
 * 引擎参数统一从 PresetWriterParams 继承（可选），此处仅对「schema 默认值保证必有值」
 * 的首层参数做必填重声明——TS 强制与契约类型兼容，签名漂移变成编译错误。
 * 可选尾（toolFilterAllow / toolFilterDeny / maxDepth / allowKinds /
 * firstTurnWord）由 PresetWriterParams 继承，不再逐字段手写。
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
  bootstrapMaxTokens?: number
  /** PTC (Code Mode) 呈现开关；undefined = 模板/引擎默认（false，opt-in）。 */
  usePtcMode: boolean | undefined
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
