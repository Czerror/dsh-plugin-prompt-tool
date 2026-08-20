/** 插件配置、settings 数据模型与默认常量（settings 接口层）。 */
import z from '@deepseek-ai/schemastery'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { join } from 'node:path'
import type { PromptConfigSpec } from './host/prompt-configs.ts'
import { loadPresetSpec, packagePresetDir, resolvePresetParams } from './host/manifest.ts'
import {
  DEFAULT_PRESET_DIR,
  DEFAULT_PRESET_ORDER,
  DEFAULT_RESIDENT_AGENTS_PATH,
  DEFAULT_SKILL_RANK_BASE,
  DEFAULT_SKILLS_DIR,
} from './host/paths.ts'

export const NS: SettingsNamespace = settingsNamespace('prompt-tool')

/**
 * promptConfigs 数组元素的最小结构 schema：只强校验“元素是对象、id 是字符串”。
 * 其余字段全部宽松透传（schemastery object 非 strict 合并保留未知键），
 * 枚举级权威校验归 engine 的 createPromptConfigs，避免两处枚举漂移。
 */
const PromptConfigEntrySchema = z.object({ id: z.string().required() }) as unknown as z<PromptConfigSpec>

// 自动每轮引导文本：唯一来源是 preset/anchored/preset.yml 的 guideWeak / guideDeep。
// 这里只负责读取 preset 参数并组装成 settings 编辑框默认内容，不再硬编码第二份文本。
function loadGuideDefaults(): { weak: string; deep: string } {
  try {
    const spec = loadPresetSpec(join(packagePresetDir(), 'anchored'))
    const params = resolvePresetParams(spec, {})
    const weak = typeof params.guideWeak === 'string' ? params.guideWeak : ''
    const deep = typeof params.guideDeep === 'string' ? params.guideDeep : ''
    return { weak, deep }
  } catch {
    return { weak: '', deep: '' }
  }
}

const GUIDE_DEFAULTS = loadGuideDefaults()
/** 每轮引导文本框的默认内容：写入自动引导的两段文本。 */
export const DEFAULT_GUIDE_TEXT = GUIDE_DEFAULTS.weak.length > 0 || GUIDE_DEFAULTS.deep.length > 0
  ? `简单任务自动引导：${GUIDE_DEFAULTS.weak.trim()}\n\n复杂任务自动引导：${GUIDE_DEFAULTS.deep.trim()}`
  : ''

export interface Config {
  /** 是否用 AGENTS.md 内容替换本地 instruction-hint 的默认提示文本（默认关闭）。 */
  injectAgentsPrompt: boolean
  /** 是否写 ~/.dsh/AGENTS.md（默认 true）。 */
  writeAgents: boolean
  /** 是否生成锚定注入 preset（默认 true）。 */
  writePreset: boolean
  /** 预设模板名（默认 anchored；其他模板时 anchored 专属 UI 可隐藏）。 */
  presetTemplate: string
  /** 锚定层：we 锚定确认后是否注入 preset.md（默认 true）。 */
  injectPrompt: boolean
  /** 以技能目录名为键的逐技能开关，缺省视为 true。 */
  skillSwitches: Record<string, boolean>
  /** 技能展示顺序（目录名数组）：排前面的技能 rank 更小，模型最先看到。 */
  skillOrder: string[]
  /** 首轮近距离锚定开关（默认关闭）。 */
  firstTurnAnchor: boolean
  /** 自定义锚点文本；firstTurnCustom=true 时固定使用。 */
  firstTurnText: string
  /** 自定义锚点开关：true 固定使用 firstTurnText；false 按任务自动选择。 */
  firstTurnCustom: boolean
  /** 自定义每轮引导文本；guideCustom=true 时固定使用。 */
  guideText: string
  /** 自定义每轮引导开关：true 固定使用 guideText；false 按任务自动选择。 */
  guideCustom: boolean
  /** 子代理固定模型路由 provider；与模型名同时非空时，子代理/宿主直派子代理自动补入该路由。 */
  subagentModelProvider: string
  /** 子代理固定模型名；与 provider 同时非空时生效。 */
  subagentModelName: string
  /** 首轮输出封顶；0 或未设置 = 不设封顶（本项目默认），正整数 = 请求 #1 的 maxTokens。 */
  bootstrapMaxTokens: number
  /** 使用 PTC 模式：默认开启——晋升后把 wire 切换为 Code Mode（单一 run_code，完整插件工具经生成 SDK 调用）；关闭时晋升后恢复原生完整工具目录。 */
  usePtcMode: boolean
  /** 用户自定义技能目录；空 = 自动使用当前 profile 下的 skills/ 副本。 */
  skillsDir: string
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
  /** 用户自定义提示词配置（settings 数组）：按 id 覆盖默认提示词配置或追加新提示词配置；UI 设置最终消费此接口。 */
  promptConfigs: PromptConfigSpec[]
  /** 用户自定义提示词配置目录：扫描 *.yml/*.yaml/*.json，优先级低于 promptConfigs。 */
  promptConfigsDir: string
}

// 官方插件配置范式：同名 interface Config 与 Schemastery schema 成对导出，
// 框架在插件加载时校验并填充默认值。
export const Config: z<Config> = z.object({
  injectAgentsPrompt: z.boolean().default(false),
  writeAgents: z.boolean().default(true),
  writePreset: z.boolean().default(true),
  presetTemplate: z.string().default('anchored'),
  injectPrompt: z.boolean().default(true),
  skillSwitches: z.dict(z.boolean()).default({}),
  skillOrder: z.array(z.string()).default([]),
  firstTurnAnchor: z.boolean().default(false),
  firstTurnText: z.string().default(''),
  firstTurnCustom: z.boolean().default(false),
  guideText: z.string().default(DEFAULT_GUIDE_TEXT),
  guideCustom: z.boolean().default(false),
  subagentModelProvider: z.string().default(''),
  subagentModelName: z.string().default(''),
  bootstrapMaxTokens: z.natural().default(0),
  usePtcMode: z.boolean().default(true),
  skillsDir: z.string().default(DEFAULT_SKILLS_DIR),
  skillRankBase: z.natural().default(DEFAULT_SKILL_RANK_BASE),
  residentAgentsPath: z.string().default(DEFAULT_RESIDENT_AGENTS_PATH),
  presetDir: z.string().default(DEFAULT_PRESET_DIR),
  presetOrder: z.natural().default(DEFAULT_PRESET_ORDER),
  fallbackText: z.string().default(''),
  promptConfigs: z.array(PromptConfigEntrySchema).default([]) as unknown as z<PromptConfigSpec[]>,
  promptConfigsDir: z.string().default(''),
})

export interface SkillEntry {
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
  /** invalid 条目的原因。 */
  issue?: string
  /** 通过符号链接/junction 挂入的目录（删除类操作需谨慎）。 */
  linked?: boolean
  modelInvocable: boolean
  userInvocable: boolean
}

export interface PromptSettings {
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
  /** 子代理固定模型路由 provider；与模型名同时非空时生效。 */
  subagentModelProvider: string
  /** 子代理固定模型名；与 provider 同时非空时生效。 */
  subagentModelName: string
  bootstrapMaxTokens: number
  usePtcMode: boolean
  /** 运行时检测：是否注册了 DeepSeek 模型路由（不写入 settings）。 */
  deepseekAvailable: boolean
  injectPrompt: boolean
  skillSwitches: Record<string, boolean>
  /** 技能展示顺序（目录名数组）。 */
  skillOrder: string[]
  skillCatalog: SkillCatalogEntry[]
  /** 用户自定义技能目录；空 = 自动使用 profile skills 副本。 */
  skillsDir: string
  /** 当前实际生效的技能目录（profile 副本或用户自定义路径）。 */
  activeSkillsDir: string
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
  /** 用户自定义提示词配置（settings 层；UI 设置最后消费此数组渲染提示词配置编辑器）。 */
  promptConfigs: PromptConfigSpec[]
  /** 用户自定义提示词配置目录；空 = 不扫描。 */
  promptConfigsDir: string
}

export const PromptSettingsSchema: z<PromptSettings> = z.object({
  promptText: z.string().default(''),
  promptPath: z.string().default(''),
  agentsText: z.string().default(''),
  agentsPath: z.string().default(''),
  injectAgentsPrompt: z.boolean().default(false),
  firstTurnAnchor: z.boolean().default(false),
  firstTurnText: z.string().default(''),
  firstTurnCustom: z.boolean().default(false),
  guideText: z.string().default(DEFAULT_GUIDE_TEXT),
  guideCustom: z.boolean().default(false),
  subagentModelProvider: z.string().default(''),
  subagentModelName: z.string().default(''),
  bootstrapMaxTokens: z.natural().default(0),
  usePtcMode: z.boolean().default(true),
  deepseekAvailable: z.boolean().default(true),
  injectPrompt: z.boolean().default(true),
  skillSwitches: z.dict(z.boolean()).default({}),
  skillOrder: z.array(z.string()).default([]),
  skillCatalog: z.array(z.object({
    folder: z.string(),
    name: z.string(),
    description: z.string().default(''),
    valid: z.boolean().default(false),
    issue: z.string().default(''),
    modelInvocable: z.boolean().default(false),
    userInvocable: z.boolean().default(false),
  })).default([]),
  skillsDir: z.string().default(''),
  activeSkillsDir: z.string().default(''),
  skillRankBase: z.natural().default(DEFAULT_SKILL_RANK_BASE),
  residentAgentsPath: z.string().default(DEFAULT_RESIDENT_AGENTS_PATH),
  presetDir: z.string().default(DEFAULT_PRESET_DIR),
  presetOrder: z.natural().default(DEFAULT_PRESET_ORDER),
  fallbackText: z.string().default(''),
  writeAgents: z.boolean().default(true),
  writePreset: z.boolean().default(true),
  presetTemplate: z.string().default('anchored'),
  promptConfigs: z.array(PromptConfigEntrySchema).default([]) as unknown as z<PromptConfigSpec[]>,
  promptConfigsDir: z.string().default(''),
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
  /** 用户自定义技能目录；空 = 自动使用 profile skills 副本。 */
  skillsDir: string
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
  /** 子代理固定模型路由 provider；与模型名同时非空时生效。 */
  subagentModelProvider: string
  /** 子代理固定模型名；与 provider 同时非空时生效。 */
  subagentModelName: string
  /** 用户自定义提示词配置（settings 数组）。 */
  promptConfigs: PromptConfigSpec[]
  /** 用户自定义提示词配置目录。 */
  promptConfigsDir: string
}
