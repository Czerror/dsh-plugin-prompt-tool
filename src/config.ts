/** 插件配置、settings 数据模型与默认常量（settings 接口层）。 */
import z from '@deepseek-ai/schemastery'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import type { PromptConfigSpec } from './host/prompt-configs.ts'
import {
  DEFAULT_PRESET_DIR,
  DEFAULT_PRESET_ORDER,
  DEFAULT_RESIDENT_AGENTS_PATH,
  DEFAULT_SKILL_RANK_BASE,
} from './host/paths.ts'

export const NS: SettingsNamespace = settingsNamespace('prompt-tool')

/**
 * 引擎行为参数键（按预设存储：激活预设 preset.yml 的 params + promptConfigs）。
 * 不进 Config schema、不进 settings namespace——每预设一份，随预设走（官方范式：
 * Config = 部署轴，引擎行为在预设文件）。
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

export interface Config {
  /** 是否用 AGENTS.md 内容替换本地 instruction-hint 的默认提示文本（默认关闭）。 */
  injectAgentsPrompt: boolean
  /** 是否写 ~/.dsh/AGENTS.md（默认 true）。 */
  writeAgents: boolean
  /** 是否生成锚定注入 preset（默认 true）。 */
  writePreset: boolean
  /** 预设模板名（默认 anchored；其他模板时 anchored 专属 UI 可隐藏）。 */
  presetTemplate: string
  /** 以技能目录名为键的逐技能开关，缺省视为 true。 */
  skillSwitches: Record<string, boolean>
  /** 技能展示顺序（目录名数组）：排前面的技能 rank 更小，模型最先看到。 */
  skillOrder: string[]
  /** 用户自定义技能目录列表（按添加顺序，首个目录优先级最高）；空 = 自动使用当前 profile 下的 skills/ 副本。 */
  skillsDirs: string[]
  /** 旧版单值技能目录（仅读取迁移用，新版本统一写回 skillsDirs）。 */
  skillsDir?: string
  /** 技能候选排序基数，技能目录内按下标递增。 */
  skillRankBase: number
  /** 常驻规则文件目标路径。 */
  residentAgentsPath: string
  /** 生成的 agent preset 目录。 */
  presetDir: string
  /** 生成 preset 的显示顺序。 */
  presetOrder: number
  /** preset.md 缺失或不可读时使用的文本。 */
  fallbackText: string
}

// 官方插件配置范式：同名 interface Config 与 Schemastery schema 成对导出，
// 框架在插件加载时校验并填充默认值。
export const Config: z<Config> = z.object({
  injectAgentsPrompt: z.boolean().default(false),
  writeAgents: z.boolean().default(true),
  writePreset: z.boolean().default(true),
  presetTemplate: z.string().default('anchored'),
  skillSwitches: z.dict(z.boolean()).default({}),
  skillOrder: z.array(z.string()).default([]),
  skillsDirs: z.array(z.string()).default([]),
  // 兼容旧版单值 key：读取后由 index 归一迁移到 skillsDirs。
  skillsDir: z.string().default(''),
  skillRankBase: z.natural().default(DEFAULT_SKILL_RANK_BASE),
  residentAgentsPath: z.string().default(DEFAULT_RESIDENT_AGENTS_PATH),
  presetDir: z.string().default(DEFAULT_PRESET_DIR),
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
  modelInvocable: boolean
  userInvocable: boolean
}

export interface PromptSettings {
  injectAgentsPrompt: boolean
  /** 运行时检测：是否检测到任何模型服务商（不写入 settings）。 */
  modelsAvailable: boolean
  skillSwitches: Record<string, boolean>
  /** 技能展示顺序（目录名数组）。 */
  skillOrder: string[]
  skillCatalog: SkillCatalogEntry[]
  /** 用户自定义技能目录列表（按添加顺序）；空 = 自动使用 profile skills 副本。 */
  skillsDirs: string[]
  /** 当前实际生效的技能目录列表（空配置 = [profile 副本路径]）。 */
  activeSkillsDirs: string[]
  /** 生效目录存在性（path → 目录是否存在，供 UI 状态徽章）。 */
  skillsDirExists: Record<string, boolean>
  /** 技能候选排序基数。 */
  skillRankBase: number
  /** 常驻规则文件目标路径。 */
  residentAgentsPath: string
  /** 生成的 agent preset 目录。 */
  presetDir: string
  /** 生成 preset 的显示顺序。 */
  presetOrder: number
  /** preset.md 缺失或不可读时使用的文本。 */
  fallbackText: string
  writeAgents: boolean
  writePreset: boolean
  presetTemplate: string
}

export const PromptSettingsSchema: z<PromptSettings> = z.object({
  injectAgentsPrompt: z.boolean().default(false),
  modelsAvailable: z.boolean().default(true),
  skillSwitches: z.dict(z.boolean()).default({}),
  skillOrder: z.array(z.string()).default([]),
  skillCatalog: z.array(z.object({
    folder: z.string(),
    name: z.string(),
    description: z.string().default(''),
    valid: z.boolean().default(false),
    dir: z.string().default(''),
    duplicate: z.boolean().default(false),
    issue: z.string().default(''),
    modelInvocable: z.boolean().default(false),
    userInvocable: z.boolean().default(false),
  })).default([]),
  skillsDirs: z.array(z.string()).default([]),
  activeSkillsDirs: z.array(z.string()).default([]),
  skillsDirExists: z.dict(z.boolean()).default({}),
  skillRankBase: z.natural().default(DEFAULT_SKILL_RANK_BASE),
  residentAgentsPath: z.string().default(DEFAULT_RESIDENT_AGENTS_PATH),
  presetDir: z.string().default(DEFAULT_PRESET_DIR),
  presetOrder: z.natural().default(DEFAULT_PRESET_ORDER),
  fallbackText: z.string().default(''),
  writeAgents: z.boolean().default(true),
  writePreset: z.boolean().default(true),
  presetTemplate: z.string().default('anchored'),
})

export interface RuntimeOptions {
  writeAgents: boolean
  writePreset: boolean
  presetTemplate: string
  injectAgentsPrompt: boolean
  injectPrompt: boolean
  skillSwitches: Record<string, boolean>
  /** 技能展示顺序（目录名数组）。 */
  skillOrder: string[]
  /** 用户自定义技能目录列表（按添加顺序）；空 = 自动使用 profile skills 副本。 */
  skillsDirs: string[]
  firstTurnAnchor: boolean
  firstTurnText: string
  firstTurnCustom: boolean
  guideText: string
  guideCustom: boolean
  bootstrapMaxTokens: number
  usePtcMode: boolean
  /** 技能候选排序基数。 */
  skillRankBase: number
  /** 常驻规则文件目标路径。 */
  residentAgentsPath: string
  /** 生成的 agent preset 目录。 */
  presetDir: string
  /** 生成 preset 的显示顺序。 */
  presetOrder: number
  /** preset.md 缺失或不可读时使用的文本。 */
  fallbackText: string
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
  /** 子代理自定义模型人设（经 overrides 覆盖，不写入 settings）。 */
  subagentPersona?: string
  /** 委派工具集白名单（经 overrides 覆盖，不写入 settings）。 */
  toolFilterAllow?: string[] | string
  /** 委派工具集黑名单（经 overrides 覆盖，不写入 settings）。 */
  toolFilterDeny?: string[] | string
  /** 委派递归深度（经 overrides 覆盖，不写入 settings）。 */
  maxDepth?: number | 'provider-managed' | string
  /** 注入 kind 白名单（经 overrides 覆盖，不写入 settings）。 */
  allowKinds?: string[] | string
  /** custom-fallback 锚定词（经 overrides 覆盖，不写入 settings）。 */
  firstTurnWord?: string
  /** 用户自定义提示词配置（settings 数组）。 */
  promptConfigs: PromptConfigSpec[]
}
