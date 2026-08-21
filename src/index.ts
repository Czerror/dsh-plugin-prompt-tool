import type { Context } from '@deepseek-ai/cordis'
import type {
  SkillCandidate,
  SkillDefinition,
  SkillLookupOptions,
  SkillProvider,
  SkillProviderControl,
} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'
import { createSkillsWatcher } from './runtime/skills-watcher.ts'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { loadPresetContent, loadPresetSpec, normalizeParam, resolvePresetDir } from './host/manifest.ts'
import type { PresetSpec } from './host/manifest.ts'
import { createCachedSkillsReader, mergeSkillDirs } from './runtime/skills-provider.ts'
import { ensureWebSurface } from './web-surface.ts'
import { resolveProfileSkillsDir } from './profile-skills.ts'
import { detectModels, installDefaultModelRoute, installSubagentModelRoute, listAdvertisedModels } from './runtime/models.ts'
import type { ModelDetection } from './runtime/models.ts'
import { registerSettingsBridge } from './runtime/settings-bridge.ts'
import { registerTuiCommand } from './runtime/tui.ts'
import { ensureSettingsRegistered } from './runtime/settings-registration.ts'
import { removeResidentAgentsBlock, writeAgents } from './runtime/agents-file.ts'
import { writePreset } from './host/write-preset.ts'
import {
  Config,
  NS,
  PromptSettings,
  PromptSettingsSchema,
  RuntimeOptions,
  SkillCatalogEntry,
  SkillEntry,
} from './config.ts'
import { DEFAULT_SKILLS_DIR, DSH_HOME } from './host/paths.ts'

export const name = 'prompt-tool'
// 内容走 user 层（AGENTS.md 常驻层 + skill 按需层），
// 不再注册 system prompt section（否则会被 persona 的 complete:true 整个清零）。
// 注意：webServer 不放在静态 inject 里——profile 首次可能只有
// @deepseek-ai/dsh-base（没有 @deepseek-ai/dsh-web-app），硬注入会让插件
// pending 并导致启动失败。Web 表面改为动态等待 webServer；首次启动时由
// ensureWebSurface 自动把 web-app bundle 补进 profile，重启一次后生效。
export const inject = ['skills', 'commands', 'llm', 'subagents']

/** 内容资产统一从预设模板的单一参数 YAML 读取(preset/anchored/preset.yml)。 */
const PRESET_FILE_URL = new URL('../preset/anchored/preset.yml', import.meta.url)
const PRESET_FILE_PATH = fileURLToPath(PRESET_FILE_URL)
const AGENTS_FILE_PATH = PRESET_FILE_PATH

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

/** hostDefaults 中的路径类字段展开 ~/，避免把字面量 `~` 目录写进进程 cwd。
 *  `~/.dsh/...` 特指 Harness home（${DSH_HOME} 或默认 ~/.dsh），
 *  其余 `~/...` 才按操作系统 home 展开。 */
const HOME_PATH_KEYS = new Set(['residentAgentsPath', 'presetDir', 'skillsDir', 'skillsDirs'])
const DSH_HOME_PREFIX = '~/.dsh'
function normalizePresetPath(key: string, value: unknown): unknown {
  if (Array.isArray(value) && key === 'skillsDirs') {
    return value.map((item) => normalizePresetPath('skillsDir', item))
  }
  if (typeof value !== 'string' || !HOME_PATH_KEYS.has(key)) return value
  if (value === DSH_HOME_PREFIX) return DSH_HOME
  if (value.startsWith(DSH_HOME_PREFIX + '/') || value.startsWith(DSH_HOME_PREFIX + '\\')) {
    const suffix = value.slice(DSH_HOME_PREFIX.length).replace(/^[/\\]+/, '')
    return suffix.length > 0 ? join(DSH_HOME, suffix) : DSH_HOME
  }
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2))
  return value
}

/**
 * 单一入口:preset.yml 的 params + hostDefaults 作为 Config 的预设默认值。
 * settings(用户/Web)仍优先;此处只覆盖 Config 未提供或默认值位置。
 */
export function mergePresetDefaults<T extends Config>(config: T, spec: PresetSpec | undefined): T {
  if (spec === undefined) return config
  const merged: Record<string, unknown> = { ...config } as Record<string, unknown>
  const source = config as unknown as Record<string, unknown>
  const entries = { ...spec.params, ...spec.hostDefaults }
  for (const [key, raw] of Object.entries(entries)) {
    if (!(key in source)) continue
    const value = normalizePresetPath(key, normalizeParam(raw))
    const current = source[key]
    if (typeof current === 'boolean') {
      if (typeof value === 'boolean') merged[key] = value
    } else if (typeof current === 'number') {
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) merged[key] = value
    } else if (typeof current === 'string') {
      if (typeof value === 'string') merged[key] = value
    } else if (Array.isArray(current)) {
      if (Array.isArray(value)) merged[key] = value
    } else if (typeof current === 'object' && current !== null) {
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) merged[key] = value
    }
  }
  return merged as unknown as T
}


export function apply(ctx: Context, configIn: Config): void {
  // 唯一入口:preset.yml 的参数与 hostDefaults 合并进 Config 默认值。
  let presetSpec: PresetSpec | undefined
  try {
    presetSpec = loadPresetSpec(resolvePresetDir('anchored'))
  } catch (error) {
    warn(ctx, `prompt-tool: preset.yml unavailable, falling back to cordis config: ${error instanceof Error ? error.message : String(error)}`)
  }
  const config = mergePresetDefaults(configIn, presetSpec)
  const modelsState = (): ModelDetection => detectModels(ctx)
  const getModelsState = (): ModelDetection => modelsState()
  // 内容资产优先读生成目录文件（writePreset 落盘），模板 content 作回退；
  // settings.yaml 不再承载大文本（web 打开加载慢的根因）。
  const initialTemplate = typeof config.presetTemplate === 'string' && config.presetTemplate.length > 0
    ? config.presetTemplate
    : 'anchored'
  // 预设分离：生成内容按预设隔离在 presetDir/<template>/ 子目录（容器根只有薄转发）。
  const initialPresetDir = join(config.presetDir, /^[a-zA-Z0-9_-]+$/.test(initialTemplate) ? initialTemplate : 'anchored')
  let current = readGeneratedContent(initialPresetDir, 'preset.md') || readPromptFile(initialTemplate, config.fallbackText)
  let currentAgents = readGeneratedContent(initialPresetDir, 'agents.md') || readAgents(initialTemplate)

  /** 重建生成目录（文本/组合/引擎/提示词配置）；writePreset 关闭时移除旧目录。 */
  const rebuildPreset = (): void => {
    applyParamOverrides()
    if (runtime.writePreset) {
      const presetPrompt = runtime.injectPrompt && current.length > 0 ? current : ''
      writePreset(presetPrompt, {
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
        mainPersona: runtime.mainPersona,
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
      })
    } else {
      // writePreset 关闭时移除旧的生成目录，避免残留 prompt-injector 继续注入。
      try {
        rmSync(runtime.presetDir, { recursive: true, force: true })
      } catch (error) {
        warn(ctx, 'prompt-tool: failed to remove ' + runtime.presetDir + ': ' + String(error))
      }
    }
  }

  /** 激活子预设目录（预设分离后内容按 presetDir/<template>/ 隔离；非法名回退 anchored）。 */
  const activePresetDir = (): string =>
    join(runtime.presetDir, /^[a-zA-Z0-9_-]+$/.test(runtime.presetTemplate) ? runtime.presetTemplate : 'anchored')

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
    // mainPersona 引擎必需非空：历史 overrides 里的空串直接忽略（保留模板默认）。
    if (typeof overrides.mainPersona === 'string' && overrides.mainPersona.trim().length > 0) {
      runtime.mainPersona = overrides.mainPersona
    }
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
    // 生成目录（激活子预设）：预设分离后容器根只有薄转发，内容资产/提示词配置
    // 按预设隔离在 presetDir/<template>/ 子目录。
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
    injectPrompt: config.injectPrompt,
    skillSwitches: { ...config.skillSwitches },
    skillOrder: [...skillOrder],
    skillsDirs: [...userSkillsDirs],
    firstTurnAnchor: config.firstTurnAnchor,
    firstTurnText: config.firstTurnText,
    firstTurnCustom: config.firstTurnCustom,
    guideText: config.guideText,
    guideCustom: config.guideCustom,
    modelProvider: config.modelProvider,
    modelName: config.modelName,
    subagentModelProvider: config.subagentModelProvider,
    subagentModelName: config.subagentModelName,
    modelReasoningEffort: config.modelReasoningEffort,
    modelTemperature: config.modelTemperature,
    modelMaxTokens: config.modelMaxTokens,
    subagentReasoningEffort: config.subagentReasoningEffort,
    subagentTemperature: config.subagentTemperature,
    subagentMaxTokens: config.subagentMaxTokens,
    bootstrapMaxTokens: config.bootstrapMaxTokens,
    usePtcMode: config.usePtcMode,
    skillRankBase: config.skillRankBase,
    residentAgentsPath: config.residentAgentsPath,
    presetDir: config.presetDir,
    presetOrder: config.presetOrder,
    fallbackText: config.fallbackText,
    promptConfigs: Array.isArray(config.promptConfigs) ? config.promptConfigs : [],
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
  )

  let currentSource = (): PromptSettings => ({
    promptText: current,
    promptPath: PRESET_FILE_PATH,
    agentsText: currentAgents,
    agentsPath: AGENTS_FILE_PATH,
    injectAgentsPrompt: runtime.injectAgentsPrompt,
    firstTurnAnchor: runtime.firstTurnAnchor,
    firstTurnText: runtime.firstTurnText,
    firstTurnCustom: runtime.firstTurnCustom,
    guideText: runtime.guideText,
    guideCustom: runtime.guideCustom,
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
    bootstrapMaxTokens: runtime.bootstrapMaxTokens,
    usePtcMode: runtime.usePtcMode,
    modelsAvailable: getModelsState().available,
    injectPrompt: runtime.injectPrompt,
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
    promptConfigs: runtime.promptConfigs,
  })

  // dsh-tui 命令入口：/prompt-tool 查看或切换开关。
registerTuiCommand(ctx, NS, () => currentSource(), getModelsState, () => listAdvertisedModels(ctx), () => runtime.presetDir)

  let needsInitialApply = true
  const applyState = (): void => {
    const next = currentSource()
    const nextRuntime: RuntimeOptions = {
      writeAgents: typeof next.writeAgents === 'boolean' ? next.writeAgents : config.writeAgents,
      writePreset: typeof next.writePreset === 'boolean' ? next.writePreset : config.writePreset,
      presetTemplate: typeof next.presetTemplate === 'string' && next.presetTemplate.length > 0 ? next.presetTemplate : 'anchored',
      injectAgentsPrompt: typeof next.injectAgentsPrompt === 'boolean' ? next.injectAgentsPrompt : config.injectAgentsPrompt,
      injectPrompt: typeof next.injectPrompt === 'boolean' ? next.injectPrompt : config.injectPrompt,
      skillSwitches: next.skillSwitches !== undefined ? next.skillSwitches : config.skillSwitches,
      skillOrder: Array.isArray(next.skillOrder) ? next.skillOrder.filter((folder): folder is string => typeof folder === 'string') : config.skillOrder,
      skillsDirs: Array.isArray(next.skillsDirs)
        ? next.skillsDirs.filter((dir): dir is string => typeof dir === 'string' && dir.trim().length > 0)
        : userSkillsDirs,
      firstTurnAnchor: typeof next.firstTurnAnchor === 'boolean' ? next.firstTurnAnchor : config.firstTurnAnchor,
      firstTurnText: typeof next.firstTurnText === 'string' ? next.firstTurnText : config.firstTurnText,
      firstTurnCustom: typeof next.firstTurnCustom === 'boolean' ? next.firstTurnCustom : config.firstTurnCustom,
      guideText: typeof next.guideText === 'string' ? next.guideText : config.guideText,
      guideCustom: typeof next.guideCustom === 'boolean' ? next.guideCustom : config.guideCustom,
      modelProvider: typeof next.modelProvider === 'string' ? next.modelProvider : config.modelProvider,
      modelName: typeof next.modelName === 'string' ? next.modelName : config.modelName,
      subagentModelProvider: typeof next.subagentModelProvider === 'string' ? next.subagentModelProvider : config.subagentModelProvider,
      subagentModelName: typeof next.subagentModelName === 'string' ? next.subagentModelName : config.subagentModelName,
      modelReasoningEffort: typeof next.modelReasoningEffort === 'string' ? next.modelReasoningEffort : config.modelReasoningEffort,
      modelTemperature: typeof next.modelTemperature === 'string' ? next.modelTemperature : config.modelTemperature,
      modelMaxTokens: typeof next.modelMaxTokens === 'string' ? next.modelMaxTokens : config.modelMaxTokens,
      subagentReasoningEffort: typeof next.subagentReasoningEffort === 'string' ? next.subagentReasoningEffort : config.subagentReasoningEffort,
      subagentTemperature: typeof next.subagentTemperature === 'string' ? next.subagentTemperature : config.subagentTemperature,
      subagentMaxTokens: typeof next.subagentMaxTokens === 'string' ? next.subagentMaxTokens : config.subagentMaxTokens,
      bootstrapMaxTokens: Number.isSafeInteger(next.bootstrapMaxTokens) && next.bootstrapMaxTokens >= 0 ? next.bootstrapMaxTokens : config.bootstrapMaxTokens,
      usePtcMode: typeof next.usePtcMode === 'boolean' ? next.usePtcMode : config.usePtcMode,
      skillRankBase: Number.isSafeInteger(next.skillRankBase) && next.skillRankBase >= 0 ? next.skillRankBase : config.skillRankBase,
      residentAgentsPath: typeof next.residentAgentsPath === 'string' && next.residentAgentsPath.trim().length > 0 ? next.residentAgentsPath : config.residentAgentsPath,
      presetDir: typeof next.presetDir === 'string' && next.presetDir.trim().length > 0 ? next.presetDir : config.presetDir,
      presetOrder: Number.isSafeInteger(next.presetOrder) && next.presetOrder >= 0 ? next.presetOrder : config.presetOrder,
      fallbackText: typeof next.fallbackText === 'string' ? next.fallbackText : config.fallbackText,
      promptConfigs: Array.isArray(next.promptConfigs) ? next.promptConfigs : config.promptConfigs,
    }
    const promptChanged = next.promptText !== current
    const agentsChanged = next.agentsText !== currentAgents
    const skillSwitchesChanged = JSON.stringify(runtime.skillSwitches) !== JSON.stringify(nextRuntime.skillSwitches)
    const skillOrderChanged = JSON.stringify(runtime.skillOrder) !== JSON.stringify(nextRuntime.skillOrder)
    const skillsDirsChanged = JSON.stringify(runtime.skillsDirs) !== JSON.stringify(nextRuntime.skillsDirs)
    const skillRankBaseChanged = runtime.skillRankBase !== nextRuntime.skillRankBase
    const fallbackTextChanged = runtime.fallbackText !== nextRuntime.fallbackText
    const settingsChanged = runtime.writeAgents !== nextRuntime.writeAgents
      || runtime.writePreset !== nextRuntime.writePreset
      || runtime.presetTemplate !== nextRuntime.presetTemplate
      || runtime.injectAgentsPrompt !== nextRuntime.injectAgentsPrompt
      || runtime.injectPrompt !== nextRuntime.injectPrompt
      || skillSwitchesChanged
      || skillOrderChanged
      || skillsDirsChanged
      || skillRankBaseChanged
      || runtime.firstTurnAnchor !== nextRuntime.firstTurnAnchor
      || runtime.firstTurnText !== nextRuntime.firstTurnText
      || runtime.firstTurnCustom !== nextRuntime.firstTurnCustom
      || runtime.guideText !== nextRuntime.guideText
      || runtime.guideCustom !== nextRuntime.guideCustom
      || runtime.modelProvider !== nextRuntime.modelProvider
      || runtime.modelName !== nextRuntime.modelName
      || runtime.subagentModelProvider !== nextRuntime.subagentModelProvider
      || runtime.subagentModelName !== nextRuntime.subagentModelName
      || runtime.bootstrapMaxTokens !== nextRuntime.bootstrapMaxTokens
      || runtime.usePtcMode !== nextRuntime.usePtcMode
      || runtime.residentAgentsPath !== nextRuntime.residentAgentsPath
      || runtime.presetDir !== nextRuntime.presetDir
      || runtime.presetOrder !== nextRuntime.presetOrder
      || fallbackTextChanged
      || JSON.stringify(runtime.promptConfigs) !== JSON.stringify(nextRuntime.promptConfigs)
    // 首次必须写入：settings 与文件/config 一致时也不能跳过 preset/AGENTS 生成。
    if (!needsInitialApply && !promptChanged && !agentsChanged && !settingsChanged) return
    needsInitialApply = false

    // settings.promptText 为空时保留生成目录/模板内容（大文本不再写入 settings，
    // 显式非空文本仍作为运行时覆盖生效）。
    if (promptChanged && next.promptText.trim().length > 0) current = next.promptText
    if (fallbackTextChanged && next.promptText.trim() === '' && current.trim() === '') {
      current = readPromptFile(nextRuntime.presetTemplate, nextRuntime.fallbackText)
    }
    if (agentsChanged && next.agentsText.trim().length > 0) currentAgents = next.agentsText
    runtime.writeAgents = nextRuntime.writeAgents
    runtime.writePreset = nextRuntime.writePreset
    runtime.presetTemplate = nextRuntime.presetTemplate
    runtime.injectAgentsPrompt = nextRuntime.injectAgentsPrompt
    runtime.injectPrompt = nextRuntime.injectPrompt
    runtime.skillSwitches = nextRuntime.skillSwitches
    runtime.skillOrder = nextRuntime.skillOrder
    runtime.skillsDirs = nextRuntime.skillsDirs
    runtime.firstTurnAnchor = nextRuntime.firstTurnAnchor
    runtime.firstTurnText = nextRuntime.firstTurnText
    runtime.firstTurnCustom = nextRuntime.firstTurnCustom
    runtime.guideText = nextRuntime.guideText
    runtime.guideCustom = nextRuntime.guideCustom
    runtime.modelProvider = nextRuntime.modelProvider
    runtime.modelName = nextRuntime.modelName
    runtime.subagentModelProvider = nextRuntime.subagentModelProvider
    runtime.subagentModelName = nextRuntime.subagentModelName
    runtime.bootstrapMaxTokens = nextRuntime.bootstrapMaxTokens
    runtime.usePtcMode = nextRuntime.usePtcMode
    runtime.skillRankBase = nextRuntime.skillRankBase
    runtime.residentAgentsPath = nextRuntime.residentAgentsPath
    runtime.presetDir = nextRuntime.presetDir
    runtime.presetOrder = nextRuntime.presetOrder
    runtime.fallbackText = nextRuntime.fallbackText
    runtime.promptConfigs = nextRuntime.promptConfigs
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
  }

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
  ctx.inject(['settings'], (sctx: Context) => {
    ensureRegistered(sctx)
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
export { applyModuleConfigs } from './host/manifest.ts'
export { loadPresetSpec, resolvePresetParams } from './host/manifest.ts'
export type { PresetSpec } from './host/manifest.ts'
export { listPresets, resolvePresetDir, userPresetsDir } from './host/manifest.ts'
export { ensureWebSurface, resolveProfileDir } from './web-surface.ts'
export { resolveProfileSkillsDir } from './profile-skills.ts'
export { detectModels, installDefaultModelRoute } from './runtime/models.ts'
export type { WritePresetOptions } from './host/write-preset.ts'
export { validatePromptConfigs } from './runtime/configs-validate.ts'
export { registerSettingsBridge } from './runtime/settings-bridge.ts'
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
export type { SkillEntry, SkillCatalogEntry } from './config.ts'
export { BRIDGE_ENDPOINTS, SETTINGS_BRIDGE_PREFIX } from './shared/bridge-contract.ts'
export type { BridgeEndpoint, BridgeErrorPayload } from './shared/bridge-contract.ts'
export { parseFrontmatter } from './runtime/skills-parse.ts'
export type { SkillFrontmatter } from './runtime/skills-parse.ts'
