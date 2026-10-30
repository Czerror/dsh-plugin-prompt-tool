/**
 * agent-assembly — 运行时配装通道。
 *
 * 目标形态：模块不再靠「注册进官方 agent-presets + 由宿主 Loader 挂载插件树」装配，
 * 而是插件在**每个 Agent 自己的 scope** 里建一份装配。
 *
 * 判据（与原模块形态逐项对齐，能力一项不删）：
 *   - 挂的是插件自己的引擎模块（`engine/*.mjs` 的 `apply(ctx, config)`），
 *     不再声明 `agent.cordis.yml` 这类「给宿主 Loader 用的组合本体」；
 *   - 官方工具行（`dsh-tool-*` 等）由宿主提供；模块人设通过 systemPrompt 注册，
 *     本通道**不**装第二棵官方插件树——那些包也不在插件包的解析面内；
 *   - 规则从校验发布的 rules/ 快照编译；工具与子代理策略从模块定义内联装配。
 *
 * 与官方挂载并存时不会重复：官方树里没有引擎行，引擎贡献只由本通道提供。
 */
import { existsSync, unwatchFile, watchFile } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Context, Fiber, Plugin } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SystemPrompt, { PERSONA_PREFIX_SECTION } from '@deepseek-ai/dsh-system-prompt'
import type { AssembleContext, PromptSection, PromptSectionOrderName } from '@deepseek-ai/dsh-system-prompt'
import { scopeChainOf, scopeOf, type ScopeKey } from '@deepseek-ai/dsh-scope'
import { MANIFEST_CHECK_SERVICE } from '../../engine/service-names.mjs'
import { packageEngineDir, resolveModuleDir } from '../host/module-dirs.ts'
import { readModuleFacts, resolveModuleParams } from '../host/module-params.ts'
import { loadModuleSpec, readModulesRevision } from '../host/module-spec.ts'
import type { ModuleSpec } from '../host/module-spec.ts'
import { modelRequestRules } from '../host/prompt-configs.ts'
import { pluginKind, pluginOwner } from '../../engine/source-kind.mjs'
import { assertModuleDirectory, assertModuleId } from '../host/module-install.ts'
import { readConfigOrder } from '../host/module-config-order.ts'
import { rulePromptConfigOptions } from '../host/module-slices.ts'
import { compileCustomTool, validateCustomTools } from '../host/custom-tools.ts'
import { createRuleDiagnosticsLedger, emptyRuleDiagnostics, type RuleDiagnosticsSnapshot } from './rule-diagnostics.ts'
import { createTargetQueue } from '../shared/target-queue.ts'
import { createModuleVariableAdapter } from './module-variable-adapter.ts'
import type {} from '../host/module-manifest-check.ts'
import { createModuleInitialization } from './module-initialization.ts'
import { createPublicationQueue } from './publication-queue.ts'
import type { PublicationFailure } from '../shared/publication.ts'
import { planPersonaSections, type PersonaCapture, type PersonaModule, type PersonaPlan } from './persona-registration.ts'
import { MODULE_TOOL_CAPABILITIES, OFFICIAL_RECIPE_ROWS, enabledRowIds } from '../shared/engine-capabilities.ts'
import { enableTablePath, readGlobalLayerSettings } from '../host/config-store.ts'
import { createGenerationRecoveryState } from '../host/generation-recovery-state.ts'
import { contextRuntimeOf } from '../../engine/context-provenance.mjs'

import { actionAudiences, compileRules, completeRuleSections } from '../../engine/rule-spec.mjs'
import type { RuleAudience } from '../../engine/rule-spec.mjs'
// 与引擎注册侧共用主子身份判据。
import { isDelegated } from '../../engine/shared.mjs'
import { createRuleRuntime } from '../../engine/rule-runtime.mjs'
import { soulReminderOf } from './soul-runtime.ts'
// 去重身份判据的唯一来源。
import { identityOf } from '../../engine/delivery.mjs'
// 条件在真实挂载 scope 绑定；准备期只保留经过预检的定义快照。
import { loadStandingMountFor } from '../../engine/conditions/index.mjs'
// 私有工具适配器的服务名真值源（与引擎侧同一份）。
import { toolServiceName } from '../../engine/service-names.mjs'
// discovery 声明的 adapter 行依赖（kind → 引擎行 id）在准备期校验。
import { assertDiscoveryRows } from '../../engine/discovery.mjs'

/** 引擎模块的受管配置字段：值按历史语义相对模块根书写（如 `../<id>/custom-tools`）。 */
const MANAGED_FIELDS = ['configsDir', 'strategyDir', 'policyFile', 'rulesFile'] as const

/** 私有工具适配器依赖的服务；适配器仍复用包内引擎入口。 */
const PRIVATE_SERVICES: Record<string, string> = Object.fromEntries(Object.values(MODULE_TOOL_CAPABILITIES).map(id => [id, toolServiceName(id)]))

export interface AgentAssemblyRuntime {
  /** 等待当前排队的装配任务收敛（测试与诊断用；生产路径不依赖它）。 */
  settled(): Promise<void>
  /** 某个 Agent 当前是否装上了配装（装配失败的 Agent 不在其中）。 */
  hasMounted(sessionId: string): boolean
  /**
   * 这个 Agent 当前装着哪几层**规则模块**，按**启用表顺序**给出（装配失败的为空数组）。
   *
   * 它只覆盖启用表：人设来源由 `personaSources` 独立引用、可以指向未启用的模块，
   * 所以「有人设」不等于「在这里」。阶段 4 之后它只作工具拒绝文案里的候选提示——写入目标来自
   * 每次调用显式声明的 `moduleId`（ADR-0014）；人设正文的写入走 persona 端点，显式携带模块 id。
   * 取它而不是问宿主「这个会话绑定了哪个官方预设」，因为模块早已与官方预设解耦。
   */
  moduleIds(sessionId: string): readonly string[]
  /** 当前装配实例的规则判定账本快照；释放后的读取由调用方（端点）按实例生命周期处理。 */
  ruleDiagnostics(): RuleDiagnosticsSnapshot
  /** 保存完成后重装存活 Agent；省略 id 表示启用表或部署开关改变。 */
  refresh(moduleId?: string): Promise<void>
  /** 写盘后合并发布；显式 refresh 与请求前读取会消费同一队列。 */
  schedule(moduleId?: string): void
  publicationFailures(): PublicationFailure[]
  dispose(): Promise<void>
}

export interface AgentAssemblyOptions {
  moduleRoot: string
  /**
   * 参与装配的模块 id 列表（= 存储根 `config.yml` 启用表）。
   * 已启用定义暂时不可读时由本通道保留旧贡献，不把读取失败当作停用。
   *
   * **启用即配装**：列了 A+B 就装 A+B，追加 C 就是 A+B+C。每个模块各自贡献自己的
   * 提示词配置、引擎参数与能力声明，彼此不合并、不互相改写。配置执行按各卡的持久序号，
   * `agent-request` 后序覆盖前序；启用表顺序仅保留模块身份与拒绝文案里的候选提示顺序，不再决定工具写入目标。
   * 返回空数组表示没有模块参与装配（此时不注册任何贡献）。
   */
  enabledModules: () => readonly string[]
  /** 已按主/子选择过滤的人设来源；来源选择不隐式启用其普通规则。 */
  personaModules?: () => readonly PersonaModule[]
  /** AgentSetup 窗口内接住的同层人设声明；缺失只影响同层接管，遮蔽祖先声明不依赖它。 */
  personaCapture?: PersonaCapture
  warn?: (message: string) => void
}

/**
 * 受管字段的路径换算：`configsDir` / `strategyDir` / `policyFile` / `rulesFile`
 * 一律解析到**当前模块目录内的真实位置**——声明怎么写都按模块目录作基准，三种形态同结果：
 *   - `./configs`（新形态）→ `<模块目录>/configs`；
 *   - `../<id>/triggers.yml`（历史形态：`ENGINE_MANAGED_PATHS` 的改写成这样，语义是
 *     「从历史引擎位置 `<模块根>/.engine/` 回到 `<模块根>/<id>/`」）→ `<模块目录>/triggers.yml`；
 *   - `../subagent-tools/policy.yml`（已退役策略的历史形态）→ 同样按模块目录作基准，
 *     用于兼容既有预设里仍写着该路径的值；引擎继续负责资源越界校验。
 * 已是 `file:` URL 的值原样保留。
 */
function absolutizeManagedFields(
  config: Record<string, unknown>, moduleDir: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...config }
  for (const field of MANAGED_FIELDS) {
    const value = out[field]
    if (typeof value !== 'string' || value.length === 0) continue
    if (value.startsWith('file:')) continue
    // 组合源的 ../configs 等相对模块内的历史引擎位置；../<id>/ 则相对共享引擎。
    const base = value.startsWith('../') && !value.startsWith(`../${basename(moduleDir)}/`)
      ? join(moduleDir, '.engine') : moduleDir
    out[field] = pathToFileURL(resolve(base, value)).href
  }
  return out
}

/** 该模块 id 是不是插件自带的引擎能力（官方工具行与未知 id 一律跳过）。 */
function engineModuleFile(engineDir: string, id: string): string | undefined {
  const file = join(engineDir, `${id}.mjs`)
  return existsSync(file) ? file : undefined
}

export interface PreparedAssembly {
  rules: unknown[]
  modules: Array<{ id: string; apply: (ctx: Context, config: Record<string, unknown>, options?: { agent: Agent; sourceModuleId: string; sourceModuleDir: string; recoveryState: ReturnType<typeof createGenerationRecoveryState>; contextRuntimeOf: typeof contextRuntimeOf }) => unknown; config: Record<string, unknown> }>
  services: Set<string>
  moduleId: string
  persona?: ModuleSpec['persona']
  variablesEnabled?: boolean
  /** 模块声明了、但只能由会话原有预设挂载的官方 recipe 行。 */
  skippedOfficialRows: string[]
}

/**
 * 读一份模块的装配输入：切片、引擎模块、所需宿主能力。
 *
 * 纯读缝（只依赖包内引擎与模块目录），供挂载与回归测试共用；`hasService` 是宿主能力探针。
 */
export async function prepareAssembly(
  moduleRoot: string, moduleId: string, hasService: (name: string) => boolean,
): Promise<PreparedAssembly> {
  assertModuleId(moduleId)
  const moduleDir = resolveModuleDir(moduleId, moduleRoot)
  const spec = loadModuleSpec(moduleDir) as ModuleSpec
  if (spec.customTools !== undefined && !Array.isArray(spec.customTools)) throw new TypeError('customTools must be an array')
  const toolErrors = validateCustomTools(spec.customTools ?? [])
  if (toolErrors.length > 0) throw new Error(`invalid customTools: ${toolErrors.join('; ')}`)
  // 事实与桥端走同一条 `readModuleFacts` 链（`editable` 由目录判据自判）；定义仍在本函数自己读，
  // 因为下面还要用它做工具校验与受管字段换算。
  const facts = readModuleFacts(moduleDir)
  if (facts.effectiveModules === null) throw new Error(`模块 ${moduleId} 的模块声明无效，无法配装`)
  const configsByModule = facts.effectiveConfigs ?? {}
  const ruleConfig = absolutizeManagedFields(configsByModule['rule-engine'] ?? {}, moduleDir)
  // 公共参数区的模型路由/采样参数（`layerSettings` 的 agent-request / subagent-start）在装配期
  // 转成请求补丁：参数桥是它们的唯一可写入口，`request-params` 是它们唯一的执行点。
  // 合成规则与模块规则**一起编译**（不能事后推进已编译结果），只活在本次装配里，
  // 不进 module.yml / rules 切片；作者手写了同名 id 时让位给作者的定义。
  const declaredRules = spec.rules ?? []
  const syntheticRules = modelRequestRules(resolveModuleParams(spec, {}))
    .filter(rule => !declaredRules.some(declared => declared.id === rule.id))
  const rules = compileRules([...declaredRules, ...syntheticRules], {
    moduleId,
    configOrder: readConfigOrder(spec.configOrder),
    variables: spec.variables, variablesEnabled: spec.variablesEnabled,
    contextActivationRecursive: spec.contextActivationRecursive,
    promptConfigOptions: rulePromptConfigOptions(moduleDir, ruleConfig.strategyDir),
  })
  // 声明了 discovery 的规则必须把对应 adapter 行列进 modules；缺行在准备期就失败。
  assertDiscoveryRows(rules, facts.effectiveModules, moduleId)
  const engineDir = packageEngineDir()
  const services = new Set<string>()
  const modules: PreparedAssembly['modules'] = []
  const skippedOfficialRows: string[] = []
  const disabledRows = new Set(facts.disabledRows ?? [])
  for (const id of disabledRows) if (OFFICIAL_RECIPE_ROWS.includes(id)) skippedOfficialRows.push(id)
  for (const id of enabledRowIds(facts)) {
    if (id === 'rule-engine') continue
    // 退役引擎名按白名单过滤：不装配、不报错（它们承载的是旧格式规则，改写由用户或模型完成）。
    if (id === 'prompt-config-engine' || id === 'declared-triggers') continue
    const privateService = PRIVATE_SERVICES[id]
    if (privateService !== undefined) {
      if (!hasService(privateService)) throw new Error(`配装所需能力不可用：${privateService}`)
      services.add(privateService)
    }
    const file = engineModuleFile(engineDir, id)
    // 官方组合行与能力 recipe（只有 library yml、没有 engine mjs）由会话原有预设提供。
    // 仍声明它们时只记录诊断，不假装已挂载。
    if (file === undefined) {
      if (OFFICIAL_RECIPE_ROWS.includes(id)) skippedOfficialRows.push(id)
      continue
    }
    const module = await import(pathToFileURL(file).href) as {
      apply?: PreparedAssembly['modules'][number]['apply']
      inject?: readonly string[]
    }
    if (typeof module.apply !== 'function') throw new Error(`引擎能力缺少 apply：${id}`)
    for (const dependency of module.inject ?? []) services.add(dependency)
    const config = absolutizeManagedFields(configsByModule[id] ?? {}, moduleDir)
    if (id === 'tool-config-engine') {
      config.tools = (spec.customTools ?? []).map(tool => compileCustomTool(tool as Record<string, unknown>))
      config.resourceRoot = pathToFileURL(moduleRoot + sep).href
      delete config.presetRoot
    }
    // 引擎自带的声明就绪校验（未知键 fail loud）在装配期先跑一次，避免挂载到一半才炸。
    const contract = (module as { configContract?: { parse?: (value: unknown, name: string) => unknown } }).configContract
    contract?.parse?.(config, id)
    modules.push({ id, apply: module.apply, config })
  }
  if (rules.length > 0) {
    services.add('systemPrompt')
    services.add('tools')
    services.add('llm')
  }
  if (spec.persona !== undefined) services.add('systemPrompt')
  for (const name of services) {
    if (!hasService(name)) throw new Error(`配装所需宿主能力不可用：${name}`)
  }
  return { rules, modules, services, moduleId, persona: spec.persona, variablesEnabled: spec.variablesEnabled, skippedOfficialRows }
}

/** 上报点只读 message（本文件的 `warn`、settings-bridge 的 `String(error)`）：原因写进文本。 */
const failureReason = (error: unknown): string => error instanceof Error ? error.message : String(error)

/**
 * 「同一份 rule/action 身份」的指纹：两个模块带同一份指纹 = 模块被整份复制（rule id 与
 * 动作 id 都保留），而不是两块卡有意共享一个去重身份。编译产物里
 * `ruleId` / `ruleActionIndex` 就是这两个稳定 id（见 `engine/rule-spec.mjs`）。
 */
function ruleKeyOf(config: Record<string, unknown>): string {
  return `${String(config.ruleId)}\u0000${String(config.ruleActionIndex)}`
}

/**
 * 同时启用的模块间重复去重身份（F16(b)）：**只可见化，不拒绝**——复制模块后两者同时启用
 * 是合法操作，整体拒绝会让该 Agent 的全部装配失败，违背「失败不伤会话」。
 *
 * 去重判据带**模块维**（`engine/executor.mjs#identityHit`：模块 + 通道 + 身份），因此同身份
 * 的两个模块**各自注入**、不再互相压制；告警说的是「两份正文都会留在上下文里」这件事。
 * 两条通道都要查：`plugin`（消息来源身份，进 `source.plugin`）与 `sourceKind`（进
 * `source.kind`）——它们各是一份独立的判据，漏查任一条就让「两模块带同一身份」不可见。
 * `suspectedCopy` 标出「同一份 rule/action 身份被两个模块各带一份」，那才是复制模块的指纹；
 * 只有一份（或 rule/action 身份不同）时是两个模块各自声明了同一个身份，措辞不劝改。
 * sourceKind 未显式声明时按配置 id 编译成 `plugin:<id>`：那只是自身 id 的编译产物，同 id 的
 * 两个模块也各按模块维记一份、不再互相压制，所以它不是一笔去重账——照它告警是假警报。
 */
interface DuplicateIdentity { channel: 'plugin' | 'kind'; identity: string; suspectedCopy: boolean; moduleIds: string[] }

function completeSectionsOf(prepared: PreparedAssembly[], audience: RuleAudience): string[] {
  return prepared.flatMap(item => completeRuleSections(item.rules, audience).map((id: string) => `${item.moduleId}/${id}`))
}

/** 这份模块是否声明了某受众会执行的 assembly.sections.append（用于与 complete 的已知受众互斥）。 */
function hasSectionAppend(rules: readonly unknown[], audience: RuleAudience): boolean {
  return rules.some((rule) => {
    const candidate = rule as {
      enabled?: boolean
      actions?: Array<{ id: string; kind?: string; target?: { sections?: { append?: unknown } } }>
    }
    if (candidate.enabled === false) return false
    return (candidate.actions ?? []).some(action => action.kind === 'assembly'
      && Array.isArray(action.target?.sections?.append) && action.target.sections.append.length > 0
      && actionAudiences(candidate, action.id).has(audience))
  })
}

function dedupeConfigsOf(prepared: PreparedAssembly[]): Array<{ moduleId: string; config: Record<string, unknown> }> {
  const found: Array<{ moduleId: string; config: Record<string, unknown> }> = []
  for (const item of prepared) {
    for (const rule of item.rules as Array<{ enabled?: boolean; actions?: Array<{ kind?: string; compiledConfig?: Record<string, unknown> }> }>) {
      if (rule.enabled === false) continue
      for (const action of rule.actions ?? []) {
        if (action.kind !== 'inject-text') continue
        const config = action.compiledConfig
        if (config === undefined || (config.dedupe !== 'session' && config.dedupe !== 'batch')) continue
        found.push({ moduleId: item.moduleId, config })
      }
    }
  }
  return found
}

function duplicateDedupeIdentities(prepared: PreparedAssembly[]): DuplicateIdentity[] {
  // 每个配置贡献两条通道：plugin 身份（引擎 identityOf：`identity.value`，schema 保证非空）与显式 sourceKind。
  const declarations = dedupeConfigsOf(prepared).flatMap(({ moduleId, config }) => {
    const pluginIdentity = identityOf(config)
    // 缺省 sourceKind 由**配置 id** 编成 `plugin:<id>`（schema.mjs 的归一，已落在 compiledConfig 里），
    // 只有显式声明的才与它不同。identityStampOf 的回退按去重身份编，真实链路不达（schema 总会填
    // kind），拿它当基线会把按 id 编出的缺省误判成显式声明（显式 identity / merged 组时）。
    // 「缺省不算一笔账」是本侧语义：只可见化显式声明，故与缺省比对后再决定要不要报 kind 通道。
    const declaredKind = pluginOwner(config.sourceKind) !== String(config.id) ? config.sourceKind : undefined
    return [
      { key: pluginKind(pluginIdentity), channel: 'plugin' as const, identity: pluginIdentity, copyKey: ruleKeyOf(config), moduleId },
      ...(typeof declaredKind === 'string' && declaredKind.length > 0 ? [{ key: `kind:${declaredKind}`, channel: 'kind' as const, identity: declaredKind, copyKey: ruleKeyOf(config), moduleId }] : []),
    ]
  })
  const byKey = new Map<string, { channel: 'plugin' | 'kind'; identity: string; copyKeys: Set<string>; moduleIds: Set<string> }>()
  for (const { key, channel, identity, copyKey, moduleId } of declarations) {
    const entry = byKey.get(key) ?? { channel, identity, copyKeys: new Set<string>(), moduleIds: new Set<string>() }
    entry.copyKeys.add(copyKey)
    entry.moduleIds.add(moduleId)
    byKey.set(key, entry)
  }
  return [...byKey.values()].filter((entry) => entry.moduleIds.size > 1)
    .map((entry) => ({ channel: entry.channel, identity: entry.identity, suspectedCopy: entry.copyKeys.size === 1, moduleIds: [...entry.moduleIds].sort() }))
}

export function createAgentAssembly(ctx: Context, options: AgentAssemblyOptions): AgentAssemblyRuntime {
  const variableStore = createModuleVariableAdapter(options.moduleRoot)
  const manifestCheck = ctx.get(MANIFEST_CHECK_SERVICE)
  const recoveryState = createGenerationRecoveryState(join(dirname(options.moduleRoot), 'generation-recovery'))
  const ruleDiagnostics = createRuleDiagnosticsLedger()
  const initialization = createModuleInitialization(ctx)
  const lastGood = new WeakMap<Agent, Map<string, PreparedAssembly>>()
  const sourceVersions = new WeakMap<PreparedAssembly, string>()
  const rejectedVersions = new WeakMap<Agent, Map<string, Map<string, string>>>()
  type Slot = { fiber: Fiber; owners: PreparedAssembly[]; ready: boolean; failed?: unknown; live: boolean; off(): void; signature?: string }
  type Mounted = {
    agent: Agent; scope: Context; fiber: { dispose(): Promise<void> | void }; rules: ReturnType<typeof createRuleRuntime>
    modules: Map<string, Slot>; shared: Map<string, Slot>; persona?: { fiber: Fiber; signature: string }
    prepared: PreparedAssembly[]; moduleIds: readonly string[]; stamp: string; content: string; plan: PersonaPlan; personaSignature: string
    live: boolean; committed: boolean; mutating: boolean
  }
  const mounts = new Map<string, Mounted>()
  const knownAgents = new Set<Agent>()
  const watched = new Map<string, () => void>()
  const disposed = new WeakSet<Agent>()
  let pending: Promise<void> = Promise.resolve()
  let publishingContent: string | undefined
  const serialQueue = createTargetQueue()
  let active = true
  const warn = (error: unknown): void => {
    const message = `prompt-tool: 运行时配装失败：${failureReason(error)}`
    if (options.warn !== undefined) options.warn(message)
    else ctx.logger?.warn?.(message)
  }
  // 官方 persona 行以公开 config 提供人设声明；解析不到就当没有继承源，不阻断装配。
  let personaPlugin: Plugin | undefined
  let personaKnowledge: Promise<void> | undefined
  const readPersonaKnowledge = (): Promise<void> => {
    personaKnowledge = personaKnowledge ?? Promise.resolve().then(async () => {
      const loader = ctx.get('loader') as { import(name: string): unknown | Promise<unknown>, unwrapExports(value: unknown): Plugin } | undefined
      if (loader === undefined) return
      const plugin = loader.unwrapExports(await loader.import('@deepseek-ai/dsh-persona'))
      if (!ctx.registry.resolve(plugin)) throw new Error('官方 Persona 导出无有效入口')
      personaPlugin = plugin
    }).catch((error: unknown) => { warn(error) })
    return personaKnowledge
  }
  const liveFiber = (fiber: Fiber): boolean => fiber.uid !== null && fiber.store !== undefined && fiber.inertia === undefined
  const officialAt = (scope: ScopeKey): Fiber | undefined => {
    const fibers = [...(personaPlugin ? ctx.registry.get(personaPlugin)?.fibers ?? [] : [])].filter(fiber => liveFiber(fiber) && scopeOf(fiber.ctx) === scope)
    if (fibers.length > 1) throw new Error('同作用域存在多个官方人设实例，拒绝猜测所有者')
    return fibers[0]
  }
  const sectionFromConfig = (fiber: Fiber, name: string, root = false): PromptSection => {
    const prefix = name === PERSONA_PREFIX_SECTION
    const field = root ? prefix ? 'personaPrefix' : 'personaSuffix' : prefix ? 'prefix' : 'suffix'
    const prompt = fiber.ctx.get('systemPrompt')
    if (prompt === undefined) throw new Error('官方人设需要 systemPrompt 服务')
    return { name, text: String(fiber.config[field] ?? ''), order: prompt.getSectionOrder(prefix ? 'DEPLOYMENT_PERSONA_PREFIX' : 'DEPLOYMENT_PERSONA_SUFFIX'),
      ...(!root && prefix && fiber.config.complete === true ? { complete: true } : {}) }
  }
  /**
   * 同名段的继承源：同层被接住的声明优先，其次沿 scope 链找最近的官方 persona 行，最后是根部署人设。
   * 找不到就是没有继承源——遮蔽一个不存在的声明本身无害，不再因为「未观察」拒绝配装。
   */
  const inheritedSection = (scope: ScopeKey, name: string): PromptSection | undefined => {
    const captured = options.personaCapture?.records(scope).find(record => record.name === name)
    if (captured !== undefined) return captured.section
    for (const parent of [...scopeChainOf(scope).slice(1), undefined]) {
      const fiber = parent === undefined
        ? [...(ctx.registry.get(SystemPrompt)?.fibers ?? [])].find(item => liveFiber(item) && scopeOf(item.ctx) === undefined)
        : officialAt(parent)
      if (fiber !== undefined) return sectionFromConfig(fiber, name, parent === undefined)
    }
    return undefined
  }
  const personaPlanFor = (agent: Agent, modules: readonly PersonaModule[]): PersonaPlan => planPersonaSections({
    audience: isDelegated(agent.session) ? 'subagent' : 'main',
    modules,
    // 两个取值都惰性：没有人设来源的 Agent 不因为缺服务而失败。
    inherited: name => {
      const scope = scopeOf(agent.ctx)
      return scope === undefined ? undefined : inheritedSection(scope, name)
    },
    order: (name: PromptSectionOrderName) => {
      const prompt = agent.ctx.get('systemPrompt')
      if (prompt === undefined) throw new Error('人设配装需要 systemPrompt 服务')
      return prompt.getSectionOrder(name)
    },
    variableStore,
    ...options.warn === undefined ? {} : { warn: options.warn },
  })
  // 跨模块重复身份按「身份 → 模块集」只报一次：反复重装（每次保存、每个新 Agent）不刷屏；
  // 装上第二处（新模块）时再加报一次。集合建在 mount 工厂级，故跨 refresh()（切预设、重装）
  // 存活——同一重复不再告警是刻意的，要重新看到需重载插件。
  const reportedDuplicates = new Set<string>()
  const warnOnce = (message: string): void => {
    if (reportedDuplicates.has(message)) return
    reportedDuplicates.add(message)
    if (options.warn !== undefined) options.warn(message)
    else ctx.logger?.warn?.(message)
  }
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const next = serialQueue.run('assembly', task)
    pending = next.then(() => {}, () => {})
    return next
  }
  const release = async (sessionId: string, agent?: Agent): Promise<void> => {
    const current = mounts.get(sessionId)
    if (current === undefined) return
    if (agent !== undefined && current.agent !== agent) return
    mounts.delete(sessionId)
    await current.fiber.dispose()
  }

  const reject = (agent: Agent, item: PreparedAssembly, error: unknown): void => {
    let rejected = rejectedVersions.get(agent)
    if (rejected === undefined) { rejected = new Map(); rejectedVersions.set(agent, rejected) }
    let versions = rejected.get(item.moduleId)
    if (versions === undefined) { versions = new Map(); rejected.set(item.moduleId, versions) }
    versions.set(sourceVersions.get(item) ?? '', failureReason(error))
    if (lastGood.get(agent)?.get(item.moduleId) === item) lastGood.get(agent)?.delete(item.moduleId)
  }

  const mount = async (agent: Agent, prepared: PreparedAssembly[], plan: PersonaPlan, duplicateIdentities: DuplicateIdentity[] = [], stamp = '', content = '', personaSignature = ''): Promise<void> => {
    for (const item of prepared) for (const name of item.services) {
      if (agent.ctx.get(name) === undefined) throw Object.assign(new Error(`模块 ${item.moduleId} 挂载所需宿主能力不可用：${name}`), { sourceModuleId: item.moduleId })
    }
    let current = mounts.get(agent.id)
    if (current === undefined) {
      let scope: Context | undefined
      const root = agent.ctx.plugin({ name: 'prompt-tool-assembly', apply: (scopeCtx: Context) => { scope = scopeCtx } })
      try { await root } catch (error) { await root.dispose(); throw error }
      if (scope === undefined) { await root.dispose(); throw new Error('运行时配装作用域未初始化') }
      let rules: ReturnType<typeof createRuleRuntime>
      try { rules = createRuleRuntime(scope, { agent, onOutcome: ruleDiagnostics.record, variableStore, standingMountFor: await loadStandingMountFor(), manifestCheck, soulReminder: soulReminderOf(ctx) }) }
      catch (error) { await root.dispose(); throw error }
      const record: Mounted = { agent, scope, rules, modules: new Map(), shared: new Map(), prepared: [], moduleIds: [],
        stamp: '', content: '', personaSignature: '', plan: { sections: [], suppressRuntimeContext: false }, live: true, committed: false, mutating: false,
        fiber: { dispose: () => {} } }
      const disposeFiber = ctx.effect(() => () => {
        record.live = false
        for (const slot of [...record.modules.values(), ...record.shared.values()]) { slot.live = false; slot.off() }
        rules.dispose()
        return root.dispose()
      }, `prompt-tool assembly ${agent.id}`)
      record.fiber = { dispose: async () => { await disposeFiber() } }
      mounts.set(agent.id, record)
      current = record
    }
    const record = current
    const promote = (): void => {
      if (!record.live || !record.committed || record.mutating || !active || disposed.has(agent)) return
      let good = lastGood.get(agent)
      if (good === undefined) { good = new Map(); lastGood.set(agent, good) }
      for (const item of record.prepared) {
        const slots = [...record.modules.values(), ...record.shared.values()].filter(slot => slot.owners.includes(item))
        if (slots.every(slot => slot.ready && slot.failed === undefined)) good.set(item.moduleId, item)
      }
    }
    const disposeSlot = async (slot: Slot): Promise<void> => { slot.live = false; slot.off(); await slot.fiber.dispose() }
    const applyCapability = async (scopeCtx: Context, item: PreparedAssembly, module: PreparedAssembly['modules'][number]): Promise<void> => {
      const result = await module.apply(scopeCtx, module.config, { agent, sourceModuleId: item.moduleId,
        sourceModuleDir: resolveModuleDir(item.moduleId, options.moduleRoot), recoveryState, contextRuntimeOf })
      if (typeof result === 'function') scopeCtx.effect(() => result as () => void, module.id)
    }
    const createSlot = async (map: Map<string, Slot>, key: string, owners: PreparedAssembly[], apply: (scopeCtx: Context) => Promise<void>, signature?: string): Promise<void> => {
      const fiber = record.scope.plugin({ name: `prompt-tool-${map === record.modules ? 'module' : 'shared'}:${key}`,
        inject: [...new Set(owners.flatMap(item => [...item.services]))], apply })
      const slot: Slot = { fiber, owners, ready: false, live: true, off: () => {}, ...(signature === undefined ? {} : { signature }) }
      map.set(key, slot)
      slot.off = initialization.observe(fiber, {
        ready: () => { if (slot.live) { slot.ready = true; promote() } },
        failed: error => {
          if (!slot.live || !record.live || !active || disposed.has(agent) || map.get(key) !== slot) return
          slot.failed = error
          if (record.mutating || !record.committed) return
          for (const item of slot.owners) { reject(agent, item, error); publication.schedule(item.moduleId) }
          warn(new Error(`模块 ${slot.owners.map(item => item.moduleId).join('、')} 初始化失败：${failureReason(error)}`, { cause: error }))
        },
      })
      try {
        await fiber
        await initialization.settled([fiber])
        if (slot.failed !== undefined) throw slot.failed
      } catch (error) {
        await disposeSlot(slot)
        map.delete(key)
        throw Object.assign(new Error(`模块 ${owners.map(item => item.moduleId).join('、')} 挂载失败：${failureReason(error)}`, { cause: error }), { sourceModuleIds: owners.map(item => item.moduleId) })
      }
    }
    record.mutating = true
    try {
      record.rules.replace(prepared.filter(item => item.rules.length > 0).map(item => ({ moduleId: item.moduleId, rules: item.rules })))
      const desired = new Set(prepared.map(item => item.moduleId))
      for (const [id, slot] of record.modules) if (!desired.has(id) || !prepared.includes(slot.owners[0]!) || !slot.live || slot.failed !== undefined) {
        await disposeSlot(slot); record.modules.delete(id)
      }
      for (const item of prepared) {
        const capabilities = item.modules.filter(module => PRIVATE_SERVICES[module.id] === undefined || module.id === 'retrieval')
        if (capabilities.length > 0 && !record.modules.has(item.moduleId)) await createSlot(record.modules, item.moduleId, [item], async scopeCtx => {
          for (const module of capabilities) await applyCapability(scopeCtx, item, module)
        })
      }
      const shared = new Map<string, { owners: PreparedAssembly[]; item: PreparedAssembly; module: PreparedAssembly['modules'][number]; signature: string }>()
      for (const item of prepared) for (const module of item.modules) {
        if (PRIVATE_SERVICES[module.id] === undefined || module.id === 'retrieval' || shared.has(module.id)) continue
        const owners = prepared.filter(source => source.modules.some(candidate => candidate.id === module.id))
        shared.set(module.id, { owners, item, module, signature: JSON.stringify([owners.map(owner => owner.moduleId), item.moduleId, module.config]) })
      }
      for (const [id, slot] of record.shared) if (shared.get(id)?.signature !== slot.signature || !slot.live || slot.failed !== undefined) { await disposeSlot(slot); record.shared.delete(id) }
      for (const [id, entry] of shared) {
        const old = record.shared.get(id)
        if (old !== undefined) old.owners = entry.owners
        else await createSlot(record.shared, id, entry.owners, scopeCtx => applyCapability(scopeCtx, entry.item, entry.module), entry.signature)
      }
      const personaKey = JSON.stringify([personaSignature, plan.suppressRuntimeContext, plan.sections.map(section => ({ ...section, text: String(section.text) }))])
      if (record.persona?.signature !== personaKey) {
        if (record.persona !== undefined) { await record.persona.fiber.dispose(); delete record.persona }
        if (plan.sections.length > 0 || plan.suppressRuntimeContext) {
          const fiber = record.scope.plugin({ name: 'prompt-tool-persona', inject: ['systemPrompt'], apply: (scopeCtx: Context) => {
            const applied: Array<() => void> = [], scope = scopeOf(scopeCtx)
            const rollback = (): void => { while (applied.length > 0) applied.pop()?.() }
            try {
              for (const section of plan.sections) {
                if (scope !== undefined) options.personaCapture?.records(scope).find(record => record.name === section.name)?.off()
                applied.push(scopeCtx.systemPrompt.section(section))
              }
              if (plan.suppressRuntimeContext) applied.push(scopeCtx.systemPrompt.suppressRuntimeContext())
            } catch (error) { rollback(); throw error }
            scopeCtx.effect(() => rollback, 'prompt-tool persona')
          } })
          try { await fiber } catch (error) { await fiber.dispose(); throw error }
          record.persona = { fiber, signature: personaKey }
        }
      }
      if (!active || disposed.has(agent)) { await release(agent.id, agent); return }
      record.prepared = prepared
      record.moduleIds = prepared.map(item => item.moduleId)
      record.stamp = stamp; record.content = content; record.plan = plan; record.personaSignature = personaSignature; record.committed = true
      for (const item of duplicateIdentities) {
        const where = item.channel === 'kind' ? `显式 sourceKind ${JSON.stringify(item.identity)}` : `去重身份 ${JSON.stringify(item.identity)}`
        warnOnce(item.suspectedCopy
          ? `模块 ${item.moduleIds.join('、')} 疑似由复制产生同一个${where}（dedupe: session/batch）：去重按模块各记一份，两份正文都会注入，请改 rule id 或显式 identity 以区分`
          : `模块 ${item.moduleIds.join('、')} 声明了同一个${where}（dedupe: session/batch）：去重按模块各记一份，两模块各自注入；同一模块内才共享这份去重`)
      }
    } finally { record.mutating = false }
    promote()
  }

  // 每请求只 stat 源文件；戳变时再算内容签名（剔除变量值），变量自增不触发重挂。
  const assemblyStamp = (ids: readonly string[], personas: readonly PersonaModule[] | undefined): string =>
    JSON.stringify(personas) + readModulesRevision(options.moduleRoot, ids)
  const contentSignature = (ids: readonly string[], personas: readonly PersonaModule[] | undefined, previous = ''): string => JSON.stringify([
    ids.map(id => {
      try {
        const { variables: _variables, ...definition } = loadModuleSpec(assertModuleDirectory(options.moduleRoot, id))
        // 变量值在求值时读取；自增不能让下一步重新注册规则。
        return [id, definition]
      } catch (error) {
        warnOnce(`模块 ${id} 读取失败：${failureReason(error)}`)
        const old = previous === '' ? undefined : (JSON.parse(previous)[0] as Array<[string, unknown]>).find(entry => entry[0] === id)
        return old ?? [id, { readError: failureReason(error) }]
      }
    }),
    personas,
  ])
  const watchSources = (ids: readonly string[], personas: readonly PersonaModule[] | undefined): void => {
    const files = new Set([enableTablePath(options.moduleRoot), ...[...ids, ...(personas ?? []).map(item => item.moduleId)]
      .map(id => { assertModuleId(id); return join(options.moduleRoot, id, 'module.yml') })])
    for (const [file, listener] of watched) if (!files.has(file)) { unwatchFile(file, listener); watched.delete(file) }
    for (const file of files) if (!watched.has(file)) {
      const listener = (): void => {
        if (!active) return
        try {
          const ids = options.enabledModules(), personas = options.personaModules?.(), stamp = assemblyStamp(ids, personas)
          if (publishingContent !== undefined && contentSignature(ids, personas) === publishingContent) return
          const agents = new Set([...knownAgents, ...(ctx.get('agents')?.list() ?? [])])
          let changed = false
          for (const agent of agents) {
            if (disposed.has(agent)) continue
            const current = mounts.get(agent.id)
            if (current?.stamp === stamp) continue
            if (current !== undefined && current.content === contentSignature(ids, personas, current.content)) current.stamp = stamp
            else changed = true
          }
          if (changed) publication.schedule()
        } catch { publication.schedule() }
      }
      watched.set(file, listener)
      watchFile(file, { persistent: false, interval: 200 }, listener)
    }
  }
  const replace = async (targets: readonly Agent[], retry: readonly string[] | boolean = false, attempt = 0): Promise<void> => {
    // 部署配置属于整份装配，读取失败不能伪装成每个模块各自失败。
    readGlobalLayerSettings(options.moduleRoot)
    const ids = [...options.enabledModules()]
    const personaModules = options.personaModules?.()
    watchSources(ids, personaModules)
    const live = targets.filter(agent => active && !disposed.has(agent))
    const failures: Error[] = []
    const candidates = []
    const signatureSnapshot = contentSignature(ids, personaModules)
    const versions = new Map(ids.map(id => [id, contentSignature([id], undefined)]))
    for (const agent of live) {
      const previous = mounts.get(agent.id)
      if (retry === true) rejectedVersions.delete(agent)
      else if (Array.isArray(retry)) for (const id of retry) rejectedVersions.get(agent)?.delete(id)
      const good = lastGood.get(agent)
      const goodSnapshot = good === undefined ? undefined : new Map(good)
      const prepared: PreparedAssembly[] = []
      for (const id of ids) {
        try {
          const version = versions.get(id)!
          const old = previous?.prepared.find(item => item.moduleId === id)
          const item = old !== undefined && sourceVersions.get(old) === version
            ? old : await prepareAssembly(options.moduleRoot, id, name => agent.ctx.get(name) !== undefined)
          sourceVersions.set(item, version)
          if (rejectedVersions.get(agent)?.get(id)?.has(version)) {
            failures.push(new Error(`模块 ${id}（Agent ${agent.id}）上次发布失败：${rejectedVersions.get(agent)!.get(id)!.get(version)}`))
            const fallback = good?.get(id)
            if (fallback !== undefined) prepared.push(fallback)
          } else {
            rejectedVersions.get(agent)?.delete(id)
            prepared.push(item)
          }
        }
        catch (error) {
          failures.push(new Error(`模块 ${id}（Agent ${agent.id}）准备失败：${failureReason(error)}`, { cause: error }))
          const fallback = good?.get(id)
          if (fallback !== undefined) prepared.push(fallback)
        }
        await new Promise<void>(resolve => setImmediate(resolve))
      }
      candidates.push({ agent, prepared, previous: previous === undefined ? undefined : { ...previous }, goodSnapshot })
    }
    // 准备期会让出事件循环；变更中的候选不得盖上较新定义的版本戳。
    if (JSON.stringify(options.enabledModules()) !== JSON.stringify(ids)
      || contentSignature(ids, options.personaModules?.()) !== signatureSnapshot) {
      if (attempt < 3) return replace(targets, retry, attempt + 1)
      publication.schedule()
      throw new Error('模块定义在准备期间持续变化，已安排重新发布')
    }
    // 重切规则切片会写文件，戳只在已复核的准备结束后捕获。
    const stamp = assemblyStamp(ids, personaModules)
    for (const item of candidates.flatMap(candidate => candidate.prepared)) {
      for (const id of item.skippedOfficialRows) {
        warnOnce(`模块 ${item.moduleId} 声明官方 recipe 行 ${id}；该行只能由会话原有预设提供，本插件不挂载官方包`)
      }
    }
    if (!active) return
    if (options.personaModules !== undefined) await readPersonaKnowledge()
    const planFor = (agent: Agent, prepared: PreparedAssembly[]): PersonaPlan => {
      const sections = { main: completeSectionsOf(prepared, 'main'), subagent: completeSectionsOf(prepared, 'subagent') }
      for (const [audience, complete] of Object.entries(sections)) {
        if (complete.length > 1) throw new Error(`${audience} 有多个生效 complete 段：${complete.join('、')}`)
      }
      const appendModules = {
        main: prepared.filter(item => hasSectionAppend(item.rules, 'main')).map(item => item.moduleId),
        subagent: prepared.filter(item => hasSectionAppend(item.rules, 'subagent')).map(item => item.moduleId),
      }
      const plan = personaPlanFor(agent, personaModules ?? prepared)
      const audience = isDelegated(agent.session) ? 'subagent' : 'main'
      const plannedPrefix = plan.sections.find(section => section.name === PERSONA_PREFIX_SECTION)
      // 已捕获的同层 preset persona complete 只在没有被本插件人设覆盖时生效。
      const scope = scopeOf(agent.ctx)
      const capturedComplete = plannedPrefix === undefined && options.personaCapture !== undefined && scope !== undefined
        ? options.personaCapture.records(scope).some(record => record.name === PERSONA_PREFIX_SECTION && record.section.complete === true)
        : false
      const personaComplete = plannedPrefix === undefined ? capturedComplete : plannedPrefix.complete === true
      if (personaComplete && sections[audience].length > 0) {
        throw new Error(`Agent ${agent.id} 的 ${audience} 有多个生效 complete 段：人设与 ${sections[audience].join('、')}`)
      }
      if (appendModules[audience].length > 0 && (personaComplete || sections[audience].length > 0)) {
        throw new Error(`Agent ${agent.id} 的 ${audience} 同时声明了 sections.append（${appendModules[audience].join('、')}）与 complete；请在同一受众二选一`)
      }
      return plan
    }
    // 跨来源冲突仍在撤旧之前拒绝，不替用户选择赢家。
    const plans = candidates.map(({ agent, prepared }) => planFor(agent, prepared))
    const changed: typeof candidates = []
    try {
      for (const [index, candidate] of candidates.entries()) {
        if (!active || disposed.has(candidate.agent)) continue
        changed.push(candidate)
        const content = signatureSnapshot
        const personaSignature = JSON.stringify(personaModules ?? candidate.prepared.map(({ moduleId, persona, variablesEnabled }) => ({ moduleId, persona, variablesEnabled })))
        let plan = plans[index] as PersonaPlan
        while (true) {
          try {
            await mount(candidate.agent, candidate.prepared, plan, duplicateDedupeIdentities(candidate.prepared), stamp, content, personaSignature)
            break
          } catch (error) {
            const sourceIds = error !== null && typeof error === 'object'
              ? 'sourceModuleIds' in error && Array.isArray(error.sourceModuleIds) ? error.sourceModuleIds
                : 'sourceModuleId' in error ? [error.sourceModuleId] : [] : []
            const failed = candidate.prepared.filter(item => sourceIds.includes(item.moduleId))
            if (failed.length === 0) throw error
            for (const item of failed) {
              failures.push(new Error(`模块 ${item.moduleId}（Agent ${candidate.agent.id}）发布失败：${failureReason(error)}`, { cause: error }))
              reject(candidate.agent, item, error)
            }
            candidate.prepared = candidate.prepared.flatMap(item => {
              if (!failed.includes(item)) return [item]
              const fallback = lastGood.get(candidate.agent)?.get(item.moduleId)
              return fallback !== undefined && fallback !== item ? [fallback] : []
            })
            plan = planFor(candidate.agent, candidate.prepared)
          }
        }
        await new Promise<void>(resolve => setImmediate(resolve))
      }
    } catch (error) {
      const restoreErrors: unknown[] = []
      for (const { agent, previous, goodSnapshot } of changed.reverse()) {
        if (!active || disposed.has(agent)) continue
        try {
          // 候选初始化成功不等于整批提交成功，回滚不能留下已撤候选的成功快照。
          if (goodSnapshot === undefined) lastGood.delete(agent)
          else lastGood.set(agent, new Map(goodSnapshot))
          if (previous?.agent === agent) await mount(agent, previous.prepared, previous.plan, [], previous.stamp, previous.content, previous.personaSignature)
          else await release(agent.id, agent)
        } catch (restoreError) {
          restoreErrors.push(restoreError)
          try { await release(agent.id, agent) } catch (cleanupError) { restoreErrors.push(cleanupError) }
        }
      }
      if (restoreErrors.length > 0) {
        throw new AggregateError([error, ...restoreErrors],
          `切换装配失败（${failureReason(error)}），且恢复原有装配也失败（${restoreErrors.map(failureReason).join('；')}）`)
      }
      throw error
    }
    for (const { agent } of candidates) {
      const good = lastGood.get(agent)
      for (const id of good?.keys() ?? []) if (!ids.includes(id)) good?.delete(id)
    }
    if (failures.length > 0) throw new AggregateError(failures, failures.map(failureReason).join('；'))
  }
  const install = async (agent: Agent): Promise<void> => {
    knownAgents.add(agent)
    if (!active || disposed.has(agent) || mounts.get(agent.id)?.agent === agent) return
    publishingContent = contentSignature(options.enabledModules(), options.personaModules?.())
    try { await replace([agent]) } finally { publishingContent = undefined }
  }
  const publication = createPublicationQueue({
    warn: message => warn(message),
    publish: (moduleIds, retry) => serial(async () => {
      if (!active) return
      const enabled = options.enabledModules()
      const personas = options.personaModules?.()
      const known = new Set<Agent>([...(ctx.get('agents')?.list() ?? []), ...knownAgents, ...[...mounts.values()].map(mount => mount.agent)])
      const live = [...known].filter(agent => !disposed.has(agent))
      const targets = live.filter(agent => moduleIds === undefined || moduleIds.some(id =>
        enabled.includes(id) || mounts.get(agent.id)?.moduleIds.includes(id)
        || (personas ?? []).some(item => item.moduleId === id && item.persona?.[isDelegated(agent.session) ? 'subagent' : 'main'] !== undefined)))
      publishingContent = contentSignature(enabled, personas)
      try { await replace(targets, retry) } finally { publishingContent = undefined }
      return targets.length === live.length
    }),
  })
  let lastReadError: string | undefined
  const ensureFresh = async (agent: Agent): Promise<void> => {
    if (!active || disposed.has(agent) || !knownAgents.has(agent)) return
    try {
      await publication.flush(undefined, false)
      await pending
      // 热读失败保留旧贡献；初次装配仍按 manifest 的全局参数软失败约定处理。
      readGlobalLayerSettings(options.moduleRoot)
      const ids = options.enabledModules(), personas = options.personaModules?.()
      watchSources(ids, personas)
      const stamp = assemblyStamp(ids, personas)
      const current = mounts.get(agent.id)
      if (current?.stamp !== stamp) {
        // 只改变量时戳变、内容签名不变：更新戳即可，不撤装重挂。
        if (current?.content === contentSignature(ids, personas, current?.content)) current.stamp = stamp
        else { publication.schedule(); await publication.flush(undefined, false) }
      }
      lastReadError = undefined
    } catch (error) {
      const message = failureReason(error)
      if (message !== lastReadError) warn(error)
      lastReadError = message
    }
  }

    const listeners = [
      // section provider 在 assemble waterfall 前求值，必须在原方法进入前准备注册。
      ctx.on('internal/get', (_caller, name, _error, next) => {
        const service = next()
        if (name !== 'systemPrompt' || service === undefined) return service
        return new Proxy(service, { get(target, property, receiver) {
          const value = Reflect.get(target, property, receiver)
          if (property !== 'assemble') return value
          return async (context: AssembleContext = {}) => {
            if (context.agent !== undefined && knownAgents.has(context.agent)) await ensureFresh(context.agent)
            return Reflect.apply(value, target, [context])
          }
        } })
      }, { global: true }),
      // `agent/created` 对四种来源都触发（startup / resume / clear / compact），每次都是一个新
      // Agent。**装配失败不得冒泡**：该事件的监听器被 await，抛错会让会话创建整个失败
      // （`dsh-agent` 的 runtime-types 契约），那会违背「任何一步停下插件都完整可用」。
      // 装载后由 mounts 的身份判据挡住重复；失败的不记入，避免重试风暴。
      ctx.on('agent/created', async ({ agent }) => {
        // 宿主在首条请求前等待此 Promise；失败只告警，不中止官方会话创建。
        await serial(async () => {
          try {
            await install(agent)
          } catch (error) {
            warn(error)
          }
        })
        return undefined
      }),
      ctx.on('agent/disposed', ({ agent }) => {
        disposed.add(agent)
        knownAgents.delete(agent)
        void serial(() => release(agent.id, agent)).catch(warn)
      }),
    ]
  ctx.effect(() => () => {
    active = false
    for (const remove of listeners) remove()
    for (const [file, listener] of watched) unwatchFile(file, listener)
    watched.clear()
    knownAgents.clear()
    return publication.dispose().then(() => pending).then(async () => {
      for (const id of mounts.keys()) await release(id)
    })
  }, 'prompt-tool assembly runtime')
  // 启动时已存在的 Agent 也要补装；`agents` 服务缺失时（极简/嵌入运行时）静默跳过，
  // 新增 Agent 仍由 `agent/created` 兜住——构造期绝不因缺服务而抛。
  try {
    for (const agent of ctx.agents.list()) {
      void serial(() => install(agent)).catch(warn)
    }
  } catch (error) {
    warn(error)
  }
  return {
    settled: async () => {
      let previous: Promise<void>
      do {
        await initialization.settled()
        await publication.settled()
        previous = pending
        await previous
      } while (previous !== pending)
    },
    hasMounted: (sessionId) => mounts.get(sessionId)?.committed === true,
    moduleIds: (sessionId) => mounts.get(sessionId)?.moduleIds ?? [],
    ruleDiagnostics: () => active ? ruleDiagnostics.snapshot() : emptyRuleDiagnostics(),
    schedule: moduleId => { if (active) publication.schedule(moduleId) },
    publicationFailures: () => publication.failures(),
    refresh: async (moduleId) => {
      if (!active) throw new Error('运行时配装已释放')
      try {
        await publication.flush(moduleId, true)
      } catch (error) {
        throw new AggregateError([error], `运行时配装更新失败：${failureReason(error)}`)
      }
    },
    dispose: async () => {
      active = false
      for (const remove of listeners) remove()
      for (const [file, listener] of watched) unwatchFile(file, listener)
      watched.clear()
      knownAgents.clear()
      await publication.dispose()
      await pending
      for (const id of mounts.keys()) await release(id)
    },
  }
}
