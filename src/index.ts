import { installSettingsSection } from '@deepseek-ai/dsh-settings'
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
import { readFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { readSkills } from './runtime/skills-provider.ts'
import { ensureWebSurface } from './web-surface.ts'
import { resolveProfileSkillsDir } from './profile-skills.ts'
import { detectDeepseek, installSubagentFlashRoute } from './runtime/deepseek.ts'
import type { DeepseekDetection } from './runtime/deepseek.ts'
import { registerSettingsBridge } from './runtime/settings-bridge.ts'
import { registerTuiCommand } from './runtime/tui.ts'
import { removeResidentAgentsBlock, writeAgents } from './runtime/agents-file.ts'
import { writePreset } from './preset-write.ts'
import {
  Config,
  DEFAULT_SKILLS_DIR,
  NS,
  normalizeAnchorText,
  PromptSettings,
  PromptSettingsSchema,
  RuntimeOptions,
  SkillCatalogEntry,
  SkillEntry,
} from './config.ts'

export const name = 'prompt-tool'
// 内容走 user 层（AGENTS.md 常驻层 + skill 按需层），
// 不再注册 system prompt section（否则会被 persona 的 complete:true 整个清零）。
// 注意：webServer 不放在静态 inject 里——profile 首次可能只有
// @deepseek-ai/dsh-base（没有 @deepseek-ai/dsh-web-app），硬注入会让插件
// pending 并导致启动失败。Web 表面改为动态等待 webServer；首次启动时由
// ensureWebSurface 自动把 web-app bundle 补进 profile，重启一次后生效。
export const inject = ['skills', 'commands', 'llm', 'subagents']

const PRESET_FILE_URL = new URL('../preset.md', import.meta.url)
const PRESET_FILE_PATH = fileURLToPath(PRESET_FILE_URL)
const AGENTS_URL = new URL('../AGENTS.md', import.meta.url)
const AGENTS_FILE_PATH = fileURLToPath(AGENTS_URL)

function readPromptFile(fallbackText: string): string {
  try {
    return readFileSync(PRESET_FILE_URL, 'utf8')
  } catch {
    return fallbackText
  }
}

function readAgents(): string {
  try {
    return readFileSync(AGENTS_URL, 'utf8')
  } catch {
    return ''
  }
}

interface ProjectOriginals {
  presetText: string
  agentsText: string
}

/** 直接读取项目根目录的 preset.md 与 AGENTS.md；宿主不再回写这两个文件。 */
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


export function apply(ctx: Context, config: Config): void {
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
  let skillCatalog: SkillCatalogEntry[] = readSkills(activeSkillsDir).map((skill) => ({
    folder: skill.folder,
    name: skill.name,
    description: skill.description,
  }))

  /** 切换生效技能目录并刷新目录快照（供 describe / TUI 显示）。 */
  const applyActiveSkillsDir = (dir: string): void => {
    activeSkillsDir = dir
    skillCatalog = readSkills(dir).map((skill) => ({
      folder: skill.folder,
      name: skill.name,
      description: skill.description,
    }))
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
        return orderSkills(readSkills(activeSkillsDir))
          .filter((skill) => skillSwitches[skill.folder] !== false)
          .map((skill, index): SkillCandidate => ({
            name: skill.name,
            description: skill.description || skill.folder,
            ...(skill.whenToUse !== undefined ? { whenToUse: skill.whenToUse } : {}),
            invocation: { modelInvocable: true, userInvocable: true },
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
        const skill = readSkills(activeSkillsDir).find((entry) => entry.folder === candidate.locator || entry.name === candidate.name)
        if (skill === undefined || skillSwitches[skill.folder] === false) return undefined
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
  registerSettingsBridge(ctx, NS, getDeepseekAvailable, getDeepseekState, () => ({ activeSkillsDir, skillCatalog }), readProjectOriginals)

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
    injectAgentsPrompt: config.injectAgentsPrompt,
    injectPrompt: config.injectPrompt,
    skillSwitches: { ...config.skillSwitches },
    skillOrder: [...skillOrder],
    skillsDir: configuredSkillsDir,
    anchorFirstTurn: config.anchorFirstTurn,
    anchorText: config.anchorText,
    anchorCustom: config.anchorCustom,
    guideText: config.guideText,
    guideCustom: config.guideCustom,
    subagentFlash: config.subagentFlash && getDeepseekAvailable(),
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

  // 宿主直派子代理（如 dsh-mnemon）也按开关补 Flash 路由；
  // 调用方显式模型优先，persona 与 toolFilter 保持不变。
  installSubagentFlashRoute(ctx, () => runtime.subagentFlash, () => runtime.subagentFlashProvider, () => runtime.subagentFlashModel)

  let currentSource = (): PromptSettings => ({
    promptText: current,
    promptPath: PRESET_FILE_PATH,
    agentsText: currentAgents,
    agentsPath: AGENTS_FILE_PATH,
    injectAgentsPrompt: runtime.injectAgentsPrompt,
    anchorFirstTurn: runtime.anchorFirstTurn,
    anchorText: normalizeAnchorText(runtime.anchorText),
    anchorCustom: runtime.anchorCustom,
    guideText: runtime.guideText,
    guideCustom: runtime.guideCustom,
    subagentFlash: runtime.subagentFlash,
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
      injectAgentsPrompt: typeof next.injectAgentsPrompt === 'boolean' ? next.injectAgentsPrompt : config.injectAgentsPrompt,
      injectPrompt: typeof next.injectPrompt === 'boolean' ? next.injectPrompt : config.injectPrompt,
      skillSwitches: next.skillSwitches !== undefined ? next.skillSwitches : config.skillSwitches,
      skillOrder: Array.isArray(next.skillOrder) ? next.skillOrder.filter((folder): folder is string => typeof folder === 'string') : config.skillOrder,
      skillsDir: typeof next.skillsDir === 'string' ? next.skillsDir : configuredSkillsDir,
      anchorFirstTurn: typeof next.anchorFirstTurn === 'boolean' ? next.anchorFirstTurn : config.anchorFirstTurn,
      anchorText: normalizeAnchorText(typeof next.anchorText === 'string' ? next.anchorText : config.anchorText),
      anchorCustom: typeof next.anchorCustom === 'boolean' ? next.anchorCustom : config.anchorCustom,
      guideText: typeof next.guideText === 'string' ? next.guideText : config.guideText,
      guideCustom: typeof next.guideCustom === 'boolean' ? next.guideCustom : config.guideCustom,
      subagentFlash: (typeof next.subagentFlash === 'boolean' ? next.subagentFlash : config.subagentFlash) && getDeepseekAvailable(),
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
      || runtime.injectAgentsPrompt !== nextRuntime.injectAgentsPrompt
      || runtime.injectPrompt !== nextRuntime.injectPrompt
      || skillSwitchesChanged
      || skillOrderChanged
      || skillsDirChanged
      || skillRankBaseChanged
      || runtime.anchorFirstTurn !== nextRuntime.anchorFirstTurn
      || runtime.anchorText !== nextRuntime.anchorText
      || runtime.anchorCustom !== nextRuntime.anchorCustom
      || runtime.guideText !== nextRuntime.guideText
      || runtime.guideCustom !== nextRuntime.guideCustom
      || runtime.subagentFlash !== nextRuntime.subagentFlash
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
    runtime.injectAgentsPrompt = nextRuntime.injectAgentsPrompt
    runtime.injectPrompt = nextRuntime.injectPrompt
    runtime.skillSwitches = nextRuntime.skillSwitches
    runtime.skillOrder = nextRuntime.skillOrder
    runtime.skillsDir = nextRuntime.skillsDir
    runtime.anchorFirstTurn = nextRuntime.anchorFirstTurn
    runtime.anchorText = nextRuntime.anchorText
    runtime.anchorCustom = nextRuntime.anchorCustom
    runtime.guideText = nextRuntime.guideText
    runtime.guideCustom = nextRuntime.guideCustom
    runtime.subagentFlash = nextRuntime.subagentFlash
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
      invalidateSkills?.()
    } else if (skillSwitchesChanged || skillOrderChanged || skillRankBaseChanged) {
      invalidateSkills?.()
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
        anchorFirstTurn: runtime.anchorFirstTurn,
        anchorText: runtime.anchorText,
        anchorCustom: runtime.anchorCustom,
        guideText: runtime.guideText,
        guideCustom: runtime.guideCustom,
        injectPrompt: runtime.injectPrompt,
        subagentFlash: runtime.subagentFlash,
        subagentFlashProvider: runtime.subagentFlashProvider,
        subagentFlashModel: runtime.subagentFlashModel,
        bootstrapMaxTokens: runtime.bootstrapMaxTokens,
        usePtcMode: runtime.usePtcMode,
        agentsInstructionText: runtime.injectAgentsPrompt && currentAgents.length > 0 ? currentAgents : undefined,
        presetDir: runtime.presetDir,
        presetOrder: runtime.presetOrder,
        promptConfigs: runtime.promptConfigs,
        promptConfigsDir: runtime.promptConfigsDir,
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
    anchorFirstTurn: config.anchorFirstTurn,
    anchorText: config.anchorText,
    anchorCustom: config.anchorCustom,
    guideText: config.guideText,
    guideCustom: config.guideCustom,
    subagentFlash: config.subagentFlash && getDeepseekAvailable(),
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
    promptConfigs: Array.isArray(config.promptConfigs) ? config.promptConfigs : [],
    promptConfigsDir: typeof config.promptConfigsDir === 'string' ? config.promptConfigsDir : '',
  }

  installSettingsSection(ctx, NS, PromptSettingsSchema, settingsEntry, {
    setSource: (source) => { currentSource = source },
    onChange: () => {
      // applyState 里的用户态 IO 失败不能打断 settings 注册链：
      // onChange 从 installSettingsSection 的 inject 回调内同步调用，
      // 任何异常冒泡都会让 cordis 把该 fiber 置 FAILED 并回滚注册，
      // 表现为「保存失败：settings namespace "prompt-tool" is not registered」。
      try {
        applyState()
      } catch (error) {
        warn(ctx, `prompt-tool: applyState failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    },
  })
  // 首次安装：settings.yaml 没有 user 层文本时，用项目文件内容初始化。
  seedSettingsOnce(ctx, readProjectOriginals())
}

// 公共 API：宿主与测试复用 settings schema 与提示词配置权威校验。
export { Config, PromptSettingsSchema } from './config.ts'
export { validatePromptConfigs } from './runtime/configs-validate.ts'
export type { PromptConfigValidationError, PromptConfigValidationResult } from './runtime/configs-validate.ts'
export { loadPromptTemplates } from './runtime/templates.ts'
export type { PromptConfigTemplate } from './runtime/templates.ts'
export { registerTuiCommand } from './runtime/tui.ts'
