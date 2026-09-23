import type { Context } from '@deepseek-ai/cordis'
import type SettingsService from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
import { scheduleWebSurfaceRepair } from './web-surface.ts'
import { detectModels, invalidateModelCatalog, listAdvertisedModels } from './runtime/models.ts'
import type { ModelDetection } from './runtime/models.ts'
import { registerSettingsBridge } from './runtime/settings-bridge.ts'
import { registerCharacterTools } from './runtime/character-tools.ts'
import { registerWorldBookTools } from './runtime/world-book-tools.ts'
import { registerSessionVarTools } from './runtime/session-var-tools.ts'
import { installPreStepCoordinator } from './runtime/pre-step-coordinator.ts'
import { registerTuiCommand } from './runtime/tui.ts'
import { writePreset } from './host/write-preset.ts'
import type { WritePresetOptions } from './host/write-preset.ts'
import { ENGINE_PARAM_KEYS } from './shared/engine-params.ts'
import {
  ensurePresetSeed,
  listPresets,
} from './host/manifest.ts'
import {
  Config,
  NS,
} from './config.ts'
import type { PromptSettings, RuntimeOptions } from './config.ts'
import { DEFAULT_PRESET_DIR } from './host/paths.ts'
import { DEFAULT_PRESET_ID } from './shared/preset-ids.ts'
import { createSkillsRuntime } from './host/skills-runtime.ts'
import { createPresetRegistrySync } from './host/preset-registry.ts'

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
  // 包内目录与输出目录同名；启动只复制缺失项，现有用户定义不被重新铺写。
  const seededPresets = new Set(ensurePresetSeed(DEFAULT_PRESET_DIR).created)
  const readConfig = () => ({
    writePreset: configIn.writePreset.get(),
    presetTemplate: configIn.presetTemplate.get(),
    presetOrder: configIn.presetOrder.get(),
    fallbackText: configIn.fallbackText.get(),
  })
  const config = readConfig()
  let registrySync: ReturnType<typeof createPresetRegistrySync> | undefined
  const refreshPresets = (forceIds?: readonly string[]): Promise<void> => registrySync?.refresh(forceIds) ?? Promise.resolve()
  const modelsState = (): ModelDetection => detectModels(ctx)
  const getModelsState = (): ModelDetection => modelsState()
  // 内容资产优先读生成目录文件（writePreset 落盘），模板 content 作回退；
  // settings.yaml 不再承载大文本（web 打开加载慢的根因）。
  const initialTemplate = typeof config.presetTemplate === 'string' && config.presetTemplate.length > 0
      ? config.presetTemplate
      : DEFAULT_PRESET_ID
  // 预设分离：每个预设 = 官方预设根（DEFAULT_PRESET_DIR）下的官方预设目录 <template>/。
  const initialPresetDir = join(DEFAULT_PRESET_DIR, /^[a-zA-Z0-9_-]+$/.test(initialTemplate) ? initialTemplate : DEFAULT_PRESET_ID)
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
    for (const key of ENGINE_PARAM_KEYS) (runtime as unknown as Record<string, unknown>)[key] = params[key]
    runtime.firstTurnAnchor = params.firstTurnAnchor === true
    runtime.firstTurnText = asString(params.firstTurnText)
    runtime.firstTurnCustom = params.firstTurnCustom === true
    runtime.guideText = asString(params.guideText)
    runtime.guideCustom = params.guideCustom === true
    runtime.guideEnabled = typeof params.guideEnabled === 'boolean' ? params.guideEnabled : undefined
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
    runtime.injectPrompt = params.injectPrompt !== false
    runtime.maxDepth = params.maxDepth as RuntimeOptions['maxDepth']
    runtime.firstTurnWord = asString(params.firstTurnWord) || undefined
    runtime.promptConfigs = Array.isArray(spec.promptConfigs)
      ? spec.promptConfigs as PromptConfigSpec[]
      : []
  }

  /** 重建生成目录并刷新官方注册；writePreset 关闭时保留空组合。 */
  const rebuildPreset = (initial = false): void => {
    // 先重读激活预设参数（/param-overrides 保存、TUI 开关、预设切换后生效）。
    reloadPresetParams()
    if (runtime.writePreset) {
      const presetPrompt = runtime.injectPrompt && current.length > 0 ? current : ''
      const options: WritePresetOptions = {
        ...Object.fromEntries(ENGINE_PARAM_KEYS.map((key) => [key, (runtime as unknown as Record<string, unknown>)[key]])),
        firstTurnAnchor: runtime.firstTurnAnchor,
        firstTurnText: runtime.firstTurnText,
        firstTurnCustom: runtime.firstTurnCustom,
        guideText: runtime.guideText,
        guideCustom: runtime.guideCustom,
        guideEnabled: runtime.guideEnabled,
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
        maxDepth: runtime.maxDepth,
        firstTurnWord: runtime.firstTurnWord,
        agentsInstructionText: currentAgents,
        presetDir: DEFAULT_PRESET_DIR,
        presetOrder: runtime.presetOrder,
        promptConfigs: runtime.promptConfigs,
        presetTemplate: runtime.presetTemplate,
        outputId: runtime.presetTemplate,
        warn: (message) => warn(ctx, message),
      }
      // 初始化只物化刚补建的目录；全局开关恢复时只恢复曾被该开关清空的组合。
      for (const preset of listPresets()) {
        if (preset.id === runtime.presetTemplate) continue
        const targetDir = join(DEFAULT_PRESET_DIR, preset.id)
        if (!seededPresets.has(preset.id)
          && !readGeneratedContent(targetDir, 'agent.cordis.yml').startsWith('# prompt-tool writePreset disabled')) continue
        // 手写/官方格式预设（无 modules/params）不自动重渲染：参数桥无从下手，
        // 重渲染只会覆盖用户手写组合；其 persona 契约由就地迁移修正。
        try {
          const spec = loadPresetSpec(resolvePresetDir(preset.id))
          const pluginFormat = Array.isArray(spec.modules) || (spec.params !== null && typeof spec.params === 'object')
          if (!pluginFormat && existsSync(join(targetDir, 'agent.cordis.yml'))) continue
        } catch {
          // 读取失败按缺失处理：writePreset 会给出明确报错。
        }
        try {
          writePreset(readPromptFile(preset.id, runtime.fallbackText), {
            ...resolvePresetParams(loadPresetSpec(resolvePresetDir(preset.id)), {}),
            presetDir: DEFAULT_PRESET_DIR,
            presetOrder: runtime.presetOrder,
            presetTemplate: preset.id,
            outputId: preset.id,
            // 补建的是**别的**预设：必须清空 promptConfigs 覆盖层。它承载的是激活预设的
            // 编辑上下文（settings 层），writePreset 又把它当最高优先级——透传会把激活预设
            // 的提示词配置写进目标预设，切换过去后注入的仍是旧预设内容；且目标组合带上
            // 渲染标记后不再重建，污染被固化。目标预设的配置一律以自身 preset.yml +
            // 包内模板默认为准（与导入候选物化同源理由）。
            promptConfigs: [],
            agentsInstructionText: '',
          })
        } catch (error) {
          warn(ctx, `prompt-tool: 补建预设 ${preset.id} 失败（切换时可重试）：${error instanceof Error ? error.message : String(error)}`)
        }
      }
      if (!initial || seededPresets.has(runtime.presetTemplate)
        || readGeneratedContent(activePresetDir(), 'agent.cordis.yml').startsWith('# prompt-tool writePreset disabled')) {
        writePreset(presetPrompt, options)
      }
      seededPresets.clear()
    } else {
      // writePreset 关闭时清空各预设目录的生成物，保留 preset.yml 参数源与预设根本身。
      // agent.cordis.yml 改写为空组合而非删除：官方 discovery 对缺组合文件的目录
      // 仍占用 id 并判 broken（挂载抛 agent-preset/invalid、picker 丢弃该行），
      // 会导致 default 预设无法新建会话、全部预设无法切换；空组合零行可正常
      // 挂载，等价「停止注入」语义，重新开启后由重建恢复完整组合。
      // 绝不删除整个用户预设目录（旧版误删预设根：用户全部预设、
      // 种子标记 .pt-seeded、共享 .engine 一并清空）。
      let cleaned = 0
      for (const preset of listPresets()) {
        const dir = join(DEFAULT_PRESET_DIR, preset.id)
        for (const name of ['prompt-configs', 'custom-tools', 'preset.md', 'agents.md', 'agents-instruction.md', 'engine']) {
          try {
            rmSync(join(dir, name), { recursive: true, force: true })
          } catch {
            // Windows 瞬时锁：残留无害（下次重建/清理重试）。
          }
        }
        try {
          writeFileSync(join(dir, 'agent.cordis.yml'), '# prompt-tool writePreset disabled\n[]\n', 'utf8')
        } catch {
          // 写失败保留旧组合：注入未停止，下次重建重试；preset.yml 参数不受影响。
        }
        cleaned += 1
      }
      warn(ctx, `prompt-tool: writePreset 已关闭，清空 ${cleaned} 个预设目录的组合（preset.yml 参数保留）`)
    }
    void refreshPresets(runtime.writePreset ? [runtime.presetTemplate] : listPresets().map((preset) => preset.id))
      .catch((error) => warn(ctx, `prompt-tool: 重建后的预设注册刷新失败：${String(error)}`))
  }

  /** 激活预设目录（内容按预设根 <template>/ 隔离；非法名回退 standard）。 */
  const activePresetDir = (): string =>
    join(DEFAULT_PRESET_DIR, /^[a-zA-Z0-9\u4e00-\u9fff_-]+$/.test(runtime.presetTemplate) ? runtime.presetTemplate : DEFAULT_PRESET_ID)

  // 宿主模块拥有技能状态、官方引用 provider 与资产操作的生命周期。
  const skillsRuntime = createSkillsRuntime(ctx)

  // 在线编辑不再经 ctx.llm 暴露 settings namespace：改为自建 loopback bridge，
  // 这样模型设置页不会出现「提示词工具」目录条目。
  const settingsBridge = registerSettingsBridge(
    ctx,
    NS,
    getModelsState,
    () => ({
      skillsRoot: skillsRuntime.skillsRoot,
      get folders() { return skillsRuntime.folders },
      listSkills: skillsRuntime.listSkills,
      snapshot: skillsRuntime.snapshot,
      deleteSkill: skillsRuntime.deleteSkill,
      setSkillPolicy: skillsRuntime.setPolicy,
      patchSkillFolders: skillsRuntime.setFolders,
    }),
    // 模板专属策略目录：当前内置策略全部随引擎提供，自定义模板可经此注入。
    () => '',
    skillsRuntime.invalidate,
    // 激活预设目录：内容资产/提示词配置按预设隔离在预设根 <template>/。
    () => activePresetDir(),
    (scopes) => {
      // 内容导入后：批量更新运行时文本，单次重建生成目录（一次自动保存只重建一次）。
      for (const scope of scopes) {
        if (scope === 'preset') current = readGeneratedContent(activePresetDir(), 'preset.md')
        else currentAgents = readGeneratedContent(activePresetDir(), 'agents.md')
      }
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
      } catch (error) {
        warn(ctx, `prompt-tool: overrides rebuild failed: ${String(error)}`)
        throw error
      }
    },
    // host 已安装完整候选；这里只刷新内存，不能二次物化覆盖导入资产。
    async (id) => {
      if (id === runtime.presetTemplate) {
        current = readGeneratedContent(activePresetDir(), 'preset.md')
        currentAgents = readGeneratedContent(activePresetDir(), 'agents.md')
        reloadPresetParams()
      }
      skillsRuntime.invalidate()
      await refreshPresets([id])
    },
    () => {
      rebuildPreset()
    },
    () => refreshPresets(),
  )

  // 首次以 base-only profile 启动时自动补 @deepseek-ai/dsh-web-app：
  // 写进 profile bundles（下一次启动由官方装配路径生效），并提示重启。
  // 延迟任务挂在 effect 上：插件卸载后不再补写 profile，也不残留计时器。
  scheduleWebSurfaceRepair(ctx, (message) => warn(ctx, message))

  // provider 拓扑变化（适配器注册/移除）会让已缓存的模型目录过期：
  // 订阅官方 payload-free 事件，按 Context 失效缓存；监听器挂在 effect 上，重挂无残留。
  ctx.effect(() => ctx.on('llm/adapters-updated', () => invalidateModelCatalog(ctx)))

  // 部署轴读取 volatile Config；行为参数仍以当前 preset.yml 为准。
  const runtime: RuntimeOptions = {
    ...Object.fromEntries(ENGINE_PARAM_KEYS.map((key) => [key, initialParams[key]])),
    writePreset: config.writePreset,
    presetTemplate: initialTemplate,
    // 引擎参数：激活预设 preset.yml（每预设独立，settings 不再承载）。
    firstTurnAnchor: initialParams.firstTurnAnchor === true,
    firstTurnText: asString(initialParams.firstTurnText),
    firstTurnCustom: initialParams.firstTurnCustom === true,
    guideText: asString(initialParams.guideText),
    guideCustom: initialParams.guideCustom === true,
    guideEnabled: typeof initialParams.guideEnabled === 'boolean' ? initialParams.guideEnabled : undefined,
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
    maxDepth: initialParams.maxDepth as RuntimeOptions['maxDepth'],
    firstTurnWord: asString(initialParams.firstTurnWord) || undefined,
    presetOrder: config.presetOrder,
    fallbackText: config.fallbackText,
    promptConfigs: Array.isArray(initialSpec?.promptConfigs) ? initialSpec.promptConfigs as PromptConfigSpec[] : [],
  }

  // 与官方 agent-preset-registry.selectedDefault 双向同步：
  // 两个设置面最终收敛到同一个预设。比较权威当前值后才写，避免双向事件回环。
  const agentPresetsNs = 'agent-preset-registry' as const
  let hostSettingsService: SettingsService | undefined
  const settingsDocument = (service: SettingsService, ns: string): unknown =>
    service.describe().find((item) => String(item.ns) === ns)?.value
  const readHostDefault = (value: unknown): string | undefined => {
    if (value === null || typeof value !== 'object') return undefined
    const candidate = (value as { selectedDefault?: unknown }).selectedDefault
    return typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined
  }
  /** 官方生效默认值（包含未设置 selectedDefault 时的部署回退）。 */
  type AgentPresetsPolicyService = {
    readonly defaultId?: unknown
  }
  let agentPresetsService: AgentPresetsPolicyService | undefined
  let modeSelectionWarned = false
  /**
   * 官方 modeSelectionEnabled=false 时忽略 selectedDefault，使用部署 default。
   */
  const modeSelectionEnabled = (value: unknown): boolean | undefined => {
    if (value === null || typeof value !== 'object') return undefined
    const flag = (value as { modeSelectionEnabled?: unknown }).modeSelectionEnabled
    return typeof flag === 'boolean' ? flag : undefined
  }
  const warnModeSelectionOnce = (): void => {
    if (modeSelectionWarned) return
    modeSelectionWarned = true
    warn(ctx, 'prompt-tool: 宿主已关闭 agent-preset-registry 模式选择（modeSelectionEnabled=false）：写入 selectedDefault 不影响新会话。请修改 profile 的 agent-preset-registry config.default，或重新开启模式选择。')
  }
  /**
   * 生效默认预设（与官方 selectionPolicy 同源）：开关关闭时 official 只认
   * `config.default`，该值只有服务 getter 能给出；服务未就绪时返回 undefined，
   * 由 agentPresets 的迟到回调再对齐一次。
   */
  const effectiveHostDefault = (value?: unknown): string | undefined => {
    const document = value ?? (hostSettingsService === undefined ? undefined : settingsDocument(hostSettingsService, agentPresetsNs))
    if (modeSelectionEnabled(document) !== false && readHostDefault(document) !== undefined) return readHostDefault(document)
    const effective = agentPresetsService?.defaultId
    return typeof effective === 'string' && effective.length > 0 ? effective : undefined
  }
  const managedPresetExists = (id: string): boolean => {
    try {
      return listPresets().some(preset => preset.id === id)
    } catch {
      return false
    }
  }
  /** 把本插件当前预设写进官方 selectedDefault。 */
  const syncHostDefault = (): void => {
    const s = hostSettingsService
    if (s === undefined) return
    const template = runtime.presetTemplate
    // 同步 ID 必须命中本插件预设目录的命名契约。
    if (!/^[a-z0-9][a-z0-9-]*$/.test(template)) {
      warn(ctx, `prompt-tool: 预设 id ${JSON.stringify(template)} 不符合预设目录命名（^[a-z0-9][a-z0-9-]*$），跳过 selectedDefault 同步`)
      return
    }
    // 策略关闭时写入必然被忽略：不假装同步成功，只告警一次。
    if (modeSelectionEnabled(settingsDocument(s, agentPresetsNs)) === false) {
      warnModeSelectionOnce()
      return
    }
    if (readHostDefault(settingsDocument(s, agentPresetsNs)) === template) return
    // 持久化更新异步完成，必须处理 rejection。
    void s.update(agentPresetsNs, { selectedDefault: template })
      .catch((error: unknown) => {
        warn(ctx, `prompt-tool: 同步宿主 selectedDefault 失败：${error instanceof Error ? error.message : String(error)}`)
      })
  }
  const syncTemplateFromHostDefault = (value?: unknown, initial = false): void => {
    const s = hostSettingsService
    if (s === undefined) return
    // 跟随的是「生效默认」而不是存储值：策略关闭时存储值已不再决定新会话。
    const raw = effectiveHostDefault(value)
    if (raw === undefined) return
    const template = raw
    if (template === runtime.presetTemplate) return
    // 官方设置可列出插件未管理的 shipped/第三方预设；只跟随本项目能解析/编辑的预设，
    // 避免把不存在的 presetTemplate 写进本插件后导致 writePreset 失败。
    if (!managedPresetExists(template)) {
      if (initial && managedPresetExists(runtime.presetTemplate)) {
        syncHostDefault()
        return
      }
      warn(ctx, `prompt-tool: 官方默认预设已切换为 ${JSON.stringify(template)}，但该预设不在提示词工具管理目录中，跳过反向同步`)
      return
    }
    void s.update(NS, { presetTemplate: template })
      .catch((error: unknown) => {
        warn(ctx, `prompt-tool: 跟随官方默认预设失败：${error instanceof Error ? error.message : String(error)}`)
      })
  }

  // 子代理固定模型路由：不替换 ctx.subagents 的 start/startContinuable 方法，
  // 只经 buildModuleConfigsFromParams 把 agentOptions 写进本插件生成的
  // tool-subagent / tool-subagent-fork 行；第三方直派保持官方默认继承语义。

  const currentSource = (): PromptSettings => ({
    ...readConfig(),
    modelsAvailable: getModelsState().available,
  })

  // dsh-tui 命令入口：/prompt-tool 查看或切换开关。
registerTuiCommand(
  ctx,
  NS,
  () => ({ ...currentSource(), skillCatalog: skillsRuntime.listSkills(), activeSkillsDirs: [skillsRuntime.skillsRoot] }),
  getModelsState,
  () => listAdvertisedModels(ctx),
  () => activePresetDir(),
  // TUI 参数开关：写激活预设 preset.yml（settings 不再承载引擎参数）。
  // 保存/重建失败直接抛给命令层，由 CommandResult:error 呈现给用户。
  (key, value) => {
    if (key === 'promptConfigs') {
      savePresetParams(DEFAULT_PRESET_DIR, runtime.presetTemplate, undefined, Array.isArray(value) ? value as unknown[] : undefined)
    } else {
      savePresetParams(DEFAULT_PRESET_DIR, runtime.presetTemplate, { [key]: value }, undefined)
    }
    reloadPresetParams()
    rebuildPreset()
  },
  // 技能启停：改写技能文件的调用策略键（正文不动），失败原因回给命令层。
  (name, enabled) => {
    const matches = skillsRuntime.listSkills().filter((skill) => skill.name === name)
    if (matches.length !== 1) return { ok: false, message: `技能 ${name} 不存在或有多个同名条目，请在技能管理页选择具体文件` }
    const entry = matches[0]
    if (entry?.path === undefined) return { ok: false, message: `未找到技能或其文件路径：${name}` }
    const result = skillsRuntime.setPolicy(name, entry.path, { scope: enabled ? 'none' : 'all' })
    return result.ok ? { ok: true } : { ok: false, message: result.message }
  },
)

  let needsInitialApply = true
  const applyState = (): void => {
    const next = currentSource()
    const nextTemplate = typeof next.presetTemplate === 'string' && next.presetTemplate.length > 0
      ? next.presetTemplate
      : DEFAULT_PRESET_ID
    const nextRuntime: Pick<RuntimeOptions,
      'writePreset' | 'presetTemplate' | 'presetOrder' | 'fallbackText'> = {
      writePreset: typeof next.writePreset === 'boolean' ? next.writePreset : config.writePreset,
      presetTemplate: nextTemplate,
      presetOrder: Number.isSafeInteger(next.presetOrder) && next.presetOrder >= 0 ? next.presetOrder : config.presetOrder,
      fallbackText: typeof next.fallbackText === 'string' ? next.fallbackText : config.fallbackText,
    }
    const fallbackTextChanged = runtime.fallbackText !== nextRuntime.fallbackText
    const presetTemplateChanged = runtime.presetTemplate !== nextRuntime.presetTemplate
    const settingsChanged = runtime.writePreset !== nextRuntime.writePreset
      || runtime.presetTemplate !== nextRuntime.presetTemplate
      || runtime.presetOrder !== nextRuntime.presetOrder
      || fallbackTextChanged
    // 首次只补建新目录；后续设置变更正常生成当前预设。
    if (!needsInitialApply && !settingsChanged) return
    const initial = needsInitialApply
    needsInitialApply = false

    // 切换预设：内容资产从新预设目录重读——否则 rebuildPreset 会把旧预设的
    // preset.md/agents.md 内容复制进新预设（custom 空白预设被写入其他预设文本）。
    if (presetTemplateChanged) {
      const newDir = join(DEFAULT_PRESET_DIR, /^[a-zA-Z0-9\u4e00-\u9fff_-]+$/.test(nextRuntime.presetTemplate) ? nextRuntime.presetTemplate : DEFAULT_PRESET_ID)
      current = readGeneratedContent(newDir, 'preset.md') || readPromptFile(nextRuntime.presetTemplate, nextRuntime.fallbackText)
      currentAgents = readGeneratedContent(newDir, 'agents.md') || readAgents(nextRuntime.presetTemplate)
    }
    runtime.writePreset = nextRuntime.writePreset
    runtime.presetTemplate = nextRuntime.presetTemplate
    runtime.presetOrder = nextRuntime.presetOrder
    runtime.fallbackText = nextRuntime.fallbackText

    rebuildPreset(initial)
    if (presetTemplateChanged) {
      syncHostDefault()
      // 内置工具面随组合行走（per-session 挂载），无需宿主平面重挂。
    }
  }

  // 内置模型工具由三个独立预设模块按需挂载；宿主只提供对应注册服务。
  ctx.provide('pt-character-tools', {
    mount: (scopeCtx: Context): (() => void) => registerCharacterTools(scopeCtx, {
      presetRoot: () => dirname(activePresetDir()),
      templateName: () => basename(activePresetDir()),
      rebuild: () => {
        try {
          rebuildPreset()
        } catch (error) {
          warn(ctx, 'prompt-tool: character tool rebuild failed: ' + String(error))
        }
      },
    }),
  })
  ctx.provide('pt-world-book-tools', {
    mount: (scopeCtx: Context): (() => void) => registerWorldBookTools(scopeCtx, {
      activeDir: () => activePresetDir(),
      presetRoot: () => dirname(activePresetDir()),
      rebuild: () => {
        try {
          rebuildPreset()
        } catch (error) {
          warn(ctx, 'prompt-tool: world-book tool rebuild failed: ' + String(error))
        }
      },
    }),
  })
  ctx.provide('pt-session-var-tools', {
    mount: (scopeCtx: Context): (() => void) => registerSessionVarTools(scopeCtx),
  })

  // 独立指令文件来源：宿主侧按本次 Agent 实时编译文件卡，引擎在每次 pre-step
  // 查询本服务（ctx.get('promptToolPreStep')），不注册第二个 pre-step 监听器。
  // 策略缺省 enabled=false；服务缺失时引擎只执行预设卡（独立引擎复制场景）。
  installPreStepCoordinator(ctx)

  const applyConfig = (): void => {
    settingsBridge.invalidateDescriptor()
    try { applyState() } catch (error) { warn(ctx, `prompt-tool: applyState failed: ${error instanceof Error ? error.message : String(error)}`) }
  }
  applyConfig()
  ctx.effect(() => ctx.on('loader/volatile-update', applyConfig))

  ctx.inject(['agentPresets'], (apctx: Context) => {
    agentPresetsService = apctx.get('agentPresets') as AgentPresetsPolicyService | undefined
    const sync = createPresetRegistrySync(apctx, DEFAULT_PRESET_DIR)
    registrySync = sync
    apctx.effect(() => async () => {
      if (registrySync === sync) {
        registrySync = undefined
        agentPresetsService = undefined
      }
      await sync.dispose()
    })
    void sync.refresh().catch((error) => warn(ctx, `prompt-tool: 初始预设注册失败：${String(error)}`))
    syncTemplateFromHostDefault(undefined, true)
  })
  ctx.inject(['settings'], (sctx: Context) => {
    hostSettingsService = sctx.settings
    sctx.effect(() => sctx.settings.configure({ auto: false }, ctx.fiber))
    sctx.effect(() => () => { if (hostSettingsService === sctx.settings) hostSettingsService = undefined })
    sctx.effect(() => sctx.on('settings/document-updated', (ns) => {
      if (String(ns) === agentPresetsNs) syncTemplateFromHostDefault()
      if (String(ns) === NS) applyConfig()
    }), 'prompt-tool: follow settings documents')
    settingsBridge.invalidateDescriptor()
    syncTemplateFromHostDefault(undefined, true)
  })
}

// 公共 API：宿主与测试复用 settings schema 与提示词配置权威校验。
export { Config, PromptSettingsSchema } from './config.ts'
export { writePreset } from './host/write-preset.ts'
// AGENTS 文件卡：探测 → 卡片合成与文件写盘（bridge 端点与回归测试共用）。
export {
  agentsFileCardSpecs,
  agentsFileId,
  detectAgentsFileSnapshots,
  detectAgentsFiles,
  readAgentsFileSnapshot,
  writeAgentsFile,
  writeAgentsFileChecked,
} from './host/agents-cards.ts'
export { MAX_INSTRUCTION_FILE_BYTES, INSTRUCTION_FILE_STATUSES } from './shared/instructions.ts'
export type { InstructionContextView, InstructionFileSnapshot, InstructionFileStatus } from './shared/instructions.ts'
export { installPreStepCoordinator, PRE_STEP_COORDINATOR_SERVICE, PRE_STEP_COORDINATOR_VERSION } from './runtime/pre-step-coordinator.ts'
export type {
  PreStepCoordinatorOptions,
  PreStepCoordinatorService,
  PreStepFileContribution,
  PreStepPromptConfig,
  PreStepSource,
} from './runtime/pre-step-coordinator.ts'
export { mergeInstructionCards } from './runtime/settings-bridge.ts'
export { convertStToPreset, mergeStPresets, processStText, stPresetId } from './host/sillytavern.ts'
export { applyModuleConfigs, buildModuleConfigsFromParams, removePresetModule, savePresetParams, savePresetPersona } from './host/manifest.ts'
export { createEngineCapabilityInPreset, loadPresetSpec, removeEngineCapabilityFromPreset, renderComposition, resolvePresetModuleFacts, resolvePresetParams } from './host/manifest.ts'
export { ENGINE_PARAM_KEYS, WRITER_PARAM_KEYS, validateEngineParamValues } from './shared/engine-params.ts'
export { assertSafeConfigId, configFileName } from './host/prompt-configs.ts'
export type { EngineCapabilityCreateRequest, EngineCapabilityCreateResult, EngineCapabilityRemoveResult, PresetSpec } from './host/manifest.ts'
export {
  cloneBuiltinPreset,
  ensurePresetSeed,
  listBuiltinTemplates,
  listPresets,
  removeUserPreset,
  resolvePresetDir,
  userPresetsDir,
} from './host/manifest.ts'
export { buildWorldBookEntry } from './host/worldbook.ts'
export { expandPresetSource, exportPresetPackage, presetImportPreview, installPresetPackage } from './host/preset-package.ts'
export { ensureWebSurface, resolveProfileDir, scheduleWebSurfaceRepair } from './web-surface.ts'
export { USER_SKILLS_DIR } from './host/paths.ts'
export { importSkillsPackage } from './host/skills-import.ts'
export { detectModels, invalidateModelCatalog, listAdvertisedModels, peekModelCatalog, resolveSubagentStartOptions } from './runtime/models.ts'
export type { PluginSubagentSeam } from './runtime/models.ts'
export type { WritePresetOptions } from './host/write-preset.ts'
export { validatePromptConfigs } from './runtime/configs-validate.ts'
export { registerSettingsBridge } from './runtime/settings-bridge.ts'
export { registerCharacterTools } from './runtime/character-tools.ts'
export { registerWorldBookTools } from './runtime/world-book-tools.ts'
export {
  appendCharacterMemory,
  appendMemoryFile,
  applyCharacterToPreset,
  CHARACTER_MODULES_KEY,
  characterModuleStillNeeded,
  declaredCharacterModules,
  deleteCharacterCard,
  importCharacterCard,
  importCharacterCardFile,
  listCharacterCards,
  readCharacterMemory,
  recordedCharacterModules,
  removeCharacterFromPreset,
  requiredCharacterModules,
  syncImportedCharacterMemory,
} from './host/characters.ts'
export type { CharacterModuleContext } from './host/characters.ts'
export { deleteWorldBookEntry, listWorldBookEntries, upsertWorldBookEntry } from './host/worldbook.ts'
export type { PromptConfigValidationError, PromptConfigValidationResult } from './runtime/configs-validate.ts'
export { loadPromptTemplates, loadToolTemplates } from './host/templates.ts'
export type { PromptConfigTemplate, ToolTemplate } from './host/templates.ts'
export { registerTuiCommand } from './runtime/tui.ts'
export { readSkillsState, writeSkillsState, skillsStatePath, SKILL_NAME_PATTERN } from './host/skills-config.ts'
export type { SkillCatalogEntry, SkillPolicyChange, SkillPolicyScope, SkillsCatalogSnapshot, SkillsState } from './shared/skills.ts'
export { invocationForScope, scopeOfInvocation } from './shared/skills.ts'
export { readSkillInvocation, setSkillInvocation } from './host/skills-policy.ts'
export type { SkillPolicyRead, SkillPolicyWrite } from './host/skills-policy.ts'
export { createSkillsReloader } from './host/skills-refresh.ts'
export { createSkillsRuntime } from './host/skills-runtime.ts'
export type { SkillsRuntime } from './host/skills-runtime.ts'
export { catalogFromScan, resolveProjectRoot, scanRoot, scanRoots, skillRoots } from './host/skills-scan.ts'
export { PARAM_KEYS } from './config.ts'
export { BRIDGE_ENDPOINTS, MAX_BRIDGE_BODY_BYTES, MAX_CHARACTER_CARD_STREAM_BYTES, SETTINGS_BRIDGE_PREFIX } from './shared/bridge-contract.ts'
export type { BridgeEndpoint, BridgeErrorPayload, BridgeRequestMap, BridgeValueMap } from './shared/bridge-contract.ts'
export { ENGINE_CAPABILITIES, ENGINE_RECIPES, engineCapability, engineRecipe, isEngineCapabilityPresent, validateCustomToolIdentities } from './shared/engine-capabilities.ts'
export type { EngineCapability, ModuleSourceMode, PresetModuleFacts } from './shared/engine-capabilities.ts'
export { parseFrontmatter } from './runtime/skills-parse.ts'
export type { SkillFrontmatter } from './runtime/skills-parse.ts'
export { DEFAULT_PRESET_ID } from './shared/preset-ids.ts'
