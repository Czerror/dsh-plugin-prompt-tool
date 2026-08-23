import type { Context } from '@deepseek-ai/cordis'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import type SettingsService from '@deepseek-ai/dsh-settings'
import type {
  SkillCandidate,
  SkillDefinition,
  SkillLookupOptions,
  SkillProvider,
  SkillProviderControl,
} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'
import { createSkillsWatcher } from './runtime/skills-watcher.ts'
import { basename, dirname, join } from 'node:path'
import {
  asString,
  loadPresetContent,
  loadPresetSpec,
  resolvePresetDir,
  resolvePresetParams,
  savePresetParams,
} from './host/manifest.ts'
import type { PresetSpec } from './host/manifest.ts'
import type { PromptConfigSpec } from './host/prompt-configs.ts'
import { createCachedSkillsReader, mergeSkillDirs } from './runtime/skills-provider.ts'
import { ensureWebSurface } from './web-surface.ts'
import { resolveProfileSkillsDir } from './profile-skills.ts'
import { detectModels, installDefaultModelRoute, installSubagentModelRoute, listAdvertisedModels } from './runtime/models.ts'
import type { ModelDetection } from './runtime/models.ts'
import { registerSettingsBridge } from './runtime/settings-bridge.ts'
import { registerCharacterTools } from './runtime/character-tools.ts'
import { registerWorldBookTools } from './runtime/world-book-tools.ts'
import { registerSessionVarTools } from './runtime/session-var-tools.ts'
import { registerTuiCommand } from './runtime/tui.ts'
import { ensureSettingsRegistered } from './runtime/settings-registration.ts'
import { removeResidentAgentsBlock, writeAgents } from './runtime/agents-file.ts'
import { writePreset } from './host/write-preset.ts'
import type { WritePresetOptions } from './host/write-preset.ts'
import { ensurePresetSeed, listPresets, readPluginState, writePluginState } from './host/manifest.ts'
import {
  Config,
  NS,
  PARAM_KEYS,
  PromptSettings,
  PromptSettingsSchema,
  RuntimeOptions,
  SkillCatalogEntry,
  SkillEntry,
} from './config.ts'
import {
  DEFAULT_PRESET_DIR,
  DEFAULT_SKILLS_DIR,
  LEGACY_CONTAINER_DIR,
  LEGACY_USER_PRESETS_DIR,
} from './host/paths.ts'
import { migrateLegacyLayout, normalizePresetRootDir } from './host/migration.ts'

export const name = 'prompt-tool'
// 内容走 user 层（AGENTS.md 常驻层 + skill 按需层），
// 不再注册 system prompt section（否则会被 persona 的 complete:true 整个清零）。
// 注意：webServer 不放在静态 inject 里——profile 首次可能只有
// @deepseek-ai/dsh-base（没有 @deepseek-ai/dsh-web-app），硬注入会让插件
// pending 并导致启动失败。Web 表面改为动态等待 webServer；首次启动时由
// ensureWebSurface 自动把 web-app bundle 补进 profile，重启一次后生效。
export const inject = ['skills', 'commands', 'llm', 'subagents']

function readPromptFile(template: string, fallbackText: string): string {
  const text = loadPresetContent(template).presetText
  return text.length > 0 ? text : fallbackText
}

function readAgents(template: string): string {
  return loadPresetContent(template).agentsText
}

/** 生成目录内容文件（writePreset 落盘；大文本存文件而非 settings）。 */
function readGeneratedContent(presetDir: string, name: string): string {
  try {
    return readFileSync(join(presetDir, name), 'utf8')
  } catch {
    return ''
  }
}

function warn(ctx: Context, message: string): void {
  try {
    ctx.logger?.warn(message)
  } catch {
    // 日志不可用时保持静默，避免二次故障掩盖主路径。
  }
}

export function apply(ctx: Context, configIn: Config): void {
  // 旧布局 → 官方对齐布局一次性迁移（幂等；旧目录归档 .bak 保留安全网）。
  let legacyMigrated = false
  try {
    legacyMigrated = migrateLegacyLayout(DEFAULT_PRESET_DIR, LEGACY_USER_PRESETS_DIR)
  } catch (error) {
    warn(ctx, `prompt-tool: 旧布局迁移失败（下次启动重试）：${error instanceof Error ? error.message : String(error)}`)
  }
  // 首次启动种子化：全部内置模板复制到预设根（之后只经「新建」还原）。
  try {
    ensurePresetSeed()
  } catch (error) {
    warn(ctx, `prompt-tool: preset seed failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  const config = { ...configIn }
  // 旧版 presetDir 存量值（容器根/旧用户目录）归一化为预设根。
  config.presetDir = normalizePresetRootDir(config.presetDir, DEFAULT_PRESET_DIR, LEGACY_CONTAINER_DIR)
  const modelsState = (): ModelDetection => detectModels(ctx)
  const getModelsState = (): ModelDetection => modelsState()
  // 内容资产优先读生成目录文件（writePreset 落盘），模板 content 作回退；
  // settings.yaml 不再承载大文本（web 打开加载慢的根因）。
  const initialTemplate = typeof config.presetTemplate === 'string' && config.presetTemplate.length > 0
    ? config.presetTemplate
    : 'anchored'
  // 预设分离：每个预设 = 预设根下的官方预设目录 presetDir/<template>/。
  const initialPresetDir = join(config.presetDir, /^[a-zA-Z0-9_-]+$/.test(initialTemplate) ? initialTemplate : 'anchored')
  // 引擎参数从激活预设 preset.yml 读（settings 不再承载参数；每预设独立，随预设走）。
  let initialParams: Record<string, unknown> = {}
  let initialSpec: PresetSpec | undefined
  try {
    initialSpec = loadPresetSpec(resolvePresetDir(initialTemplate))
    initialParams = resolvePresetParams(initialSpec, {})
  } catch (error) {
    warn(ctx, `prompt-tool: 激活预设参数读取失败（使用默认值）：${error instanceof Error ? error.message : String(error)}`)
  }
  let current = readGeneratedContent(initialPresetDir, 'preset.md') || readPromptFile(initialTemplate, config.fallbackText)
  let currentAgents = readGeneratedContent(initialPresetDir, 'agents.md') || readAgents(initialTemplate)

  /** 从激活预设 preset.yml 重读引擎参数到 runtime（参数保存/切换后调用）。 */
  const reloadPresetParams = (): void => {
    let spec: PresetSpec | undefined
    try {
      spec = loadPresetSpec(resolvePresetDir(runtime.presetTemplate))
    } catch (error) {
      warn(ctx, `prompt-tool: 读取激活预设参数失败：${error instanceof Error ? error.message : String(error)}`)
      return
    }
    const params = resolvePresetParams(spec, {})
    runtime.firstTurnAnchor = params.firstTurnAnchor === true
    runtime.firstTurnText = asString(params.firstTurnText)
    runtime.firstTurnCustom = params.firstTurnCustom === true
    runtime.guideText = asString(params.guideText)
    runtime.guideCustom = params.guideCustom === true
    runtime.modelProvider = asString(params.modelProvider)
    runtime.modelName = asString(params.modelName)
    runtime.subagentModelProvider = asString(params.subagentModelProvider)
    runtime.subagentModelName = asString(params.subagentModelName)
    runtime.modelReasoningEffort = asString(params.modelReasoningEffort)
    runtime.modelTemperature = asString(params.modelTemperature)
    runtime.modelMaxTokens = asString(params.modelMaxTokens)
    runtime.subagentReasoningEffort = asString(params.subagentReasoningEffort)
    runtime.subagentTemperature = asString(params.subagentTemperature)
    runtime.subagentMaxTokens = asString(params.subagentMaxTokens)
    runtime.bootstrapMaxTokens = Number.isSafeInteger(params.bootstrapMaxTokens) && (params.bootstrapMaxTokens as number) >= 0
      ? params.bootstrapMaxTokens as number
      : 0
    // 透传：未声明 = 模板 preset.yml params / 引擎默认（false）兜底。
    runtime.usePtcMode = typeof params.usePtcMode === 'boolean' ? params.usePtcMode : undefined
    runtime.injectPrompt = params.injectPrompt !== false
    runtime.subagentPersona = asString(params.subagentPersona) || undefined
    runtime.toolFilterAllow = params.toolFilterAllow as string[] | string | undefined
    runtime.toolFilterDeny = params.toolFilterDeny as string[] | string | undefined
    runtime.maxDepth = params.maxDepth as RuntimeOptions['maxDepth']
    runtime.allowKinds = params.allowKinds as string[] | string | undefined
    runtime.firstTurnWord = asString(params.firstTurnWord) || undefined
    runtime.promptConfigs = Array.isArray(spec.promptConfigs)
      ? spec.promptConfigs as PromptConfigSpec[]
      : []
  }

  /** 重建生成目录（文本/组合/引擎/提示词配置）；writePreset 关闭时移除旧目录。 */
  const rebuildPreset = (): void => {
    // 先重读激活预设参数（/param-overrides 保存、TUI 开关、预设切换后生效）。
    reloadPresetParams()
    applyParamOverrides()
    if (runtime.writePreset) {
      const presetPrompt = runtime.injectPrompt && current.length > 0 ? current : ''
      const options: WritePresetOptions = {
        firstTurnAnchor: runtime.firstTurnAnchor,
        firstTurnText: runtime.firstTurnText,
        firstTurnCustom: runtime.firstTurnCustom,
        guideText: runtime.guideText,
        guideCustom: runtime.guideCustom,
        injectPrompt: runtime.injectPrompt,
        modelProvider: runtime.modelProvider,
        modelName: runtime.modelName,
        subagentModelProvider: runtime.subagentModelProvider,
        subagentModelName: runtime.subagentModelName,
        modelReasoningEffort: runtime.modelReasoningEffort,
        modelTemperature: runtime.modelTemperature,
        modelMaxTokens: runtime.modelMaxTokens,
        subagentReasoningEffort: runtime.subagentReasoningEffort,
        subagentTemperature: runtime.subagentTemperature,
        subagentMaxTokens: runtime.subagentMaxTokens,
        subagentPersona: runtime.subagentPersona,
        toolFilterAllow: runtime.toolFilterAllow,
        toolFilterDeny: runtime.toolFilterDeny,
        maxDepth: runtime.maxDepth,
        allowKinds: runtime.allowKinds,
        firstTurnWord: runtime.firstTurnWord,
        injectAgentsPrompt: runtime.injectAgentsPrompt,
        bootstrapMaxTokens: runtime.bootstrapMaxTokens,
        usePtcMode: runtime.usePtcMode,
        agentsInstructionText: currentAgents,
        presetDir: runtime.presetDir,
        presetOrder: runtime.presetOrder,
        promptConfigs: runtime.promptConfigs,
        presetTemplate: runtime.presetTemplate,
        warn: (message) => warn(ctx, message),
      }
      // 补建缺失/旧布局的预设目录（切换目标就绪；内容用模板默认）。
      // 仅补建缺失项与旧布局组合（../engine 引用），已就绪的预设由切换时更新。
      for (const preset of listPresets()) {
        if (preset.id === runtime.presetTemplate) continue
        const targetDir = join(runtime.presetDir, preset.id)
        if (!needsPresetRender(targetDir)) continue
        try {
          writePreset(readPromptFile(preset.id, runtime.fallbackText), {
            ...options,
            presetTemplate: preset.id,
            agentsInstructionText: '',
          })
        } catch (error) {
          warn(ctx, `prompt-tool: 补建预设 ${preset.id} 失败（切换时可重试）：${error instanceof Error ? error.message : String(error)}`)
        }
      }
      writePreset(presetPrompt, options)
    } else {
      // writePreset 关闭时移除各预设目录的生成物（agent.cordis.yml / prompt-configs /
      // 内容资产），保留 preset.yml 参数源与预设根本身——宿主以 agent.cordis.yml
      // 为准挂载，删除组合本体即停止注入；绝不删除整个用户预设目录
      // （旧版误删 presetDir 根：用户全部预设、种子标记 .pt-seeded、共享 .engine 一并清空）。
      let cleaned = 0
      for (const preset of listPresets()) {
        const dir = join(runtime.presetDir, preset.id)
        for (const name of ['agent.cordis.yml', 'prompt-configs', 'preset.md', 'agents.md', 'agents-instruction.md', 'engine']) {
          try {
            rmSync(join(dir, name), { recursive: true, force: true })
          } catch {
            // Windows 瞬时锁：残留无害（下次重建/清理重试）。
          }
        }
        cleaned += 1
      }
      warn(ctx, `prompt-tool: writePreset 已关闭，清理 ${cleaned} 个预设目录的生成物（preset.yml 参数保留）`)
    }
  }

  /** 激活预设目录（内容按预设根 presetDir/<template>/ 隔离；非法名回退 anchored）。 */
  const activePresetDir = (): string =>
    join(runtime.presetDir, /^[a-zA-Z0-9\u4e00-\u9fff_-]+$/.test(runtime.presetTemplate) ? runtime.presetTemplate : 'anchored')

  /** 预设目录是否需要（重新）渲染：agent.cordis.yml 缺失，或仍是旧布局组合（../engine 引用）。 */
  const needsPresetRender = (targetDir: string): boolean => {
    const compositionFile = join(targetDir, 'agent.cordis.yml')
    if (!existsSync(compositionFile)) return true
    try {
      const raw = readFileSync(compositionFile, 'utf8')
      return raw.includes('../engine/') || raw.includes('./engine/')
    } catch {
      return true
    }
  }

  /** 用户参数覆盖（生成目录 prompt-tool.overrides.yml；settings 不再承载参数）。 */
  const applyParamOverrides = (): void => {
    const raw = readGeneratedContent(activePresetDir(), 'prompt-tool.overrides.yml')
    if (raw.length === 0) return
    let overrides: Record<string, unknown>
    try {
      const parsed = parseYaml(raw, { logLevel: 'silent' })
      overrides = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {}
    } catch {
      return
    }
    if (typeof overrides.firstTurnAnchor === 'boolean') runtime.firstTurnAnchor = overrides.firstTurnAnchor
    if (typeof overrides.firstTurnCustom === 'boolean') runtime.firstTurnCustom = overrides.firstTurnCustom
    if (typeof overrides.firstTurnText === 'string') runtime.firstTurnText = overrides.firstTurnText
    if (typeof overrides.guideCustom === 'boolean') runtime.guideCustom = overrides.guideCustom
    if (typeof overrides.guideText === 'string') runtime.guideText = overrides.guideText
    if (typeof overrides.modelProvider === 'string') runtime.modelProvider = overrides.modelProvider
    if (typeof overrides.modelName === 'string') runtime.modelName = overrides.modelName
    if (typeof overrides.subagentModelProvider === 'string') runtime.subagentModelProvider = overrides.subagentModelProvider
    if (typeof overrides.subagentModelName === 'string') runtime.subagentModelName = overrides.subagentModelName
    if (typeof overrides.modelReasoningEffort === 'string') runtime.modelReasoningEffort = overrides.modelReasoningEffort
    if (typeof overrides.modelTemperature === 'string') runtime.modelTemperature = overrides.modelTemperature
    if (typeof overrides.modelMaxTokens === 'string') runtime.modelMaxTokens = overrides.modelMaxTokens
    if (typeof overrides.subagentReasoningEffort === 'string') runtime.subagentReasoningEffort = overrides.subagentReasoningEffort
    if (typeof overrides.subagentTemperature === 'string') runtime.subagentTemperature = overrides.subagentTemperature
    if (typeof overrides.subagentMaxTokens === 'string') runtime.subagentMaxTokens = overrides.subagentMaxTokens
    if (typeof overrides.subagentPersona === 'string') runtime.subagentPersona = overrides.subagentPersona
    if (typeof overrides.firstTurnWord === 'string') runtime.firstTurnWord = overrides.firstTurnWord
    if (typeof overrides.bootstrapMaxTokens === 'number') runtime.bootstrapMaxTokens = overrides.bootstrapMaxTokens
    // 列表/枚举类参数：类型守卫收窄（overrides YAML 可能是数组或字符串）。
    const listOf = (value: unknown): string[] | string | undefined => {
      if (typeof value === 'string') return value
      if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string')
      return undefined
    }
    const tfAllow = listOf(overrides.toolFilterAllow)
    if (tfAllow !== undefined) runtime.toolFilterAllow = tfAllow
    const tfDeny = listOf(overrides.toolFilterDeny)
    if (tfDeny !== undefined) runtime.toolFilterDeny = tfDeny
    const kinds = listOf(overrides.allowKinds)
    // allowKinds 空值 = 跳过（保留官方不过滤）；空数组白名单会全拦注入，禁止写入。
    if (kinds !== undefined && (typeof kinds === 'string' ? kinds.trim().length > 0 : kinds.length > 0)) {
      runtime.allowKinds = kinds
    }
    const depth = overrides.maxDepth
    if (depth === 'provider-managed') runtime.maxDepth = 'provider-managed'
    else if (typeof depth === 'number' && Number.isSafeInteger(depth) && depth >= 0) runtime.maxDepth = depth
    else if (typeof depth === 'string' && depth.length > 0) runtime.maxDepth = depth
  }
  // 首次启动把包内 skills/ 增量复制到 $DSH_HOME/profiles/<profile>/skills，
  // 并优先使用 profile 副本；已有同名文件不覆盖，用户编辑会保留。
  // 显式配置了其他技能目录时尊重用户选择，不做复制。
  const legacySkillsDir = typeof config.skillsDir === 'string' && config.skillsDir.length > 0 && config.skillsDir !== DEFAULT_SKILLS_DIR
    ? config.skillsDir
    : ''
  const userSkillsDirs = Array.isArray(config.skillsDirs) && config.skillsDirs.length > 0
    ? config.skillsDirs.filter((dir): dir is string => typeof dir === 'string' && dir.trim().length > 0)
    : legacySkillsDir.length > 0 ? [legacySkillsDir] : []
  /** 用户技能目录设置 → 实际生效目录列表（空配置 = profile skills 副本兜底）。 */
  const resolveActiveSkillsDirs = (dirs: string[]): string[] =>
    dirs.length > 0
      ? dirs
      : [resolveProfileSkillsDir(ctx, DEFAULT_SKILLS_DIR, (message) => warn(ctx, message))]
  let activeSkillsDirs = resolveActiveSkillsDirs(userSkillsDirs)
  // 三层结构：
  //  1) 扫描层宽松——坏技能也进 catalog（valid=false + issue），UI 可见可修；
  //  2) provider 层严格——只有 valid=true 的候选注册给模型；
  //  3) 文件 watcher——目录变化时重扫 catalog 并 invalidateSkills。
  const skillWarned = new Set<string>()
  const cachedSkills = createCachedSkillsReader()
  const readSkillsChecked = (dir: string) => cachedSkills.read(dir, (message) => {
    if (skillWarned.has(message)) return
    skillWarned.add(message)
    warn(ctx, message)
  })
  const catalogOf = (skills: SkillEntry[]): SkillCatalogEntry[] => {
    const counts = new Map<string, number>()
    for (const skill of skills) counts.set(skill.folder, (counts.get(skill.folder) ?? 0) + 1)
    return skills.map((skill) => ({
      folder: skill.folder,
      name: skill.name,
      description: skill.description,
      valid: skill.valid,
      dir: skill.dir,
      ...(counts.get(skill.folder)! > 1 ? { duplicate: true } : {}),
      ...(skill.issue !== undefined ? { issue: skill.issue } : {}),
      ...(skill.linked === true ? { linked: true } : {}),
      modelInvocable: skill.modelInvocable,
      userInvocable: skill.userInvocable,
    }))
  }
  /** 全量合并：多目录条目全部保留（同名不跳过，catalog 全量展示）。 */
  const readAllSkillsChecked = (): SkillEntry[] =>
    mergeSkillDirs(activeSkillsDirs, readSkillsChecked)
  let skillCatalog: SkillCatalogEntry[] = catalogOf(readAllSkillsChecked())

  // 技能目录热更新：任一目录新增/删除/改名后，catalog 与注册表缓存一起刷新。
  const skillsWatcher = createSkillsWatcher(() => activeSkillsDirs, () => {
    skillCatalog = catalogOf(readAllSkillsChecked())
    cachedSkills.invalidate(); invalidateSkills?.()
  })
  skillsWatcher.watch()
  // 插件卸载时关闭技能目录 watcher，避免泄漏与对已卸载 provider 的无效刷新。
  ctx.effect(() => () => skillsWatcher.close())

  /** 切换生效技能目录列表并刷新目录快照（供 describe / TUI 显示）。 */
  const applyActiveSkillsDirs = (dirs: string[]): void => {
    activeSkillsDirs = dirs
    cachedSkills.invalidate()
    skillCatalog = catalogOf(readAllSkillsChecked())
    skillsWatcher.watch()
  }

  // 1) 按需层：注册 skills/*/SKILL.md，name/description/whenToUse/metadata 全部来自各自 frontmatter。
  //    content 只包含技能自身正文；preset.md 不拼进技能正文，全部技能关闭时列表自然为空。
  let skillSwitches: Record<string, boolean> = { ...config.skillSwitches }
  let skillOrder: string[] = Array.isArray(config.skillOrder) ? [...config.skillOrder] : []
  let skillRankBase = config.skillRankBase
  const orderSkills = (skills: readonly SkillEntry[]): SkillEntry[] => {
    const index = new Map(skillOrder.map((folder, at) => [folder, at]))
    return [...skills].sort((left, right) => {
      const leftAt = index.get(left.folder)
      const rightAt = index.get(right.folder)
      if (leftAt === undefined && rightAt === undefined) return left.folder.localeCompare(right.folder)
      if (leftAt === undefined) return 1
      if (rightAt === undefined) return -1
      return leftAt - rightAt
    })
  }
  let invalidateSkills: (() => void) | undefined
  ctx.skills.registerProvider((control: SkillProviderControl): SkillProvider => {
    invalidateSkills = control.invalidate
    return {
      name: 'prompt-tool',
      list: async (options: SkillLookupOptions): Promise<readonly SkillCandidate[]> => {
        if (options.signal?.aborted) return []
        // 多目录同名技能：catalog 全量展示，模型注册只保留首个目录（添加顺序优先）。
        const unique: SkillEntry[] = []
        const seen = new Set<string>()
        for (const skill of readAllSkillsChecked()) {
          if (seen.has(skill.folder)) continue
          seen.add(skill.folder)
          unique.push(skill)
        }
        return orderSkills(unique)
          .filter((skill) => skill.valid && skillSwitches[skill.folder] !== false)
          .map((skill, index): SkillCandidate => ({
            name: skill.name,
            description: skill.description || skill.folder,
            ...(skill.whenToUse !== undefined ? { whenToUse: skill.whenToUse } : {}),
            invocation: { modelInvocable: skill.modelInvocable, userInvocable: skill.userInvocable },
            source: 'runtime',
            provider: 'prompt-tool',
            resourceBase: { kind: 'directory', path: join(skill.dir, skill.folder) },
            rank: skillRankBase + index,
            locator: skill.folder,
            path: skill.file,
            ...(skill.metadata !== undefined ? { metadata: skill.metadata } : {}),
          }))
      },
      get: async (candidate: SkillCandidate, options: SkillLookupOptions): Promise<SkillDefinition | undefined> => {
        if (options.signal?.aborted) return undefined
        // 精确匹配来源文件；同名回退 folder（保留首个目录条目）。
        const skill = readAllSkillsChecked().find((entry) => entry.file === candidate.path)
          ?? readAllSkillsChecked().find((entry) => entry.folder === candidate.locator || entry.name === candidate.name)
        if (skill === undefined || !skill.valid || skillSwitches[skill.folder] === false) return undefined
        return {
          name: candidate.name,
          description: candidate.description,
          ...(candidate.whenToUse !== undefined ? { whenToUse: candidate.whenToUse } : {}),
          invocation: candidate.invocation,
          source: candidate.source,
          provider: candidate.provider,
          resourceBase: candidate.resourceBase,
          ...(candidate.path !== undefined ? { path: candidate.path } : { path: skill.file }),
          ...(candidate.metadata !== undefined ? { metadata: candidate.metadata } : {}),
          content: skill.body,
        }
      },
    }
  })

  // 在线编辑不再经 ctx.llm 暴露 settings namespace：改为自建 loopback bridge，
  // 这样模型设置页不会出现「提示词工具」目录条目。
  registerSettingsBridge(
    ctx,
    NS,
    getModelsState,
    () => ({ activeSkillsDirs, skillCatalog }),
    // 模板专属策略目录：当前 anchored 策略为引擎内置，自定义模板可经此注入。
    () => '',
    (sctx: Context) => ensureRegistered(sctx),
    () => {
      // 一键修复后立即重扫目录并失效官方 registry 缓存。
      skillCatalog = catalogOf(readAllSkillsChecked())
      cachedSkills.invalidate(); invalidateSkills?.()
    },
    // 激活预设目录：内容资产/提示词配置按预设隔离在 presetDir/<template>/。
    () => activePresetDir(),
    (scope) => {
      // 内容导入后：更新运行时文本并重建生成目录。
      if (scope === 'preset') current = readGeneratedContent(activePresetDir(), 'preset.md')
      else currentAgents = readGeneratedContent(activePresetDir(), 'agents.md')
      try {
        rebuildPreset()
      } catch (error) {
        warn(ctx, `prompt-tool: preset import rebuild failed: ${String(error)}`)
      }
    },
    () => {
      // 参数覆盖变更：应用参数并重建。
      try {
        rebuildPreset()
        applyDefaultModel()
      } catch (error) {
        warn(ctx, `prompt-tool: overrides rebuild failed: ${String(error)}`)
      }
    },
    // 预设包导入后物化该预设：组合/配置目录/共享引擎落盘，宿主 discovery 立即可见。
    (id) => {
      try {
        materializeImportedPreset(id)
      } catch (error) {
        warn(ctx, `prompt-tool: imported preset materialize failed: ${String(error)}`)
      }
    },
  )

  // 首次以 base-only profile 启动时自动补 @deepseek-ai/dsh-web-app：
  // 写进 profile bundles（下一次启动由官方装配路径生效），并提示重启。
  setImmediate(() => {
    void ensureWebSurface(ctx, (message) => warn(ctx, message))
  })

  // settings 存储优先于 cordis config：installSettingsSection 注册后立即用
  // settings 的解析值触发一次 onChange，完成初始写入，因此 config 只作 base。
  const runtime: RuntimeOptions = {
    writeAgents: config.writeAgents,
    writePreset: config.writePreset,
    presetTemplate: typeof config.presetTemplate === 'string' && config.presetTemplate.length > 0 ? config.presetTemplate : 'anchored',
    injectAgentsPrompt: config.injectAgentsPrompt,
    skillSwitches: { ...config.skillSwitches },
    skillOrder: [...skillOrder],
    skillsDirs: [...userSkillsDirs],
    // 引擎参数：激活预设 preset.yml（每预设独立，settings 不再承载）。
    firstTurnAnchor: initialParams.firstTurnAnchor === true,
    firstTurnText: asString(initialParams.firstTurnText),
    firstTurnCustom: initialParams.firstTurnCustom === true,
    guideText: asString(initialParams.guideText),
    guideCustom: initialParams.guideCustom === true,
    injectPrompt: initialParams.injectPrompt !== false,
    modelProvider: asString(initialParams.modelProvider),
    modelName: asString(initialParams.modelName),
    subagentModelProvider: asString(initialParams.subagentModelProvider),
    subagentModelName: asString(initialParams.subagentModelName),
    modelReasoningEffort: asString(initialParams.modelReasoningEffort),
    modelTemperature: asString(initialParams.modelTemperature),
    modelMaxTokens: asString(initialParams.modelMaxTokens),
    subagentReasoningEffort: asString(initialParams.subagentReasoningEffort),
    subagentTemperature: asString(initialParams.subagentTemperature),
    subagentMaxTokens: asString(initialParams.subagentMaxTokens),
    bootstrapMaxTokens: Number.isSafeInteger(initialParams.bootstrapMaxTokens) && (initialParams.bootstrapMaxTokens as number) >= 0
      ? initialParams.bootstrapMaxTokens as number
      : 0,
    usePtcMode: typeof initialParams.usePtcMode === 'boolean' ? initialParams.usePtcMode : undefined,
    subagentPersona: asString(initialParams.subagentPersona) || undefined,
    toolFilterAllow: initialParams.toolFilterAllow as string[] | string | undefined,
    toolFilterDeny: initialParams.toolFilterDeny as string[] | string | undefined,
    maxDepth: initialParams.maxDepth as RuntimeOptions['maxDepth'],
    allowKinds: initialParams.allowKinds as string[] | string | undefined,
    firstTurnWord: asString(initialParams.firstTurnWord) || undefined,
    skillRankBase: config.skillRankBase,
    residentAgentsPath: config.residentAgentsPath,
    presetDir: config.presetDir,
    presetOrder: config.presetOrder,
    fallbackText: config.fallbackText,
    promptConfigs: Array.isArray(initialSpec?.promptConfigs) ? initialSpec.promptConfigs as PromptConfigSpec[] : [],
  }

  // 宿主 agent-presets settings `default` 同步：插件 UI 切换预设时把宿主默认预设
  // 设为激活预设（官方机制：新会话按 default 挂载），让插件预设选择真正生效。
  // 迁移场景（旧布局升级）强制同步一次（修复宿主 default 指向已删除的 prompt-tool 容器）。
  let hostSettingsService: SettingsService | undefined
  let lastSyncedHostDefault: string | undefined
  const syncHostDefault = (reason: 'migrate' | 'switch'): void => {
    const s = hostSettingsService
    if (s === undefined) return
    const template = runtime.presetTemplate
    // 官方 agent-presets discovery 只认 /^[a-z0-9][a-z0-9-]*$/ 目录名：非法 id
    // （如含中文）同步进宿主 default 会让官方会话 resume 报 preset not found。
    if (!/^[a-z0-9][a-z0-9-]*$/.test(template)) {
      warn(ctx, `prompt-tool: 预设 id ${JSON.stringify(template)} 不符合官方 agent-presets 命名（^[a-z0-9][a-z0-9-]*$），跳过宿主 default 同步；请将预设目录改名为合法 id`)
      return
    }
    if (reason === 'switch' && lastSyncedHostDefault === template) return
    lastSyncedHostDefault = template
    try {
      s.mutate(settingsNamespace('agent-presets'), [{ op: 'set', path: ['default'], value: template }])
    } catch (error) {
      // 宿主未装配 agent-presets（或文档被锁定）时忽略：插件预设仍可经官方 UI 手动选择。
      warn(ctx, `prompt-tool: 同步宿主 agent-presets default 失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // 模型路由（主对话直派子代理与委派子代理通用）：
  // 宿主直派子代理补子代理固定模型路由（subagentModelProvider + subagentModelName 同时非空时生效）；
  // 调用方显式模型优先，persona 与 toolFilter 保持不变。
  installSubagentModelRoute(
    ctx,
    () => runtime.subagentModelProvider.length > 0 && runtime.subagentModelName.length > 0,
    () => runtime.subagentModelProvider,
    () => runtime.subagentModelName,
  )
  // 主对话默认模型控制：modelProvider + modelName 非空时写入官方 agent-default-model
  // （新会话默认模型；任一为空 = 不干预，继承用户在宿主 web 的选择）。
  const applyDefaultModel = installDefaultModelRoute(
    ctx,
    () => runtime.modelProvider.length > 0 && runtime.modelName.length > 0,
    () => runtime.modelProvider,
    () => runtime.modelName,
    () => runtime.modelReasoningEffort,
  )

  let currentSource = (): PromptSettings => ({
    injectAgentsPrompt: runtime.injectAgentsPrompt,
    modelsAvailable: getModelsState().available,
    skillSwitches: runtime.skillSwitches,
    skillOrder: runtime.skillOrder,
    skillCatalog,
    skillsDirs: runtime.skillsDirs,
    activeSkillsDirs,
    skillsDirExists: Object.fromEntries(activeSkillsDirs.map((dir) => [dir, existsSync(dir)])),
    skillRankBase: runtime.skillRankBase,
    residentAgentsPath: runtime.residentAgentsPath,
    presetDir: runtime.presetDir,
    presetOrder: runtime.presetOrder,
    fallbackText: runtime.fallbackText,
    writeAgents: runtime.writeAgents,
    writePreset: runtime.writePreset,
    presetTemplate: runtime.presetTemplate,
  })

  // dsh-tui 命令入口：/prompt-tool 查看或切换开关。
registerTuiCommand(
  ctx,
  NS,
  () => currentSource(),
  getModelsState,
  () => listAdvertisedModels(ctx),
  () => activePresetDir(),
  // TUI 参数开关：写激活预设 preset.yml（settings 不再承载引擎参数）。
  (key, value) => {
    try {
      if (key === 'promptConfigs') {
        savePresetParams(runtime.presetDir, runtime.presetTemplate, undefined, Array.isArray(value) ? value as unknown[] : undefined)
      } else {
        savePresetParams(runtime.presetDir, runtime.presetTemplate, { [key]: value }, undefined)
      }
      reloadPresetParams()
      rebuildPreset()
    } catch (error) {
      warn(ctx, `prompt-tool: TUI 参数保存失败：${error instanceof Error ? error.message : String(error)}`)
    }
  },
)

  /**
   * 物化导入的预设：用其自身 preset.yml（spec 参数 + modules + promptConfigs）渲染
   * 组合本体 agent.cordis.yml / prompt-configs / 共享引擎，不携带激活预设的
   * settings 参数（导入预设参数自洽；promptConfigs=[] 避免 settings 覆盖层挤掉
   * 导入预设自身配置）。宿主 agent-presets discovery 以 agent.cordis.yml 为准，
   * 不物化则导入的预设从宿主主菜单不可见。
   */
  const materializeImportedPreset = (id: string): void => {
    if (!runtime.writePreset) return
    const options: WritePresetOptions = {
      firstTurnAnchor: false,
      firstTurnText: '',
      firstTurnCustom: false,
      guideText: '',
      guideCustom: false,
      injectPrompt: false,
      modelProvider: '',
      modelName: '',
      subagentModelProvider: '',
      subagentModelName: '',
      subagentPersona: '',
      injectAgentsPrompt: false,
      bootstrapMaxTokens: 0,
      usePtcMode: false,
      presetDir: runtime.presetDir,
      presetOrder: runtime.presetOrder,
      // 导入预设的配置以自身 preset.yml promptConfigs 为准（settings 覆盖层
      // 属于激活预设的编辑上下文，不得污染导入预设）。
      promptConfigs: [],
      presetTemplate: id,
    }
    writePreset('', options)
  }

  let needsInitialApply = true
  const applyState = (): void => {
    const next = currentSource()
    const nextRuntime: Pick<RuntimeOptions,
      'writeAgents' | 'writePreset' | 'presetTemplate' | 'injectAgentsPrompt'
      | 'skillSwitches' | 'skillOrder' | 'skillsDirs' | 'skillRankBase'
      | 'residentAgentsPath' | 'presetDir' | 'presetOrder' | 'fallbackText'> = {
      writeAgents: typeof next.writeAgents === 'boolean' ? next.writeAgents : config.writeAgents,
      writePreset: typeof next.writePreset === 'boolean' ? next.writePreset : config.writePreset,
      presetTemplate: typeof next.presetTemplate === 'string' && next.presetTemplate.length > 0 ? next.presetTemplate : 'anchored',
      injectAgentsPrompt: typeof next.injectAgentsPrompt === 'boolean' ? next.injectAgentsPrompt : config.injectAgentsPrompt,
      skillSwitches: next.skillSwitches !== undefined ? next.skillSwitches : config.skillSwitches,
      skillOrder: Array.isArray(next.skillOrder) ? next.skillOrder.filter((folder): folder is string => typeof folder === 'string') : config.skillOrder,
      skillsDirs: Array.isArray(next.skillsDirs)
        ? next.skillsDirs.filter((dir): dir is string => typeof dir === 'string' && dir.trim().length > 0)
        : userSkillsDirs,
      skillRankBase: Number.isSafeInteger(next.skillRankBase) && next.skillRankBase >= 0 ? next.skillRankBase : config.skillRankBase,
      residentAgentsPath: typeof next.residentAgentsPath === 'string' && next.residentAgentsPath.trim().length > 0 ? next.residentAgentsPath : config.residentAgentsPath,
      presetDir: typeof next.presetDir === 'string' && next.presetDir.trim().length > 0
        ? normalizePresetRootDir(next.presetDir.trim(), DEFAULT_PRESET_DIR, LEGACY_CONTAINER_DIR)
        : config.presetDir,
      presetOrder: Number.isSafeInteger(next.presetOrder) && next.presetOrder >= 0 ? next.presetOrder : config.presetOrder,
      fallbackText: typeof next.fallbackText === 'string' ? next.fallbackText : config.fallbackText,
    }
    const skillSwitchesChanged = JSON.stringify(runtime.skillSwitches) !== JSON.stringify(nextRuntime.skillSwitches)
    const skillOrderChanged = JSON.stringify(runtime.skillOrder) !== JSON.stringify(nextRuntime.skillOrder)
    const skillsDirsChanged = JSON.stringify(runtime.skillsDirs) !== JSON.stringify(nextRuntime.skillsDirs)
    const skillRankBaseChanged = runtime.skillRankBase !== nextRuntime.skillRankBase
    const fallbackTextChanged = runtime.fallbackText !== nextRuntime.fallbackText
    const presetTemplateChanged = runtime.presetTemplate !== nextRuntime.presetTemplate
    const settingsChanged = runtime.writeAgents !== nextRuntime.writeAgents
      || runtime.writePreset !== nextRuntime.writePreset
      || runtime.presetTemplate !== nextRuntime.presetTemplate
      || runtime.injectAgentsPrompt !== nextRuntime.injectAgentsPrompt
      || skillSwitchesChanged
      || skillOrderChanged
      || skillsDirsChanged
      || skillRankBaseChanged
      || runtime.residentAgentsPath !== nextRuntime.residentAgentsPath
      || runtime.presetDir !== nextRuntime.presetDir
      || runtime.presetOrder !== nextRuntime.presetOrder
      || fallbackTextChanged
    // 首次必须写入：settings 与文件/config 一致时也不能跳过 preset/AGENTS 生成。
    if (!needsInitialApply && !settingsChanged) return
    needsInitialApply = false

    // 切换预设：内容资产从新预设目录/模板重读——否则 rebuildPreset 会把旧预设的
    // preset.md/agents.md 内容复制进新预设（custom 空白预设被写入 anchored 文本）。
    if (presetTemplateChanged) {
      const newDir = join(nextRuntime.presetDir, /^[a-zA-Z0-9\u4e00-\u9fff_-]+$/.test(nextRuntime.presetTemplate) ? nextRuntime.presetTemplate : 'anchored')
      current = readGeneratedContent(newDir, 'preset.md') || readPromptFile(nextRuntime.presetTemplate, nextRuntime.fallbackText)
      currentAgents = readGeneratedContent(newDir, 'agents.md') || readAgents(nextRuntime.presetTemplate)
    }
    runtime.writeAgents = nextRuntime.writeAgents
    runtime.writePreset = nextRuntime.writePreset
    runtime.presetTemplate = nextRuntime.presetTemplate
    runtime.injectAgentsPrompt = nextRuntime.injectAgentsPrompt
    runtime.skillSwitches = nextRuntime.skillSwitches
    runtime.skillOrder = nextRuntime.skillOrder
    runtime.skillsDirs = nextRuntime.skillsDirs
    runtime.skillRankBase = nextRuntime.skillRankBase
    runtime.residentAgentsPath = nextRuntime.residentAgentsPath
    runtime.presetDir = nextRuntime.presetDir
    runtime.presetOrder = nextRuntime.presetOrder
    runtime.fallbackText = nextRuntime.fallbackText
    skillSwitches = runtime.skillSwitches
    skillOrder = runtime.skillOrder
    skillRankBase = runtime.skillRankBase
    if (skillsDirsChanged) {
      applyActiveSkillsDirs(resolveActiveSkillsDirs(runtime.skillsDirs))
      cachedSkills.invalidate(); invalidateSkills?.()
    } else if (skillSwitchesChanged || skillOrderChanged || skillRankBaseChanged) {
      cachedSkills.invalidate(); invalidateSkills?.()
    }

    let residentAgentsWritten = false
    if (runtime.writeAgents) {
      residentAgentsWritten = writeAgents(currentAgents, runtime.residentAgentsPath)
      if (!residentAgentsWritten) {
        warn(ctx, `prompt-tool: failed to write resident rules to ${runtime.residentAgentsPath}`)
      }
    } else {
      residentAgentsWritten = removeResidentAgentsBlock(runtime.residentAgentsPath)
      if (!residentAgentsWritten) {
        warn(ctx, `prompt-tool: failed to remove resident rules block from ${runtime.residentAgentsPath}`)
      }
    }
    rebuildPreset()
    if (presetTemplateChanged) syncHostDefault('switch')
  }

  // 角色卡库模型工具：会话中直接导入/应用/移除角色卡（与 UI 角色管理页同源）。
  registerCharacterTools(ctx, {
    presetRoot: () => dirname(activePresetDir()),
    templateName: () => basename(activePresetDir()),
    rebuild: () => {
      try {
        rebuildPreset()
      } catch (error) {
        warn(ctx, `prompt-tool: character tool rebuild failed: ${String(error)}`)
      }
    },
  })
  // 世界书条目级工具：当前预设 world-book 配置的增删改。
  registerWorldBookTools(ctx, {
    activeDir: () => activePresetDir(),
    presetRoot: () => dirname(activePresetDir()),
    rebuild: () => {
      try {
        rebuildPreset()
      } catch (error) {
        warn(ctx, `prompt-tool: world-book tool rebuild failed: ${String(error)}`)
      }
    },
  })
  // 会话变量工具：模型维护 ST getvar/setvar 语义的会话状态（{{key}} 运行时覆盖）。
  registerSessionVarTools(ctx)

  // settings 注册 base 与运行时快照同源（单一组装，避免双份字段漂移）。
  const settingsEntry: PromptSettings = currentSource()

  // 幂等注册 + 自愈：settings 服务实例被替换（provider fiber reload）时，
  // 官方 installSettingsSection 的一次性 inject 回调不会重跑，注册随之丢失，
  // Web 保存报「settings namespace "prompt-tool" is not registered」。
  // bridge 每次请求前经此兜底自愈，坏数据修复后的下次请求同样自动恢复。
  const ensureRegistered = (sctx: Context): boolean => ensureSettingsRegistered(sctx, NS, PromptSettingsSchema, {
    base: () => settingsEntry,
    onRegistered: (scope) => {
      currentSource = () => scope.get()
      scope.watch(() => {
        try {
          applyState()
        } catch (error) {
          warn(ctx, `prompt-tool: applyState failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      })
      // 注册后立即用 settings 解析值触发一次初始写入（settings 优先于 cordis config）。
      try {
        applyState()
      } catch (error) {
        warn(ctx, `prompt-tool: applyState failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    },
    onError: (message) => warn(ctx, `prompt-tool: settings register failed: ${message}`),
  })

  /** 阶段 2 迁移：旧全局 settings 引擎参数 → 激活预设 preset.yml（一次性，state.paramsMigrated 后跳过）。
   *  兼容旧版预设根内 .pt-params-migrated 标记：存在即视为已迁移，并迁入状态文件后删除。 */
  const migrateSettingsParamsToPreset = (sctx: Context): void => {
    const legacyMark = join(runtime.presetDir, '.pt-params-migrated')
    const state = readPluginState()
    if (state.paramsMigrated === true || existsSync(legacyMark)) {
      if (existsSync(legacyMark)) {
        try {
          writePluginState({ ...state, paramsMigrated: true })
          rmSync(legacyMark, { force: true })
        } catch {
          // 旧标记迁移失败不阻断（下次启动重试）。
        }
      }
      return
    }
    let userSection: Record<string, unknown> = {}
    try {
      const descriptor = sctx.settings.describe({ redactSecrets: true })
        .find((entry) => String(entry.ns) === String(NS))
      // 官方 describe：value = schema 解析后的 resolved 值（参数键删除后不含旧参数），
      // user = 原始文档 user section（含旧版全局参数键）——迁移必须读 user。
      userSection = descriptor?.user !== null && typeof descriptor?.user === 'object'
        ? descriptor.user as Record<string, unknown>
        : descriptor?.value !== null && typeof descriptor?.value === 'object'
          ? descriptor.value as Record<string, unknown>
          : {}
    } catch {
      // describe 失败（settings 服务不可用）跳过，下次启动重试。
      return
    }
    const params: Record<string, unknown> = {}
    for (const key of PARAM_KEYS) {
      if (key !== 'promptConfigs' && Object.prototype.hasOwnProperty.call(userSection, key)) {
        params[key] = userSection[key]
      }
    }
    const promptConfigs = Array.isArray(userSection.promptConfigs)
      ? userSection.promptConfigs as unknown[]
      : undefined
    if (Object.keys(params).length === 0 && promptConfigs === undefined) {
      try {
        mkdirSync(runtime.presetDir, { recursive: true })
        writePluginState({ ...readPluginState(), paramsMigrated: true })
      } catch {
        // 状态写入失败忽略（下次启动重试）。
      }
      return
    }
    try {
      // 旧版参数是全局单文档（切换任何预设都生效）：写全部插件格式预设
      // （含 modules/params 段的种子化模板），保持旧语义；官方格式预设
      // （无 modules/params，组合直接挂载）跳过——不往用户手动建的预设注入参数。
      let written = 0
      for (const preset of listPresets()) {
        try {
          const spec = loadPresetSpec(resolvePresetDir(preset.id))
          const isPluginFormat = Array.isArray(spec.modules)
            || (spec.params !== null && typeof spec.params === 'object')
          if (!isPluginFormat) continue
          savePresetParams(runtime.presetDir, preset.id, params, promptConfigs)
          written++
        } catch {
          // 单个预设写入失败不阻断其余（下次启动重试）。
        }
      }
      if (written === 0) {
        writePluginState({ ...readPluginState(), paramsMigrated: true })
        return
      }
      reloadPresetParams()
      rebuildPreset()
      writePluginState({ ...readPluginState(), paramsMigrated: true })
      warn(ctx, `prompt-tool: 已把旧全局 settings 参数迁移到 ${written} 个预设 preset.yml（每预设独立存储）`)
    } catch (error) {
      warn(ctx, `prompt-tool: settings 参数迁移失败（下次启动重试）：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  ctx.inject(['settings'], (sctx: Context) => {
    hostSettingsService = sctx.settings
    ensureRegistered(sctx)
    // 旧布局迁移完成（或宿主 default 指向已删除的 prompt-tool 容器）时同步宿主默认预设。
    if (legacyMigrated) syncHostDefault('migrate')
    // 阶段 2 迁移：旧全局 settings 参数 → 激活预设 preset.yml。
    migrateSettingsParamsToPreset(sctx)
    // settings 服务 detach 时回退到 cordis config 构造的 entry，
    // 并重判派生状态（等价 installSettingsSection 的 fallback 语义）。
    sctx.effect(() => () => {
      currentSource = () => settingsEntry
      try {
        applyState()
      } catch (error) {
        warn(ctx, `prompt-tool: applyState failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
  })
}

// 公共 API：宿主与测试复用 settings schema 与提示词配置权威校验。
export { Config, PromptSettingsSchema } from './config.ts'
export { writePreset } from './host/write-preset.ts'
export { stPresetId } from './host/sillytavern.ts'
export { applyModuleConfigs, savePresetParams } from './host/manifest.ts'
export { loadPresetSpec, resolvePresetParams } from './host/manifest.ts'
export type { PresetSpec } from './host/manifest.ts'
export {
  cloneBuiltinPreset,
  ensurePresetSeed,
  listBuiltinTemplates,
  listPresets,
  readPluginState,
  removeUserPreset,
  resolvePresetDir,
  userPresetsDir,
  writePluginState,
} from './host/manifest.ts'
export { ensureWebSurface, resolveProfileDir } from './web-surface.ts'
export { resolveProfileSkillsDir } from './profile-skills.ts'
export { migrateLegacyLayout, normalizePresetRootDir } from './host/migration.ts'
export { detectModels, installDefaultModelRoute, listAdvertisedModels } from './runtime/models.ts'
export type { WritePresetOptions } from './host/write-preset.ts'
export { validatePromptConfigs } from './runtime/configs-validate.ts'
export { registerSettingsBridge } from './runtime/settings-bridge.ts'
export { registerCharacterTools } from './runtime/character-tools.ts'
export { registerWorldBookTools } from './runtime/world-book-tools.ts'
export type { PromptConfigValidationError, PromptConfigValidationResult } from './runtime/configs-validate.ts'
export { loadPromptTemplates } from './host/templates.ts'
export type { PromptConfigTemplate } from './host/templates.ts'
export { registerTuiCommand } from './runtime/tui.ts'
export { ensureSettingsRegistered } from './runtime/settings-registration.ts'
export type { SettingsRegistrationHooks } from './runtime/settings-registration.ts'
export { createCachedSkillsReader, readSkills, mergeSkillDirs, listSkillFolders, isValidSkill, validSkills, SKILL_NAME_RE } from './runtime/skills-provider.ts'
export type { CachedSkillsReader } from './runtime/skills-provider.ts'
export { fixSkillEntry, toKebabName } from './runtime/skill-fix.ts'
export type { SkillFixResult } from './runtime/skill-fix.ts'
export { PARAM_KEYS } from './config.ts'
export type { SkillEntry, SkillCatalogEntry } from './config.ts'
export { BRIDGE_ENDPOINTS, SETTINGS_BRIDGE_PREFIX } from './shared/bridge-contract.ts'
export type { BridgeEndpoint, BridgeErrorPayload } from './shared/bridge-contract.ts'
export { parseFrontmatter } from './runtime/skills-parse.ts'
export type { SkillFrontmatter } from './runtime/skills-parse.ts'
