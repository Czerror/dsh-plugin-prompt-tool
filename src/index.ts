import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { saveModuleParams } from './host/module-definition-edit.ts'
import { scheduleWebSurfaceRepair } from './web-surface.ts'
import { detectModels, invalidateModelCatalog, listAdvertisedModels } from './runtime/models.ts'
import type { ModelDetection } from './runtime/models.ts'
import { registerSettingsBridge } from './runtime/settings-bridge.ts'
import { registerModuleImportTools } from './runtime/module-import-tools.ts'
import { registerModuleRuleTools } from './runtime/module-rule-tools.ts'
import { registerModuleFileTools } from './runtime/module-file-tools.ts'
import { registerModuleManifestTools } from './runtime/module-manifest-tools.ts'
import { registerModuleVariableTools } from './runtime/module-variable-tools.ts'
import { registerSoulLedgerTools } from './runtime/soul-ledger-tools.ts'
import { installSoulRuntime } from './runtime/soul-runtime.ts'
import { installPreStepCoordinator } from './runtime/pre-step-coordinator.ts'
import { installPersonaCapture } from './runtime/persona-registration.ts'
import { registerTuiCommand } from './runtime/tui.ts'
import { registerTuiSettingsSection, settingsNamespace } from './runtime/tui-settings.ts'
import { ensureModuleReady } from './host/write-module.ts'
import { ensureModuleSeed } from './host/module-catalog.ts'
import { moduleDirExists } from './host/module-dirs.ts'
import {
  Config,
  readModulesEnabled,
} from './config.ts'
import type { PromptSettings, RuntimeOptions } from './config.ts'
import { modulesDir } from './host/paths.ts'
import { enabledModuleIds, resolveRequestedModuleDir } from './host/config-store.ts'
import { selectedPersonaModules } from './host/persona-selection.ts'
import { ensureSkillSeed } from './host/skills-actions.ts'
import { createSkillsRuntime } from './host/skills-runtime.ts'
import { createAgentAssembly } from './runtime/agent-assembly.ts'
import type { AgentAssemblyRuntime } from './runtime/agent-assembly.ts'
import { emptyRuleDiagnostics } from './runtime/rule-diagnostics.ts'
import { resolveModuleToolTarget } from './host/module-tool-target.ts'
import { createManifestCheckReader } from './host/module-manifest-check.ts'
import type { ModuleToolHost } from './host/module-tool-target.ts'
// 服务名真值源在引擎侧：引擎可单独复制，名字随 `engine/` 一起走。
import { DISCOVERY_SERVICE, MANIFEST_CHECK_SERVICE, toolServiceName } from '../engine/service-names.mjs'
import { createDiscoveryRegistry } from '../engine/discovery.mjs'

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
  // settings 区块与命令都按 Config owner 的实际 Loader 行 id 寻址，换行 id 装配时不静默失配。
  const settingsNs = settingsNamespace(ctx)
  // 包内目录与输出目录同名；启动只复制缺失项，现有用户定义不被重新铺写。
  const seededModules = new Set(ensureModuleSeed(modulesDir(), message => warn(ctx, message)).created)
  // 内置技能同一纪律：只补缺失项，已有目录不碰；删掉的会被这次启动补回。
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
      modulesRoot: modulesDir(),
      warn: (message) => warn(ctx, message),
    })
  }
  const refreshModuleRuntime = async (id: string): Promise<void> => {
    refreshModuleSlices(id)
    await assembly?.refresh(id)
  }

  // 宿主模块拥有技能状态、官方引用 provider 与资产操作的生命周期。
  const skillsRuntime = createSkillsRuntime(ctx)

  // 在线编辑不再经 ctx.llm 暴露 settings namespace：改为自建 loopback bridge，
  // 这样模型设置页不会出现「提示词工具」目录条目。
  const settingsBridge = registerSettingsBridge(ctx, {
    ns: settingsNs,
    models: getModelsState,
    skills: () => ({
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
    afterSkillsChange: skillsRuntime.invalidate,
    // 显式目标不存在就拒绝，不能落到另一个模块；编辑选择不进入部署设置。
    moduleDirectory: (subject) => resolveRequestedModuleDir(modulesDir(), subject),
    overridesChanged: (id) => id === undefined ? assembly?.refresh() : refreshModuleRuntime(id),
    // host 已安装完整候选；不能二次物化覆盖导入资产。
    moduleInstalled: async (id) => {
      skillsRuntime.invalidate()
      await assembly?.refresh(id)
    },
    capabilityChanged: (id) => id === undefined ? assembly?.refresh() : refreshModuleRuntime(id),
    moduleListChanged: () => assembly?.refresh(),
    schedulePublication: (id, reason) => {
      if (reason === 'installed') skillsRuntime.invalidate()
      assembly?.schedule(reason === 'list' ? undefined : id)
    },
    publicationFailures: () => assembly?.publicationFailures() ?? [],
    // 账本随装配实例创建/释放；没有实例时回空账，不保留上一实例的计数。
    ruleDiagnostics: () => assembly?.ruleDiagnostics() ?? emptyRuleDiagnostics(),
    warn: message => warn(ctx, message),
  })

  // 装配结束后只读诊断 Web 能力；插件卸载时取消任务，不编辑 profile。
  scheduleWebSurfaceRepair(ctx, (message) => warn(ctx, message))

  // provider 拓扑变化（适配器注册/移除）会让已缓存的模型目录过期：
  // 订阅官方 payload-free 事件，按 Context 失效缓存；监听器挂在 effect 上，重挂无残留。
  ctx.effect(() => ctx.on('llm/adapters-updated', () => invalidateModelCatalog(ctx)))

  const currentSource = (): PromptSettings => ({
    ...readConfig(),
    modelsAvailable: getModelsState().available,
  })

  // dsh-tui 设置入口：/settings 的「常规」页一节，只暴露 settings 文档里的模块总开关。
  registerTuiSettingsSection(ctx, settingsNs)

  // dsh-tui 命令入口：/prompt-tool 查看或切换开关。
registerTuiCommand(
  ctx,
  settingsNs,
  () => ({ ...currentSource(), skillCatalog: skillsRuntime.listSkills(), activeSkillsDirs: [skillsRuntime.skillsRoot], enabledModules: enabledModuleIds(modulesDir()).filter((id) => moduleDirExists(modulesDir(), id)) }),
  getModelsState,
  () => listAdvertisedModels(ctx),
  // TUI 的主语由命令里的 `module <id>` 显式声明：这里只把声明的 id 解析成目录，未声明解析为空。
  (moduleId) => resolveRequestedModuleDir(modulesDir(), moduleId),
  // TUI 参数开关：写这次声明的模块 module.yml（settings 不再承载引擎参数）。
  // 保存/重建失败直接抛给命令层，由 CommandResult:error 呈现给用户。
  async (moduleId, key, value) => {
    saveModuleParams(modulesDir(), moduleId, { [key]: value }, undefined)
    await refreshModuleRuntime(moduleId)
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
    root: modulesDir(),
    // 写入目标由这次工具调用显式声明的 moduleId 定位；该 Agent 已启用的模块只作拒绝提示。
    target: (exec, moduleId) => resolveModuleToolTarget(exec, modulesDir(), (sessionId) => assembly?.moduleIds(sessionId) ?? [], moduleId),
    rebuild: (id) => refreshModuleRuntime(id),
  }
  installSoulRuntime(ctx, moduleToolHost, id => assembly?.moduleIds(id) ?? [])
  ctx.provide(toolServiceName('module-import-tools'), {
    mount: (scopeCtx: Context): (() => void) => registerModuleImportTools(scopeCtx, { ...moduleToolHost, rebuild: async id => { await assembly?.refresh(id) } }),
  })
  ctx.provide(toolServiceName('module-rule-tools'), {
    mount: (scopeCtx: Context): (() => void) => registerModuleRuleTools(scopeCtx, moduleToolHost),
  })
  ctx.provide(toolServiceName('module-file-tools'), {
    mount: (scopeCtx: Context): (() => void) => registerModuleFileTools(scopeCtx, moduleToolHost),
  })
  ctx.provide(toolServiceName('module-manifest-tools'), {
    mount: (scopeCtx: Context): (() => void) => registerModuleManifestTools(scopeCtx, moduleToolHost),
  })
  ctx.provide(toolServiceName('soul-ledger'), {
    mount: (scopeCtx: Context): (() => void) => registerSoulLedgerTools(scopeCtx, moduleToolHost),
  })
  ctx.provide(DISCOVERY_SERVICE, createDiscoveryRegistry())
  ctx.provide(MANIFEST_CHECK_SERVICE, createManifestCheckReader(modulesDir()))
  ctx.provide(toolServiceName('module-variable-tools'), {
    mount: (scopeCtx: Context): (() => void) => registerModuleVariableTools(scopeCtx, moduleToolHost),
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
      ctx.inject(mod.inject ?? ['tools'], (skillCtx: Context) => {
        const dispose = (mod as { apply?: (ctx: Context, config?: unknown, options?: { agent?: unknown }) => unknown }).apply?.(skillCtx)
        if (typeof dispose === 'function') skillCtx.effect(() => dispose as () => void, 'skill-search')
      })
    })
    .catch((error: unknown) => {
      warn(ctx, `prompt-tool: skill-search 未挂载（skill_search/skill_load 不可用）：${error instanceof Error ? error.message : String(error)}`)
    })

  // pre-step 协调器：引擎在每次 pre-step 用共享服务名（`engine/service-names.mjs`）查询本服务，
  // 不注册第二个 pre-step 监听器；旧生成目录的 `agents-file-*` 卡在这里按 id 前缀跳过。
  // 策略缺省 enabled=false；服务缺失时引擎只执行模块卡（独立引擎复制场景）。
  installPreStepCoordinator(ctx)

  // 人设适配属于主插件运行态，不作为官方服务的启动依赖；来源选择不隐式启用其普通规则。
  const personaModules = () => runtime.modulesEnabled ? selectedPersonaModules(modulesDir()) : []
  const personaCapture = installPersonaCapture(ctx)
  ctx.effect(function* () {
    yield () => personaCapture.dispose()
    const agentsFiber = ctx.inject(['agents', MANIFEST_CHECK_SERVICE], (actx: Context) => {
      const mounted = createAgentAssembly(actx, {
        moduleRoot: modulesDir(),
        enabledModules: () => runtime.modulesEnabled
          ? enabledModuleIds(modulesDir())
          : [],
        personaModules,
        personaCapture,
        warn: (message) => warn(ctx, message),
      })
      assembly = mounted
      actx.effect(() => () => {
        if (assembly === mounted) assembly = undefined
        return mounted.dispose()
      }, 'prompt-tool assembly')
    })
    yield () => agentsFiber.dispose()
  }, 'prompt-tool persona and assembly')

  const applyConfig = (): void => {
    settingsBridge.invalidateDescriptor()
    void applyState().catch((error) => warn(ctx, `prompt-tool: applyState failed: ${error instanceof Error ? error.message : String(error)}`))
  }
  applyConfig()
  ctx.effect(() => ctx.on('loader/volatile-update', applyConfig))

  ctx.inject(['settings'], (sctx: Context) => {
    sctx.effect(() => sctx.settings.configure({ auto: false }, ctx.fiber))
    sctx.effect(() => sctx.on('settings/document-updated', (ns) => {
      if (String(ns) === settingsNs) applyConfig()
    }), 'prompt-tool: follow settings documents')
    settingsBridge.invalidateDescriptor()
  })
}

// 发布入口只留真实消费：插件协议（name/inject/Config/apply）+ 从构建产物引导的符号——
// 测试的模板路径锚（loadPromptTemplates）与重物化脚本（writeModule/userModulesDir）。
// Config 是 Cordis 的配置 schema：缺了它，原始 config 会原样传入 apply，modulesEnabled 不是 schema 实例。
export { Config } from './config.ts'
export { loadPromptTemplates } from './host/templates.ts'
export { writeModule } from './host/write-module.ts'
export { userModulesDir } from './host/module-dirs.ts'
