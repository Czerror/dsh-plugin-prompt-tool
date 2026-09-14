/** 插件配置、settings 数据模型与默认常量（settings 接口层）。 */
import z from '@deepseek-ai/schemastery'
import type { PromptConfigSpec } from './host/prompt-configs.ts'
import { DEFAULT_PRESET_ORDER } from './host/paths.ts'
import type { PresetWriterParams } from './shared/engine-params.ts'

export const NS = 'prompt-tool' as const

/** 引擎行为参数键：定义见 shared/param-keys.ts（write-preset 合并过滤共用）。 */
export { PARAM_KEYS } from './shared/param-keys.ts'

export interface Config {
  /** 是否生成锚定注入 preset（默认 true）。 */
  writePreset: boolean
  /** 预设模板名（默认 anchored；其他模板时 anchored 专属 UI 可隐藏）。 */
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
  presetTemplate: z.string().default('anchored'),
  presetOrder: z.natural().default(DEFAULT_PRESET_ORDER),
  fallbackText: z.string().default(''),
})

export interface SkillEntry {
  /** 来源技能目录的绝对路径（多目录合并后用于修复定位与归属展示）。 */
  dir: string
  folder: string
  file: string
  name: string
  description: string
  whenToUse?: string
  metadata?: Record<string, unknown>
  body: string
  /** 是否通过官方 dsh-skill 候选校验；false 时只进管理界面，不注册给模型。 */
  valid: boolean
  /** invalid 条目的原因（可为空）。 */
  issue?: string
  /** 通过符号链接/junction 挂入的目录（删除类操作需谨慎）。 */
  linked?: boolean
  /** 停用态（磁盘上标记文件带 .disabled 后缀）：只进管理界面，不注册给模型。 */
  disabled?: boolean
  /** 官方调用策略：disable-model-invocation: true 时模型不可调用。 */
  modelInvocable: boolean
  /** 官方调用策略：user-invocable: false 时用户不可调用。 */
  userInvocable: boolean
}

export interface SkillCatalogEntry {
  folder: string
  name: string
  description: string
  /** 是否通过官方 dsh-skill 候选校验；false 时 UI 灰显并展示 issue。 */
  valid: boolean
  /** 来源技能目录绝对路径（多目录管理：修复定位 / 归属展示 / 目录计数）。 */
  dir?: string
  /** 同名标记：多个目录存在相同 folder 时全部保留，UI 标注同名。 */
  duplicate?: boolean
  /** invalid 条目的原因。 */
  issue?: string
  /** 通过符号链接/junction 挂入的目录（删除类操作需谨慎）。 */
  linked?: boolean
  /** 停用态：技能实体仍在该目录，标记文件为 SKILL.md.disabled。 */
  disabled?: boolean
  modelInvocable: boolean
  userInvocable: boolean
}

export interface PromptSettings {
  /** 运行时检测：是否检测到任何模型服务商（不写入 settings）。 */
  modelsAvailable: boolean
  /** 技能目录全量条目（含停用态）：启停与顺序的唯一事实来源由技能根与配置文件提供。 */
  skillCatalog: SkillCatalogEntry[]
  /** 当前实际生效的技能目录列表（配置为空 = [$DSH_HOME/skills]）。 */
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
    folder: z.string(),
    name: z.string(),
    description: z.string().default(''),
    valid: z.boolean().default(false),
    dir: z.string().default(''),
    duplicate: z.boolean().default(false),
    issue: z.string().default(''),
    disabled: z.boolean().default(false),
    modelInvocable: z.boolean().default(false),
    userInvocable: z.boolean().default(false),
  })).default([]),
  activeSkillsDirs: z.array(z.string()).default([]),
  skillsDirExists: z.dict(z.boolean()).default({}),
  presetOrder: z.natural().default(DEFAULT_PRESET_ORDER),
  fallbackText: z.string().default(''),
  writePreset: z.boolean().default(true),
  presetTemplate: z.string().default('anchored'),
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
