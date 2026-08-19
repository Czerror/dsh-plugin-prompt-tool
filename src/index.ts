import type { Context } from '@deepseek-ai/cordis'
import type {
  SkillCandidate,
  SkillDefinition,
  SkillLookupOptions,
  SkillProvider,
  SkillProviderControl,
} from '@deepseek-ai/dsh-skill'
import type { SettingsPathOp } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { rmSync } from 'node:fs'
import { createSkillsWatcher } from './runtime/skills-watcher.ts'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { loadPresetContent, loadPresetSpec, normalizeParam, packagePresetDir } from './host/manifest.ts'
import type { PresetSpec } from './host/manifest.ts'
import { createCachedSkillsReader } from './runtime/skills-provider.ts'
import { ensureWebSurface } from './web-surface.ts'
import { resolveProfileSkillsDir } from './profile-skills.ts'
import { detectDeepseek, installSubagentFlashRoute } from './runtime/deepseek.ts'
import type { DeepseekDetection } from './runtime/deepseek.ts'
import { registerSettingsBridge } from './runtime/settings-bridge.ts'
import { registerTuiCommand } from './runtime/tui.ts'
import { ensureSettingsRegistered } from './runtime/settings-registration.ts'
import { removeResidentAgentsBlock, writeAgents } from './runtime/agents-file.ts'
import { writePreset } from './host/write-preset.ts'
import {
  Config,
  NS,
  normalizeFirstTurnText,
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

function readPromptFile(fallbackText: string): string {
  const text = loadPresetContent().presetText
  return text.length > 0 ? text : fallbackText
}

function readAgents(): string {
  return loadPresetContent().agentsText
}

interface ProjectOriginals {
  presetText: string
  agentsText: string
}

/** 直接读取预设模板单一参数 YAML 的 content 字段；宿主不再回写模板文件。 */
function readProjectOriginals(): ProjectOriginals {
  return { presetText: readPromptFile(''), agentsText: readAgents() }
}

/** 首次安装时，把项目文件内容作为 user 层种子写入 settings.yaml；已有字段不覆盖。 */
function seedSettingsOnce(ctx: Context, originals: ProjectOriginals): void {
  ctx.inject(['settings'], (sctx: Context) => {
    void (async () => {
      try {
        const descriptor = sctx.settings.describe({ redactSecrets: true })
          .find((entry) => String(entry.ns) === String(NS))
        if (descriptor === undefined) return
        const user = descriptor.user !== null && typeof descriptor.user === 'object'
          ? descriptor.user as Record<string, unknown>
          : {}
        const ops: SettingsPathOp[] = []
        if (typeof user.promptText !== 'string') ops.push({ op: 'set', path: ['promptText'], value: originals.presetText })
        if (typeof user.agentsText !== 'string') ops.push({ op: 'set', path: ['agentsText'], value: originals.agentsText })
        if (ops.length === 0) return
        await sctx.settings.mutate(NS, ops)
      } catch (error) {
        warn(ctx, `prompt-tool: failed to seed settings from project files: ${error instanceof Error ? error.message : String(error)}`)
      }
    })()
  })
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
const HOME_PATH_KEYS = new Set(['residentAgentsPath', 'presetDir', 'skillsDir'])
const DSH_HOME_PREFIX = '~/.dsh'
function normalizePresetPath(key: string, value: unknown): unknown {
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
    presetSpec = loadPresetSpec(join(packagePresetDir(), 'anchored'))
  } catch (error) {
    warn(ctx, `prompt-tool: preset.yml unavailable, falling back to cordis config: ${error instanceof Error ? error.message : String(error)}`)
  }
  const config = mergePresetDefaults(configIn, presetSpec)
  const deepseekState = (): DeepseekDetection => detectDeepseek(ctx)
  const getDeepseekAvailable = (): boolean => deepseekState().available
  const getDeepseekState = (): DeepseekDetection => deepseekState()
  let current = config.text || readPromptFile(config.fallbackText)
  let currentAgents = config.agentsText || readAgents()
  // 首次启动把包内 skills/ 增量复制到 $DSH_HOME/profiles/<profile>/skills，
  // 并优先使用 profile 副本；已有同名文件不覆盖，用户编辑会保留。
  // 显式配置了其他 skillsDir 时尊重用户选择，不做复制。
  const configuredSkillsDir = config.skillsDir !== DEFAULT_SKILLS_DIR && config.skillsDir.length > 0
    ? config.skillsDir
    : ''
  let activeSkillsDir = configuredSkillsDir.length > 0
    ? configuredSkillsDir
    : resolveProfileSkillsDir(ctx, DEFAULT_SKILLS_DIR, (message) => warn(ctx, message))
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
  const catalogOf = (skills: SkillEntry[]): SkillCatalogEntry[] => skills.map((skill) => ({
    folder: skill.folder,
    name: skill.name,
    description: skill.description,
    valid: skill.valid,
    ...(skill.issue !== undefined ? { issue: skill.issue } : {}),
    ...(skill.linked === true ? { linked: true } : {}),
    modelInvocable: skill.modelInvocable,
    userInvocable: skill.userInvocable,
  }))
  let skillCatalog: SkillCatalogEntry[] = catalogOf(readSkillsChecked(activeSkillsDir))

  // 技能目录热更新：新增/删除/改名技能目录后，catalog 与注册表缓存一起刷新。
  const skillsWatcher = createSkillsWatcher(() => activeSkillsDir, () => {
    skillCatalog = catalogOf(readSkillsChecked(activeSkillsDir))
    cachedSkills.invalidate(activeSkillsDir); invalidateSkills?.()
  })
  skillsWatcher.watch()
  // 插件卸载时关闭技能目录 watcher，避免泄漏与对已卸载 provider 的无效刷新。
  ctx.effect(() => () => skillsWatcher.close())

  /** 切换生效技能目录并刷新目录快照（供 describe / TUI 显示）。 */
  const applyActiveSkillsDir = (dir: string): void => {
    activeSkillsDir = dir
    cachedSkills.invalidate(dir)
    skillCatalog = catalogOf(readSkillsChecked(dir))
    skillsWatcher.watch()
  }

  /** 用户 skillsDir 设置 → 实际生效目录。 */
  const resolveActiveSkillsDir = (userDir: string): string =>
    userDir.length > 0
      ? userDir
      : resolveProfileSkillsDir(ctx, DEFAULT_SKILLS_DIR, (message) => warn(ctx, message))

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
        return orderSkills(readSkillsChecked(activeSkillsDir))
          .filter((skill) => skill.valid && skillSwitches[skill.folder] !== false)
          .map((skill, index): SkillCandidate => ({
            name: skill.name,
            description: skill.description || skill.folder,
            ...(skill.whenToUse !== undefined ? { whenToUse: skill.whenToUse } : {}),
            invocation: { modelInvocable: skill.modelInvocable, userInvocable: skill.userInvocable },
            source: 'runtime',
            provider: 'prompt-tool',
            resourceBase: { kind: 'directory', path: join(activeSkillsDir, skill.folder) },
            rank: skillRankBase + index,
            locator: skill.folder,
            path: skill.file,
            ...(skill.metadata !== undefined ? { metadata: skill.metadata } : {}),
          }))
      },
      get: async (candidate: SkillCandidate, options: SkillLookupOptions): Promise<SkillDefinition | undefined> => {
        if (options.signal?.aborted) return undefined
        const skill = readSkillsChecked(activeSkillsDir).find((entry) => entry.folder === candidate.locator || entry.name === candidate.name)
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
    getDeepseekAvailable,
    getDeepseekState,
    () => ({ activeSkillsDir, skillCatalog }),
    readProjectOriginals,
    // 模板专属策略目录：当前 anchored 策略为引擎内置，自定义模板可经此注入。
    () => '',
    (sctx: Context) => ensureRegistered(sctx),
    () => {
      // 一键修复后立即重扫目录并失效官方 registry 缓存。
      skillCatalog = catalogOf(readSkillsChecked(activeSkillsDir))
      cachedSkills.invalidate(activeSkillsDir); invalidateSkills?.()
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
    skillsDir: configuredSkillsDir,
    firstTurnAnchor: config.firstTurnAnchor,
    firstTurnText: config.firstTurnText,
    firstTurnCustom: config.firstTurnCustom,
    guideText: config.guideText,
    guideCustom: config.guideCustom,
    subagentFlashProvider: config.subagentFlashProvider,
    subagentFlashModel: config.subagentFlashModel,
    bootstrapMaxTokens: config.bootstrapMaxTokens,
    usePtcMode: config.usePtcMode,
    skillRankBase: config.skillRankBase,
    residentAgentsPath: config.residentAgentsPath,
    presetDir: config.presetDir,
    presetOrder: config.presetOrder,
    fallbackText: config.fallbackText,
    promptConfigs: Array.isArray(config.promptConfigs) ? config.promptConfigs : [],
    promptConfigsDir: typeof config.promptConfigsDir === 'string' ? config.promptConfigsDir : '',
  }

  // 宿主直派子代理（如 dsh-mnemon）也补固定模型路由：
  // 服务商与模型名同时非空时生效；调用方显式模型优先，persona 与 toolFilter 保持不变。
  installSubagentFlashRoute(
    ctx,
    () => runtime.subagentFlashProvider.length > 0 && runtime.subagentFlashModel.length > 0,
    () => runtime.subagentFlashProvider,
    () => runtime.subagentFlashModel,
  )

  let currentSource = (): PromptSettings => ({
    promptText: current,
    promptPath: PRESET_FILE_PATH,
    agentsText: currentAgents,
    agentsPath: AGENTS_FILE_PATH,
    injectAgentsPrompt: runtime.injectAgentsPrompt,
    firstTurnAnchor: runtime.firstTurnAnchor,
    firstTurnText: normalizeFirstTurnText(runtime.firstTurnText),
    firstTurnCustom: runtime.firstTurnCustom,
    guideText: runtime.guideText,
    guideCustom: runtime.guideCustom,
    subagentFlashProvider: runtime.subagentFlashProvider,
    subagentFlashModel: runtime.subagentFlashModel,
    bootstrapMaxTokens: runtime.bootstrapMaxTokens,
    usePtcMode: runtime.usePtcMode,
    deepseekAvailable: getDeepseekAvailable(),
    injectPrompt: runtime.injectPrompt,
    skillSwitches: runtime.skillSwitches,
    skillOrder: runtime.skillOrder,
    skillCatalog,
    skillsDir: runtime.skillsDir,
    activeSkillsDir,
    skillRankBase: runtime.skillRankBase,
    residentAgentsPath: runtime.residentAgentsPath,
    presetDir: runtime.presetDir,
    presetOrder: runtime.presetOrder,
    fallbackText: runtime.fallbackText,
    writeAgents: runtime.writeAgents,
    writePreset: runtime.writePreset,
    presetTemplate: runtime.presetTemplate,
    promptConfigs: runtime.promptConfigs,
    promptConfigsDir: runtime.promptConfigsDir,
  })

  // dsh-tui 命令入口：/prompt-tool 查看或切换开关。
  registerTuiCommand(ctx, NS, () => currentSource(), getDeepseekAvailable, getDeepseekState)

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
      skillsDir: typeof next.skillsDir === 'string' ? next.skillsDir : configuredSkillsDir,
      firstTurnAnchor: typeof next.firstTurnAnchor === 'boolean' ? next.firstTurnAnchor : config.firstTurnAnchor,
      firstTurnText: normalizeFirstTurnText(typeof next.firstTurnText === 'string' ? next.firstTurnText : config.firstTurnText),
      firstTurnCustom: typeof next.firstTurnCustom === 'boolean' ? next.firstTurnCustom : config.firstTurnCustom,
      guideText: typeof next.guideText === 'string' ? next.guideText : config.guideText,
      guideCustom: typeof next.guideCustom === 'boolean' ? next.guideCustom : config.guideCustom,
      subagentFlashProvider: typeof next.subagentFlashProvider === 'string' ? next.subagentFlashProvider : config.subagentFlashProvider,
      subagentFlashModel: typeof next.subagentFlashModel === 'string' ? next.subagentFlashModel : config.subagentFlashModel,
      bootstrapMaxTokens: Number.isSafeInteger(next.bootstrapMaxTokens) && next.bootstrapMaxTokens >= 0 ? next.bootstrapMaxTokens : config.bootstrapMaxTokens,
      usePtcMode: typeof next.usePtcMode === 'boolean' ? next.usePtcMode : config.usePtcMode,
      skillRankBase: Number.isSafeInteger(next.skillRankBase) && next.skillRankBase >= 0 ? next.skillRankBase : config.skillRankBase,
      residentAgentsPath: typeof next.residentAgentsPath === 'string' && next.residentAgentsPath.trim().length > 0 ? next.residentAgentsPath : config.residentAgentsPath,
      presetDir: typeof next.presetDir === 'string' && next.presetDir.trim().length > 0 ? next.presetDir : config.presetDir,
      presetOrder: Number.isSafeInteger(next.presetOrder) && next.presetOrder >= 0 ? next.presetOrder : config.presetOrder,
      fallbackText: typeof next.fallbackText === 'string' ? next.fallbackText : config.fallbackText,
      promptConfigs: Array.isArray(next.promptConfigs) ? next.promptConfigs : config.promptConfigs,
      promptConfigsDir: typeof next.promptConfigsDir === 'string' ? next.promptConfigsDir : config.promptConfigsDir,
    }
    const promptChanged = next.promptText !== current
    const agentsChanged = next.agentsText !== currentAgents
    const skillSwitchesChanged = JSON.stringify(runtime.skillSwitches) !== JSON.stringify(nextRuntime.skillSwitches)
    const skillOrderChanged = JSON.stringify(runtime.skillOrder) !== JSON.stringify(nextRuntime.skillOrder)
    const skillsDirChanged = runtime.skillsDir !== nextRuntime.skillsDir
    const skillRankBaseChanged = runtime.skillRankBase !== nextRuntime.skillRankBase
    const fallbackTextChanged = runtime.fallbackText !== nextRuntime.fallbackText
    const settingsChanged = runtime.writeAgents !== nextRuntime.writeAgents
      || runtime.writePreset !== nextRuntime.writePreset
      || runtime.presetTemplate !== nextRuntime.presetTemplate
      || runtime.injectAgentsPrompt !== nextRuntime.injectAgentsPrompt
      || runtime.injectPrompt !== nextRuntime.injectPrompt
      || skillSwitchesChanged
      || skillOrderChanged
      || skillsDirChanged
      || skillRankBaseChanged
      || runtime.firstTurnAnchor !== nextRuntime.firstTurnAnchor
      || runtime.firstTurnText !== nextRuntime.firstTurnText
      || runtime.firstTurnCustom !== nextRuntime.firstTurnCustom
      || runtime.guideText !== nextRuntime.guideText
      || runtime.guideCustom !== nextRuntime.guideCustom
      || runtime.subagentFlashProvider !== nextRuntime.subagentFlashProvider
      || runtime.subagentFlashModel !== nextRuntime.subagentFlashModel
      || runtime.bootstrapMaxTokens !== nextRuntime.bootstrapMaxTokens
      || runtime.usePtcMode !== nextRuntime.usePtcMode
      || runtime.residentAgentsPath !== nextRuntime.residentAgentsPath
      || runtime.presetDir !== nextRuntime.presetDir
      || runtime.presetOrder !== nextRuntime.presetOrder
      || fallbackTextChanged
      || JSON.stringify(runtime.promptConfigs) !== JSON.stringify(nextRuntime.promptConfigs)
      || runtime.promptConfigsDir !== nextRuntime.promptConfigsDir
    // 首次必须写入：settings 与文件/config 一致时也不能跳过 preset/AGENTS 生成。
    if (!needsInitialApply && !promptChanged && !agentsChanged && !settingsChanged) return
    needsInitialApply = false

    if (promptChanged) current = next.promptText
    if (fallbackTextChanged && next.promptText.trim() === '' && current.trim() === '') current = readPromptFile(nextRuntime.fallbackText)
    if (agentsChanged) currentAgents = next.agentsText
    runtime.writeAgents = nextRuntime.writeAgents
    runtime.writePreset = nextRuntime.writePreset
    runtime.presetTemplate = nextRuntime.presetTemplate
    runtime.injectAgentsPrompt = nextRuntime.injectAgentsPrompt
    runtime.injectPrompt = nextRuntime.injectPrompt
    runtime.skillSwitches = nextRuntime.skillSwitches
    runtime.skillOrder = nextRuntime.skillOrder
    runtime.skillsDir = nextRuntime.skillsDir
    runtime.firstTurnAnchor = nextRuntime.firstTurnAnchor
    runtime.firstTurnText = nextRuntime.firstTurnText
    runtime.firstTurnCustom = nextRuntime.firstTurnCustom
    runtime.guideText = nextRuntime.guideText
    runtime.guideCustom = nextRuntime.guideCustom
    runtime.subagentFlashProvider = nextRuntime.subagentFlashProvider
    runtime.subagentFlashModel = nextRuntime.subagentFlashModel
    runtime.bootstrapMaxTokens = nextRuntime.bootstrapMaxTokens
    runtime.usePtcMode = nextRuntime.usePtcMode
    runtime.skillRankBase = nextRuntime.skillRankBase
    runtime.residentAgentsPath = nextRuntime.residentAgentsPath
    runtime.presetDir = nextRuntime.presetDir
    runtime.presetOrder = nextRuntime.presetOrder
    runtime.fallbackText = nextRuntime.fallbackText
    runtime.promptConfigs = nextRuntime.promptConfigs
    runtime.promptConfigsDir = nextRuntime.promptConfigsDir
    skillSwitches = runtime.skillSwitches
    skillOrder = runtime.skillOrder
    skillRankBase = runtime.skillRankBase
    if (skillsDirChanged) {
      applyActiveSkillsDir(resolveActiveSkillsDir(runtime.skillsDir))
      cachedSkills.invalidate(activeSkillsDir); invalidateSkills?.()
    } else if (skillSwitchesChanged || skillOrderChanged || skillRankBaseChanged) {
      cachedSkills.invalidate(activeSkillsDir); invalidateSkills?.()
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
    if (runtime.writePreset) {
      const presetPrompt = runtime.injectPrompt && current.length > 0 ? current : ''
      writePreset(presetPrompt, {
        firstTurnAnchor: runtime.firstTurnAnchor,
        firstTurnText: runtime.firstTurnText,
        firstTurnCustom: runtime.firstTurnCustom,
        guideText: runtime.guideText,
        guideCustom: runtime.guideCustom,
        injectPrompt: runtime.injectPrompt,
        subagentFlashProvider: runtime.subagentFlashProvider,
        subagentFlashModel: runtime.subagentFlashModel,
        bootstrapMaxTokens: runtime.bootstrapMaxTokens,
        usePtcMode: runtime.usePtcMode,
        agentsInstructionText: runtime.injectAgentsPrompt && currentAgents.length > 0 ? currentAgents : undefined,
        presetDir: runtime.presetDir,
        presetOrder: runtime.presetOrder,
        promptConfigs: runtime.promptConfigs,
        promptConfigsDir: runtime.promptConfigsDir,
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

  const settingsEntry: PromptSettings = {
    promptText: current,
    promptPath: PRESET_FILE_PATH,
    agentsText: currentAgents,
    agentsPath: AGENTS_FILE_PATH,
    injectAgentsPrompt: config.injectAgentsPrompt,
    firstTurnAnchor: config.firstTurnAnchor,
    firstTurnText: config.firstTurnText,
    firstTurnCustom: config.firstTurnCustom,
    guideText: config.guideText,
    guideCustom: config.guideCustom,
    subagentFlashProvider: config.subagentFlashProvider,
    subagentFlashModel: config.subagentFlashModel,
    bootstrapMaxTokens: config.bootstrapMaxTokens,
    usePtcMode: config.usePtcMode,
    deepseekAvailable: getDeepseekAvailable(),
    injectPrompt: config.injectPrompt,
    skillSwitches: { ...config.skillSwitches },
    skillOrder: [...skillOrder],
    skillCatalog,
    skillsDir: configuredSkillsDir,
    activeSkillsDir,
    skillRankBase: config.skillRankBase,
    residentAgentsPath: config.residentAgentsPath,
    presetDir: config.presetDir,
    presetOrder: config.presetOrder,
    fallbackText: config.fallbackText,
    writeAgents: config.writeAgents,
    writePreset: config.writePreset,
    presetTemplate: typeof config.presetTemplate === 'string' && config.presetTemplate.length > 0 ? config.presetTemplate : 'anchored',
    promptConfigs: Array.isArray(config.promptConfigs) ? config.promptConfigs : [],
    promptConfigsDir: typeof config.promptConfigsDir === 'string' ? config.promptConfigsDir : '',
  }

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
  // 首次安装：settings.yaml 没有 user 层文本时，用项目文件内容初始化。
  seedSettingsOnce(ctx, readProjectOriginals())
}

// 公共 API：宿主与测试复用 settings schema 与提示词配置权威校验。
export { Config, PromptSettingsSchema } from './config.ts'
export { writePreset } from './host/write-preset.ts'
export { applyModuleConfigs } from './host/manifest.ts'
export type { PresetSpec } from './host/manifest.ts'
export { ensureWebSurface, resolveProfileDir } from './web-surface.ts'
export { resolveProfileSkillsDir } from './profile-skills.ts'
export type { WritePresetOptions } from './host/write-preset.ts'
export { validatePromptConfigs } from './runtime/configs-validate.ts'
export { registerSettingsBridge } from './runtime/settings-bridge.ts'
export type { PromptConfigValidationError, PromptConfigValidationResult } from './runtime/configs-validate.ts'
export { loadPromptTemplates } from './host/templates.ts'
export type { PromptConfigTemplate } from './host/templates.ts'
export { registerTuiCommand } from './runtime/tui.ts'
export { ensureSettingsRegistered } from './runtime/settings-registration.ts'
export type { SettingsRegistrationHooks } from './runtime/settings-registration.ts'
export { createCachedSkillsReader, readSkills, listSkillFolders, isValidSkill, validSkills, SKILL_NAME_RE } from './runtime/skills-provider.ts'
export type { CachedSkillsReader } from './runtime/skills-provider.ts'
export { fixSkillEntry, toKebabName } from './runtime/skill-fix.ts'
export type { SkillFixResult } from './runtime/skill-fix.ts'
export type { SkillEntry, SkillCatalogEntry } from './config.ts'
export { BRIDGE_ENDPOINTS, SETTINGS_BRIDGE_PREFIX } from './shared/bridge-contract.ts'
export type { BridgeEndpoint, BridgeErrorPayload } from './shared/bridge-contract.ts'
export { parseFrontmatter } from './runtime/skills-parse.ts'
export type { SkillFrontmatter } from './runtime/skills-parse.ts'
