/** 插件配置、settings 数据模型与默认常量（settings 接口层）。 */
import z from '@deepseek-ai/schemastery'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import type { PromptConfigSpec } from './engine/prompt-configs.ts'

export const NS: SettingsNamespace = settingsNamespace('prompt-tool')

export const SKILLS_DIR = fileURLToPath(new URL('../skills', import.meta.url))

/**
 * promptConfigs 数组元素的最小结构 schema：只强校验“元素是对象、id 是字符串”。
 * 其余字段全部宽松透传（schemastery object 非 strict 合并保留未知键），
 * 枚举级权威校验归 engine 的 createPromptConfigs，避免两处枚举漂移。
 */
const PromptConfigEntrySchema = z.object({ id: z.string().required() }) as unknown as z<PromptConfigSpec>

// 部署路径默认值；凡是不同部署可能需要不同值的参数都通过 Config 暴露，
// cordis.yml 可以覆盖，无需改代码。
// 与官方 dsh-home-paths.resolveDshHome 语义对齐：
// 未设置 / 空串 / 纯空白回退 OS home 下的 .dsh；支持 ~、~/、~\；
// 相对路径按进程 cwd 解析为绝对路径，避免生成目录随运行目录漂移。
function resolveDshHome(): string {
  const ambient = process.env.DSH_HOME
  if (typeof ambient !== 'string' || ambient.trim().length === 0) return join(homedir(), '.dsh')
  const expanded = ambient === '~'
    ? homedir()
    : ambient.startsWith('~/') || ambient.startsWith('~\\')
      ? join(homedir(), ambient.slice(2))
      : ambient
  return resolve(expanded)
}

export const DSH_HOME = resolveDshHome()
export const DEFAULT_RESIDENT_AGENTS_PATH = join(DSH_HOME, 'AGENTS.md')
export const DEFAULT_PRESET_DIR = join(DSH_HOME, '.agent-presets', 'prompt-tool')
export const DEFAULT_SKILLS_DIR = SKILLS_DIR
export const DEFAULT_PRESET_ORDER = 5
export const DEFAULT_SKILL_RANK_BASE = 250

// 自动每轮引导文本（与 prompt-config-engine.mjs 的 guide-auto 策略保持同步）；作为每轮引导编辑框的默认内容。
const AUTO_GUIDE_WEAK = '\nRouter: classify this task (build or fix) now, then adopt the matching style — build: direct production; fix: inspect-first. Think deeply first, then commit and act.'
const AUTO_GUIDE_DEEP = '\nRouter: classify this task (build or fix) now, then adopt the matching style — build: direct production; fix: inspect-first. Think deeply about the architecture, edge cases, and integration points. Do not spend reasoning on the environment or tooling. Produce when your information is complete. End each reasoning block with a decision or an information need.'
/** 每轮引导文本框的默认内容：写入自动引导的两段文本。 */
export const DEFAULT_GUIDE_TEXT = `简单任务自动引导：${AUTO_GUIDE_WEAK.trim()}\n\n复杂任务自动引导：${AUTO_GUIDE_DEEP.trim()}`

/** 旧版“每块强制 we need”默认锚句；已存 settings 时归一化为自动模式。 */
const LEGACY_ANCHOR_TEXT = [
  'You are a helpful software assistant.',
  '',
  "Begin every reasoning block with 'We need'.",
].join('\n')

/** 旧默认值归一化为空（自动）；用户自定义文本原样保留。 */
export function normalizeAnchorText(text: string | undefined): string {
  const value = typeof text === 'string' ? text : ''
  return value.trim() === LEGACY_ANCHOR_TEXT.trim() ? '' : value
}

export interface Config {
  /** 可选：覆盖 preset.md 文本（默认读文件）。 */
  text: string
  /** 可选：覆盖 AGENTS.md 文本（默认读文件）。 */
  agentsText: string
  /** 是否用 AGENTS.md 内容替换本地 instruction-hint 的默认提示文本（默认关闭）。 */
  injectAgentsPrompt: boolean
  /** 是否写 ~/.dsh/AGENTS.md（默认 true）。 */
  writeAgents: boolean
  /** 是否生成锚定注入 preset（默认 true）。 */
  writePreset: boolean
  /** 锚定层：we 锚定确认后是否注入 preset.md（默认 true）。 */
  injectPrompt: boolean
  /** 以技能目录名为键的逐技能开关，缺省视为 true。 */
  skillSwitches: Record<string, boolean>
  /** 技能展示顺序（目录名数组）：排前面的技能 rank 更小，模型最先看到。 */
  skillOrder: string[]
  /** 首轮近距离锚定开关（默认关闭）。 */
  anchorFirstTurn: boolean
  /** 自定义锚点文本；anchorCustom=true 时固定使用。 */
  anchorText: string
  /** 自定义锚点开关：true 固定使用 anchorText；false 按任务自动选择。 */
  anchorCustom: boolean
  /** 自定义每轮引导文本；guideCustom=true 时固定使用。 */
  guideText: string
  /** 自定义每轮引导开关：true 固定使用 guideText；false 按任务自动选择。 */
  guideCustom: boolean
  /** 子代理固定 Flash 模型：开启时给 subagent/subagent_fork 行加固定 Flash 路由；关闭时子代理继承主会话路由，目录全量放行。 */
  subagentFlash: boolean
  /** 子代理 Flash 路由 provider（默认 deepseek-official）。 */
  subagentFlashProvider: string
  /** 子代理 Flash 模型名（默认 deepseek-v4-flash）。 */
  subagentFlashModel: string
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
  text: z.string().default(''),
  agentsText: z.string().default(''),
  injectAgentsPrompt: z.boolean().default(false),
  writeAgents: z.boolean().default(true),
  writePreset: z.boolean().default(true),
  injectPrompt: z.boolean().default(true),
  skillSwitches: z.dict(z.boolean()).default({}),
  skillOrder: z.array(z.string()).default([]),
  anchorFirstTurn: z.boolean().default(false),
  anchorText: z.string().default(''),
  anchorCustom: z.boolean().default(false),
  guideText: z.string().default(DEFAULT_GUIDE_TEXT),
  guideCustom: z.boolean().default(false),
  subagentFlash: z.boolean().default(false),
  subagentFlashProvider: z.string().default('deepseek-official'),
  subagentFlashModel: z.string().default('deepseek-v4-flash'),
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
  modelInvocable: boolean
  userInvocable: boolean
}

export interface PromptSettings {
  promptText: string
  promptPath: string
  agentsText: string
  agentsPath: string
  injectAgentsPrompt: boolean
  anchorFirstTurn: boolean
  anchorText: string
  anchorCustom: boolean
  guideText: string
  guideCustom: boolean
  subagentFlash: boolean
  /** 子代理 Flash 路由 provider。 */
  subagentFlashProvider: string
  /** 子代理 Flash 模型名。 */
  subagentFlashModel: string
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
  anchorFirstTurn: z.boolean().default(false),
  anchorText: z.string().default(''),
  anchorCustom: z.boolean().default(false),
  guideText: z.string().default(DEFAULT_GUIDE_TEXT),
  guideCustom: z.boolean().default(false),
  subagentFlash: z.boolean().default(false),
  subagentFlashProvider: z.string().default('deepseek-official'),
  subagentFlashModel: z.string().default('deepseek-v4-flash'),
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
  promptConfigs: z.array(PromptConfigEntrySchema).default([]) as unknown as z<PromptConfigSpec[]>,
  promptConfigsDir: z.string().default(''),
})

export interface RuntimeOptions {
  writeAgents: boolean
  writePreset: boolean
  injectAgentsPrompt: boolean
  injectPrompt: boolean
  skillSwitches: Record<string, boolean>
  /** 技能展示顺序（目录名数组）。 */
  skillOrder: string[]
  /** 用户自定义技能目录；空 = 自动使用 profile skills 副本。 */
  skillsDir: string
  anchorFirstTurn: boolean
  anchorText: string
  anchorCustom: boolean
  guideText: string
  guideCustom: boolean
  subagentFlash: boolean
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
  /** 子代理 Flash 路由 provider。 */
  subagentFlashProvider: string
  /** 子代理 Flash 模型名。 */
  subagentFlashModel: string
  /** 用户自定义提示词配置（settings 数组）。 */
  promptConfigs: PromptConfigSpec[]
  /** 用户自定义提示词配置目录。 */
  promptConfigsDir: string
}
