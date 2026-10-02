import type { Context } from '@deepseek-ai/cordis'
import type SettingsService from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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
import { DEFAULT_PRESET_DIR, MODULE_CONFIGS_DIR } from './host/paths.ts'
import { DEFAULT_PRESET_ID } from './shared/preset-ids.ts'
import { createSkillsRuntime } from './host/skills-runtime.ts'
import { createPresetRegistrySync, presetDirExists } from './host/preset-registry.ts'
import { createAgentAssembly } from './runtime/agent-assembly.ts'
import { resolvePresetToolTarget } from './host/preset-tool-target.ts'
import type { PresetToolHost } from './host/preset-tool-target.ts'

export const name = 'prompt-tool'
// 内容走 user 层（AGENTS.md 常驻层 + skill 按需层），
// 不再注册 system prompt section（否则会被 persona 的 complete:true 整个清零）。
// 注意：webServer 不放在静态 inject 里——profile 首次可能只有
// @deepseek-ai/dsh-base（没有 @deepseek-ai/dsh-web-app），硬注入会让插件
// pending 并导致启动失败。Web 表面动态等待 webServer，缺失时仅诊断；
// profile 装配交给官方插件管理流程。
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
  const refreshPresets = (forceIds?: readonly string[]): Promise<void> =>
    registrySync?.refresh(forceIds) ?? Promise.reject(new Error('agentPresets 服务尚未就绪，预设已保存但尚未注册'))
  const modelsState = (): ModelDetection => detectModels(ctx)
  const getModelsState = (): ModelDetection => modelsState()
  // 内容资产优先读生成目录文件（writePreset 落盘），模板 content 作回退；
  // settings.yaml 不再承载大文本（web 打开加载慢的根因）。
  const initialTemplate = typeof config.presetTemplate === 'string' && config.presetTemplate.length > 0
      ? config.presetTemplate
      : DEFAULT_PRESET_ID
  // 插件自有预设存储：每份定义独立保存在 DEFAULT_PRESET_DIR/<template>/。
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
  const rebuildPreset = async (initial = false, id = runtime.presetTemplate): Promise<void> => {
    // 旧会话可继续编辑自身预设；不能借用工作台当前草稿或改动其 runtime。
    if (id !== runtime.presetTemplate && runtime.writePreset) {
      const dir = resolvePresetDir(id)
      const params = resolvePresetParams(loadPresetSpec(dir), {})
      const prompt = readGeneratedContent(dir, 'preset.md') || readPromptFile(id, runtime.fallbackText)
      writePreset(params.injectPrompt === false ? '' : prompt, {
        ...params,
        presetDir: DEFAULT_PRESET_DIR,
        presetOrder: runtime.presetOrder,
        presetTemplate: id,
        outputId: id,
        promptConfigs: [],
        agentsInstructionText: readGeneratedContent(dir, 'agents.md') || readAgents(id),
        warn: (message) => warn(ctx, message),
      })
      await refreshPresets([id])
      return
    }
    // 先重读激活预设参数（/param-overrides 保存、TUI 开关、预设切换后生效）。
    reloadPresetParams()
    const rebuiltIds = new Set([id])
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
          rebuiltIds.add(preset.id)
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
      // 保留空组合供注册层读取：缺少组合会使刷新失败并继续保留旧 revision；
      // 空组合可正常注册，后续会话停止注入，重新开启后由重建恢复。
      // 绝不删除整个用户预设目录（旧版误删预设根：用户全部预设、
      // 种子标记 .pt-seeded、共享 .engine 一并清空）。
      let cleaned = 0
      for (const preset of listPresets()) {
        const dir = join(DEFAULT_PRESET_DIR, preset.id)
        for (const name of [MODULE_CONFIGS_DIR, 'custom-tools', 'preset.md', 'agents.md', 'agents-instruction.md', 'engine']) {
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
    // 首次物化发生在服务注入前；稍后的 agentPresets 回调负责注册，用户保存则必须等待。
    if (!initial || registrySync !== undefined) {
      await refreshPresets(runtime.writePreset ? [...rebuiltIds] : listPresets().map((preset) => preset.id))
    }
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
      readSkillContent: skillsRuntime.readContent,
      writeSkillContent: skillsRuntime.writeContent,
      patchSkillFolders: skillsRuntime.setFolders,
    }),
    // 模板专属策略目录：当前内置策略全部随引擎提供，自定义模板可经此注入。
    () => '',
    skillsRuntime.invalidate,
    // 激活预设目录：内容资产/提示词配置按预设隔离在预设根 <template>/。
    () => activePresetDir(),
    async (scopes) => {
      // 内容导入后：批量更新运行时文本，单次重建生成目录（一次自动保存只重建一次）。
      for (const scope of scopes) {
        if (scope === 'preset') current = readGeneratedContent(activePresetDir(), 'preset.md')
        else currentAgents = readGeneratedContent(activePresetDir(), 'agents.md')
      }
      await rebuildPreset()
    },
    () => rebuildPreset(),
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
    () => rebuildPreset(),
    (id) => refreshPresets([id]),
  )

  // 装配结束后只读诊断 Web 能力；插件卸载时取消任务，不编辑 profile。
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

  // 与官方 agent-preset-registry 的关系是**只读跟随**：本插件不再向宿主写
  // `selectedDefault`。登记层只登记身份（组合本体为空），把官方默认预设指到本插件的
  // 预设会让会话挂载一个不含官方工具行的空壳——会话不可用。官方默认预设由用户或
  // 部署在宿主侧决定；本插件只跟随「官方生效默认值」里那些自己管理的预设。
  //
  // 单向跟随也没有回环：写入侧已不存在，因此不需要 revision 比较或双向事件防护。
  const agentPresetsNs = 'agent-preset-registry' as const
  let hostSettingsService: SettingsService | undefined
  /** 官方生效默认值（包含未设置 selectedDefault 时的部署回退）。 */
  let agentPresetsService: Context['agentPresets'] | undefined
  const managedPresetExists = (id: string): boolean => {
    try {
      return listPresets().some(preset => preset.id === id)
    } catch {
      return false
    }
  }
  /** 跟随官方当前默认预设：不是本插件管理的预设（shipped/第三方）一律不跟。 */
  const syncTemplateFromHostDefault = (): void => {
    const s = hostSettingsService
    if (s === undefined) return
    // 官方 getter 负责 selectedDefault 与部署 default 的优先级；迟到时由 inject 重试。
    const template = agentPresetsService?.defaultId
    if (template === undefined) return
    if (template === runtime.presetTemplate) return
    if (!managedPresetExists(template)) return
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
  async (key, value) => {
    if (key === 'promptConfigs') {
      savePresetParams(DEFAULT_PRESET_DIR, runtime.presetTemplate, undefined, Array.isArray(value) ? value as unknown[] : undefined)
    } else {
      savePresetParams(DEFAULT_PRESET_DIR, runtime.presetTemplate, { [key]: value }, undefined)
    }
    reloadPresetParams()
    await rebuildPreset()
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

  // 运行时配装通道：每个 Agent 在自己的 scope 里得到一份装配（切片 + 引擎能力）。
  // 官方工具行由会话原有预设提供，本通道不装第二棵官方插件树；两者并存不重复。
  ctx.inject(['agents'], (actx: Context) => {
    const assembly = createAgentAssembly(actx, {
      presetRoot: DEFAULT_PRESET_DIR,
      currentPreset: () => runtime.presetTemplate.length > 0 ? runtime.presetTemplate : DEFAULT_PRESET_ID,
      warn: (message) => warn(ctx, message),
    })
    actx.effect(() => () => assembly.dispose(), 'prompt-tool assembly')
  })

  let needsInitialApply = true
  const applyState = async (): Promise<void> => {
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

    await rebuildPreset(initial)
    // 切换预设只影响本插件的物化与配装，不再向宿主写 selectedDefault。
    // 内置工具面随组合行走（per-session 挂载），无需宿主平面重挂。
  }

  // 内置模型工具由三个独立预设模块按需挂载；宿主只提供对应注册服务。
  const presetToolHost: PresetToolHost = {
    target: (exec) => resolvePresetToolTarget(ctx, exec, DEFAULT_PRESET_DIR, (id) => presetDirExists(DEFAULT_PRESET_DIR, id)),
    rebuild: (id) => rebuildPreset(false, id),
  }
  ctx.provide('pt-character-tools', {
    mount: (scopeCtx: Context): (() => void) => registerCharacterTools(scopeCtx, presetToolHost),
  })
  ctx.provide('pt-world-book-tools', {
    mount: (scopeCtx: Context): (() => void) => registerWorldBookTools(scopeCtx, presetToolHost),
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
    void applyState().catch((error) => warn(ctx, `prompt-tool: applyState failed: ${error instanceof Error ? error.message : String(error)}`))
  }
  applyConfig()
  ctx.effect(() => ctx.on('loader/volatile-update', applyConfig))

  ctx.inject(['agentPresets'], (apctx: Context) => {
    agentPresetsService = apctx.agentPresets
    const sync = createPresetRegistrySync(apctx, DEFAULT_PRESET_DIR)
    registrySync = sync
    apctx.effect(() => async () => {
      if (registrySync === sync) {
        registrySync = undefined
        agentPresetsService = undefined
      }
      await sync.dispose()
    })
    void sync.refresh().catch((error) => warn(ctx, `prompt-tool: 初始预设登记失败：${String(error)}`))
    syncTemplateFromHostDefault()
  })
  ctx.inject(['settings'], (sctx: Context) => {
    hostSettingsService = sctx.settings
    sctx.effect(() => sctx.settings.configure({ auto: false }, ctx.fiber))
    sctx.effect(() => () => { if (hostSettingsService === sctx.settings) hostSettingsService = undefined })
    sctx.effect(() => sctx.on('settings/document-updated', (ns) => {
      // 官方默认预设变了就跟随；写入侧已不存在，无需防止回环。
      if (String(ns) === agentPresetsNs) syncTemplateFromHostDefault()
      if (String(ns) === NS) applyConfig()
    }), 'prompt-tool: follow settings documents')
    settingsBridge.invalidateDescriptor()
    syncTemplateFromHostDefault()
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
export { createPresetRegistrySync, presetDirExists } from './host/preset-registry.ts'
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
