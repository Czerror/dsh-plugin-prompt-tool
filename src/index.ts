import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { basename, join } from 'node:path'
import { saveModuleParams } from './host/manifest.ts'
import { scheduleWebSurfaceRepair } from './web-surface.ts'
import { detectModels, invalidateModelCatalog, listAdvertisedModels } from './runtime/models.ts'
import type { ModelDetection } from './runtime/models.ts'
import { registerSettingsBridge } from './runtime/settings-bridge.ts'
import { registerCharacterTools } from './runtime/character-tools.ts'
import { registerWorldBookTools } from './runtime/world-book-tools.ts'
import { registerSessionVarTools } from './runtime/session-var-tools.ts'
import { installPreStepCoordinator } from './runtime/pre-step-coordinator.ts'
import { registerTuiCommand } from './runtime/tui.ts'
import { ensureModuleReady } from './host/write-module.ts'
import {
  ensureModuleSeed,
  moduleDirExists,
} from './host/manifest.ts'
import {
  Config,
  NS,
  readModulesEnabled,
} from './config.ts'
import type { PromptSettings, RuntimeOptions } from './config.ts'
import { MODULES_DIR } from './host/paths.ts'
import { enabledModuleIds, resolveEditDir } from './host/config-store.ts'
import { DEFAULT_MODULE_ID } from './shared/module-ids.ts'
import { ensureSkillSeed } from './host/skills-actions.ts'
import { createSkillsRuntime } from './host/skills-runtime.ts'
import { createAgentAssembly } from './runtime/agent-assembly.ts'
import type { AgentAssemblyRuntime } from './runtime/agent-assembly.ts'
import { resolveModuleToolTarget } from './host/module-tool-target.ts'
import type { ModuleToolHost } from './host/module-tool-target.ts'

export const name = 'prompt-tool'
// 内容走 user 层（AGENTS.md 常驻层 + skill 按需层），
// 不再注册 system prompt section（否则会被 persona 的 complete:true 整个清零）。
// 注意：webServer 不放在静态 inject 里——profile 首次可能只有
// @deepseek-ai/dsh-base（没有 @deepseek-ai/dsh-web-app），硬注入会让插件
// pending 并导致启动失败。Web 表面动态等待 webServer，缺失时仅诊断；
// profile 装配交给官方插件管理流程。
export const inject = ['skills', 'commands', 'llm', 'subagents']

function warn(ctx: Context, message: string): void {
  try {
    ctx.logger?.warn(message)
  } catch {
    // 日志不可用时保持静默，避免二次故障掩盖主路径。
  }
}

export function apply(ctx: Context, configIn: Config): void {
  // 包内目录与输出目录同名；启动只复制缺失项，现有用户定义不被重新铺写。
  const seededModules = new Set(ensureModuleSeed(MODULES_DIR).created)
  // 内置技能同一纪律：只补缺失项，用户改过或删过的技能保持原样。
  ensureSkillSeed()
  const readConfig = () => ({
    modulesEnabled: readModulesEnabled({ modulesEnabled: configIn.modulesEnabled?.get() }),
  })
  const config = readConfig()
  /** 运行时配装通道的运行态：工具写入目标按它报告的「本 Agent 装了哪几层提示词」解析。 */
  let assembly: AgentAssemblyRuntime | undefined
  const modelsState = (): ModelDetection => detectModels(ctx)
  const getModelsState = (): ModelDetection => modelsState()
  // 运行态只保留部署设置；每次保存都从目标模块重读参数和正文。
  const runtime: RuntimeOptions = {
    ...config,
  }
  const refreshModuleSlices = (id: string): void => {
    ensureModuleReady(id, {
      modulesRoot: MODULES_DIR,
      warn: (message) => warn(ctx, message),
    })
  }
  const refreshModuleRuntime = async (id = basename(activeModuleDir())): Promise<void> => {
    refreshModuleSlices(id)
    await assembly?.refresh(id)
  }

  /** 无请求目标时供TUI使用的模块；编辑器的显式ID始终单独解析。 */
  const activeModuleDir = (): string =>
    resolveEditDir(MODULES_DIR) || (moduleDirExists(MODULES_DIR, DEFAULT_MODULE_ID) ? join(MODULES_DIR, DEFAULT_MODULE_ID) : '')

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
    // 显式目标不存在就拒绝，不能落到另一个模块；编辑选择不进入部署设置。
    (moduleId) => moduleId === undefined ? activeModuleDir() : resolveEditDir(MODULES_DIR, moduleId),
    (id) => id === undefined ? assembly?.refresh() : refreshModuleRuntime(id),
    // host 已安装完整候选；不能二次物化覆盖导入资产。
    async (id) => {
      skillsRuntime.invalidate()
      await assembly?.refresh(id)
    },
    (id) => refreshModuleRuntime(id),
    () => assembly?.refresh(),
  )

  // 装配结束后只读诊断 Web 能力；插件卸载时取消任务，不编辑 profile。
  scheduleWebSurfaceRepair(ctx, (message) => warn(ctx, message))

  // provider 拓扑变化（适配器注册/移除）会让已缓存的模型目录过期：
  // 订阅官方 payload-free 事件，按 Context 失效缓存；监听器挂在 effect 上，重挂无残留。
  ctx.effect(() => ctx.on('llm/adapters-updated', () => invalidateModelCatalog(ctx)))

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
  () => activeModuleDir(),
  // TUI 参数开关：写激活模块 module.yml（settings 不再承载引擎参数）。
  // 保存/重建失败直接抛给命令层，由 CommandResult:error 呈现给用户。
  async (key, value) => {
    saveModuleParams(MODULES_DIR, basename(activeModuleDir()), { [key]: value }, undefined)
    await refreshModuleRuntime()
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
  (id) => refreshModuleRuntime(id),
)

  let needsInitialApply = true
  const applyState = async (): Promise<void> => {
    const next = currentSource()
    const nextRuntime: RuntimeOptions = {
      modulesEnabled: next.modulesEnabled,
    }
    const modulesEnabledChanged = runtime.modulesEnabled !== nextRuntime.modulesEnabled
    if (!needsInitialApply && !modulesEnabledChanged) return
    const initial = needsInitialApply
    needsInitialApply = false

    Object.assign(runtime, nextRuntime)
    if (initial) {
      for (const id of seededModules) refreshModuleSlices(id)
      seededModules.clear()
    }
    // 总闸只撤回/恢复运行时贡献，物化文件保留；关闭期间保存仍可重建。
    await assembly?.refresh()
  }

  // 内置模型工具由三个独立模块按需挂载；宿主只提供对应注册服务。
  const moduleToolHost: ModuleToolHost = {
    // 写入目标按该 Agent 的运行时配装记录解析（启用表 ∩ 磁盘，多个时取第一个），
    // 不再查询官方 `agentPresets` 的会话绑定。
    target: (exec) => resolveModuleToolTarget(exec, MODULES_DIR, (sessionId) => assembly?.moduleIds(sessionId) ?? []),
    rebuild: (id) => refreshModuleRuntime(id),
  }
  ctx.provide('pt-character-tools', {
    mount: (scopeCtx: Context): (() => void) => registerCharacterTools(scopeCtx, moduleToolHost),
  })
  ctx.provide('pt-world-book-tools', {
    mount: (scopeCtx: Context): (() => void) => registerWorldBookTools(scopeCtx, moduleToolHost),
  })
  ctx.provide('pt-session-var-tools', {
    mount: (scopeCtx: Context): (() => void) => registerSessionVarTools(scopeCtx),
  })

  // 技能按需发现：`skill_search` / `skill_load` 注册到宿主侧（不是模块路径），
  // 因此对所有 Agent 生效、不依赖任何预设。与 `skill-surface` 模块配对——
  // 删掉全量技能目录 + 给出搜索，缺一不可。
  //
  // 动态导入而非静态：`engine/skill-search.mjs` 顶层经 `importHostPackage` 解析
  // `@deepseek-ai/dsh-skill`（从宿主入口 realpath 解析），解析不到时静态导入会
  // 让**整个 prompt-tool 插件挂载失败**。这里失败只记一条告警、不挂这两个工具，
  // 其余能力照常——符合「任何一步停下插件都完整可用」。
  void import(new URL('../engine/skill-search.mjs', import.meta.url).href)
    .then((mod: { apply?: (ctx: Context) => unknown, inject?: readonly string[] }) => {
      if (typeof mod.apply !== 'function') return
      ctx.inject(mod.inject ?? ['tools'], (skillCtx: Context) => { void mod.apply?.(skillCtx) })
    })
    .catch((error: unknown) => {
      warn(ctx, `prompt-tool: skill-search 未挂载（skill_search/skill_load 不可用）：${error instanceof Error ? error.message : String(error)}`)
    })

  // pre-step 协调器：引擎在每次 pre-step 查询本服务（ctx.get('promptToolPreStep')），
  // 不注册第二个 pre-step 监听器；旧生成目录的 `agents-file-*` 卡在这里按 id 前缀跳过。
  // 策略缺省 enabled=false；服务缺失时引擎只执行模块卡（独立引擎复制场景）。
  installPreStepCoordinator(ctx)

  // 私有工具服务与协调器就绪后，再按官方 Agent 生命周期挂载既有引擎。
  ctx.inject(['agents'], (actx: Context) => {
    const mounted = createAgentAssembly(actx, {
      moduleRoot: MODULES_DIR,
      enabledModules: () => runtime.modulesEnabled
        ? enabledModuleIds(MODULES_DIR).filter((id) => moduleDirExists(MODULES_DIR, id))
        : [],
      warn: (message) => warn(ctx, message),
    })
    assembly = mounted
    actx.effect(() => () => {
      if (assembly === mounted) assembly = undefined
      return mounted.dispose()
    }, 'prompt-tool assembly')
  })

  const applyConfig = (): void => {
    settingsBridge.invalidateDescriptor()
    void applyState().catch((error) => warn(ctx, `prompt-tool: applyState failed: ${error instanceof Error ? error.message : String(error)}`))
  }
  applyConfig()
  ctx.effect(() => ctx.on('loader/volatile-update', applyConfig))

  ctx.inject(['settings'], (sctx: Context) => {
    sctx.effect(() => sctx.settings.configure({ auto: false }, ctx.fiber))
    sctx.effect(() => sctx.on('settings/document-updated', (ns) => {
      if (String(ns) === NS) applyConfig()
    }), 'prompt-tool: follow settings documents')
    settingsBridge.invalidateDescriptor()
  })
}

// 公共 API：宿主与测试复用 settings schema 与提示词配置权威校验。
export { Config } from './config.ts'
export { ensureModuleReady, writeModule } from './host/write-module.ts'
export type { WriteModuleOptions } from './host/write-module.ts'
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
export { convertStToModule, convertStToModuleWithReport, mergeStModules, mergeStModulesWithReport, processStText, stModuleId } from './host/sillytavern.ts'
export { applyModuleConfigs, appendModuleCapabilities, buildModuleConfigsFromParams, removeModuleCapabilityDeclaration, saveModuleParams, saveModulePersona, withModuleDefinition } from './host/manifest.ts'
export { createModuleCapability, loadModuleSpec, removeModuleCapability, renderComposition, resolveModuleFacts, resolveModuleParams } from './host/manifest.ts'
export { ENGINE_PARAM_KEYS, WRITER_PARAM_KEYS, validateEngineParamValues } from './shared/engine-params.ts'
export { assertSafeConfigId, configFileName } from './host/prompt-configs.ts'
export type { ModuleCapabilityCreateRequest, ModuleCapabilityCreateResult, ModuleCapabilityRemoveResult, ModuleSpec } from './host/manifest.ts'
export {
  cloneBuiltinModule,
  ensureModuleSeed,
  listBuiltinTemplates,
  listModules,
  moduleDirExists,
  removeUserModule,
  resolveModuleDir,
  userModulesDir,
} from './host/manifest.ts'
export { buildWorldBookEntry } from './host/worldbook.ts'
export { expandModuleSource, exportModulePackage, moduleImportPreview, installModulePackage } from './host/module-package.ts'
export { ensureWebSurface, resolveProfileDir, scheduleWebSurfaceRepair } from './web-surface.ts'
export { USER_SKILLS_DIR } from './host/paths.ts'
export { importSkillsPackage } from './host/skills-import.ts'
export { detectModels, invalidateModelCatalog, listAdvertisedModels, peekModelCatalog, resolveSubagentStartOptions } from './runtime/models.ts'
export type { PluginSubagentSeam } from './runtime/models.ts'
export { registerSettingsBridge } from './runtime/settings-bridge.ts'
export { registerCharacterTools } from './runtime/character-tools.ts'
export { registerWorldBookTools } from './runtime/world-book-tools.ts'
export {
  appendModuleMemory,
  readModuleMemory,
  mergeModuleIntoModule,
  removeMergedModule,
  importCharacterCard,
  importCharacterCardFile,
} from './host/characters.ts'
export { deleteWorldBookEntry, listWorldBookEntries, upsertWorldBookEntry } from './host/worldbook.ts'
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
export { MODULE_CAPABILITIES, INJECTION_POINT_ORDER, ENGINE_RECIPES, moduleCapability, engineRecipe, isModuleCapabilityPresent, validateCustomToolIdentities } from './shared/engine-capabilities.ts'
export type { InjectionPoint, ModuleCapability, ModuleSourceMode, ModuleFacts } from './shared/engine-capabilities.ts'
export { assertModuleId, assertModuleDirectory, assertModuleTree, canonicalModulesRoot, modulePathExists } from './host/module-install.ts'
export { ModuleLayerSettingsError, readModuleLayerSettings } from './host/module-layer-settings.ts'
export type { ModuleWriterParams } from './shared/engine-params.ts'
export type { ModuleSummary } from './shared/bridge-contract.ts'
export type { ModuleExportRequest, ModuleExportResult } from './shared/asset-transfer.ts'
export { MODULE_CAPABILITIES as ENGINE_CAPABILITIES, moduleCapability as engineCapability, isModuleCapabilityPresent as isEngineCapabilityPresent } from './shared/engine-capabilities.ts'
export type { ModuleCapability as EngineCapability } from './shared/engine-capabilities.ts'
export { parseFrontmatter } from './runtime/skills-parse.ts'
export type { SkillFrontmatter } from './runtime/skills-parse.ts'
export { DEFAULT_MODULE_ID } from './shared/module-ids.ts'
