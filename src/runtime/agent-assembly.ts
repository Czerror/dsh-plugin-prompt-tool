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
import { basename, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Context, Fiber, Plugin } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SystemPrompt, { PERSONA_PREFIX_SECTION } from '@deepseek-ai/dsh-system-prompt'
import type { AssembleContext, PromptSection, PromptSectionOrderName } from '@deepseek-ai/dsh-system-prompt'
import { scopeChainOf, scopeOf, type ScopeKey } from '@deepseek-ai/dsh-scope'
import { packageEngineDir, resolveModuleFacts, resolveModuleDir, resolveModuleParams, loadModuleSpec } from '../host/manifest.ts'
import type { ModuleSpec } from '../host/manifest.ts'
import { modelRequestConfigs } from '../host/prompt-configs.ts'
import { assertModuleDirectory, assertModuleId } from '../host/module-install.ts'
import { readConfigOrder } from '../host/module-config-order.ts'
import { rulePromptConfigOptions } from '../host/module-storage.ts'
import { compileCustomTool, validateCustomTools } from '../host/custom-tools.ts'
import { recordRuleOutcome } from './rule-diagnostics.ts'
import { createModuleVariableAdapter } from './module-variable-adapter.ts'
import { planPersonaSections, type PersonaCapture, type PersonaModule, type PersonaPlan } from './persona-registration.ts'
import { MODULE_TOOL_CAPABILITIES } from '../shared/engine-capabilities.ts'
import { enableTablePath, readGlobalLayerSettings } from '../host/config-store.ts'

// @ts-expect-error ESM 引擎源码随插件提供。
import { compileRules, completeRuleSections } from '../../engine/rule-spec.mjs'
// @ts-expect-error 与引擎注册侧共用主子身份判据。
import { isDelegated } from '../../engine/shared.mjs'
// @ts-expect-error ESM 引擎源码随插件提供。
import { mountRuleSources } from '../../engine/rule-runtime.mjs'
// @ts-expect-error ESM 引擎源码随插件提供（去重身份判据的唯一来源）。
import { identityOf } from '../../engine/executor.mjs'
// @ts-expect-error 条件在真实挂载 scope 绑定；准备期只保留经过预检的定义快照。
import { loadStandingMountFor } from '../../engine/conditions/index.mjs'

/** 引擎模块的受管配置字段：值按历史语义相对模块根书写（如 `../<id>/custom-tools`）。 */
const MANAGED_FIELDS = ['configsDir', 'strategyDir', 'policyFile', 'rulesFile'] as const

/** 私有工具适配器依赖的服务；适配器仍复用包内引擎入口。 */
const PRIVATE_SERVICES: Record<string, string> = Object.fromEntries(Object.values(MODULE_TOOL_CAPABILITIES).map(id => [id, `pt-${id}`]))

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
  /** 保存完成后重装存活 Agent；省略 id 表示启用表或部署开关改变。 */
  refresh(moduleId?: string): Promise<void>
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
  modules: Array<{ id: string; apply: (ctx: Context, config: Record<string, unknown>) => unknown; config: Record<string, unknown> }>
  services: Set<string>
  moduleId: string
  persona?: ModuleSpec['persona']
  variablesEnabled?: boolean
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
  const facts = resolveModuleFacts(spec, moduleDir)
  if (facts.effectiveModules === null) throw new Error(`模块 ${moduleId} 的模块声明无效，无法配装`)
  const configsByModule = facts.effectiveConfigs ?? {}
  const ruleConfig = absolutizeManagedFields(configsByModule['rule-engine'] ?? {}, moduleDir)
  // 公共参数区的模型路由/采样参数（`layerSettings` 的 agent-request / subagent-start）在装配期
  // 转成请求补丁：参数桥是它们的唯一可写入口，`request-params` 是它们唯一的执行点。
  // 合成规则与模块规则**一起编译**（不能事后推进已编译结果），只活在本次装配里，
  // 不进 module.yml / rules 切片；作者手写了同名 id 时让位给作者的定义。
  const declaredRules = spec.rules ?? []
  const syntheticRules = modelRequestConfigs(resolveModuleParams(spec, {})).map(request => ({
    id: `param-${request.id}`,
    name: String(request.name ?? request.id),
    layer: 'agent-request',
    if: { scope: { audience: request.audience === 'subagent' ? 'subagent' : 'main' } },
    then: [{ id: 'request', kind: 'request-params', ...request.params }],
  })).filter(rule => !declaredRules.some(declared => declared.id === rule.id))
  const rules = compileRules([...declaredRules, ...syntheticRules], {
    moduleId,
    configOrder: readConfigOrder(spec.configOrder),
    variables: spec.variables, variablesEnabled: spec.variablesEnabled,
    contextActivationRecursive: spec.contextActivationRecursive,
    promptConfigOptions: rulePromptConfigOptions(moduleDir, ruleConfig.strategyDir),
  })
  const engineDir = packageEngineDir()
  const services = new Set<string>()
  const modules: PreparedAssembly['modules'] = []
  for (const id of new Set([...facts.effectiveModules, ...facts.rowIds])) {
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
    if (file === undefined) continue
    const module = await import(pathToFileURL(file).href) as {
      apply?: (ctx: Context, config: Record<string, unknown>) => unknown
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
  return { rules, modules, services, moduleId, persona: spec.persona, variablesEnabled: spec.variablesEnabled }
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

function completeSectionsOf(prepared: PreparedAssembly[], audience: 'main' | 'subagent'): string[] {
  return prepared.flatMap(item => completeRuleSections(item.rules, audience).map((id: string) => `${item.moduleId}/${id}`))
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
    const declaredKind = config.sourceKind !== `plugin:${String(config.id)}` ? config.sourceKind : undefined
    return [
      { key: `plugin:${pluginIdentity}`, channel: 'plugin' as const, identity: pluginIdentity, copyKey: ruleKeyOf(config), moduleId },
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
  const mounts = new Map<string, { agent: Agent; fiber: { dispose(): Promise<void> | void }; prepared: PreparedAssembly[]; moduleIds: readonly string[]; signature: string; plan: PersonaPlan }>()
  const knownAgents = new Set<Agent>()
  const watched = new Map<string, () => void>()
  const disposed = new WeakSet<Agent>()
  let pending: Promise<void> = Promise.resolve()
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
  const serial = (task: () => Promise<void>): Promise<void> => {
    const next = pending.then(task)
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

  const mount = async (agent: Agent, prepared: PreparedAssembly[], plan: PersonaPlan, duplicateIdentities: DuplicateIdentity[] = [], signature = ''): Promise<void> => {
    // 宿主能力取并集；模块身份独立保留，提示词配置在各自插入点按持久序号执行。
    const services = new Set<string>()
    for (const item of prepared) for (const name of item.services) services.add(name)
    const personaActive = plan.sections.length > 0 || plan.suppressRuntimeContext
    if (personaActive) services.add('systemPrompt')
    const fiber = agent.ctx.plugin({
      name: 'prompt-tool-assembly',
      inject: [...services],
      apply: async (scopeCtx: Context) => {
        // 跨模块重复身份：装配照常成功，只把可诊断的后果上报一次（此处才 warnOnce 是因为
        // 试装/回滚会走两次 mount）。同一份 rule/action 身份被两个模块各带一份 = 疑似复制，
        // 提示改 id；否则是有意共享同一身份去重，措辞不劝改。
        for (const item of duplicateIdentities) {
          const where = item.channel === 'kind' ? `显式 sourceKind ${JSON.stringify(item.identity)}` : `去重身份 ${JSON.stringify(item.identity)}`
          warnOnce(item.suspectedCopy
            ? `模块 ${item.moduleIds.join('、')} 疑似由复制产生同一个${where}（dedupe: session/batch）：去重按模块各记一份，两份正文都会注入，请改 rule id 或显式 identity 以区分`
            : `模块 ${item.moduleIds.join('、')} 声明了同一个${where}（dedupe: session/batch）：去重按模块各记一份，两模块各自注入；同一模块内才共享这份去重`)
        }
        // 条件由挂载缝绑定（`mountRuleSources` 内部调 `rebindConditions`）：编译期没有挂载 scope 的
        // ctx，preset 条件在那边恒 UNAVAILABLE。调用方只负责把可选的官方模块兜底取到手，不再复制规则对象。
        const standingMountFor = await loadStandingMountFor()
        const ruleSources = prepared.filter(item => item.rules.length > 0).map(item => ({ moduleId: item.moduleId, rules: item.rules }))
        scopeCtx.effect(() => mountRuleSources(scopeCtx, ruleSources, { agent, onOutcome: recordRuleOutcome, variableStore, standingMountFor }))
        // 人设：在 Agent 自己的 scope 注册同名段，遮蔽祖先的部署人设与预设 persona 行；
        // 同层已被注册时只能先撤后挂，撤销凭据来自 AgentSetup 窗口内的捕获。
        if (personaActive) {
          const capture = options.personaCapture
          const scope = scopeOf(scopeCtx)
          scopeCtx.effect(() => {
            const applied: Array<() => void> = []
            const rollback = (): void => { while (applied.length > 0) applied.pop()?.() }
            try {
              for (const section of plan.sections) {
                const taken = scope === undefined ? undefined : capture?.records(scope).find(record => record.name === section.name)
                taken?.off()
                applied.push(scopeCtx.systemPrompt.section(section))
              }
              if (plan.suppressRuntimeContext) applied.push(scopeCtx.systemPrompt.suppressRuntimeContext())
            } catch (error) { rollback(); throw error }
            return rollback
          }, 'prompt-tool persona')
        }
        const privateMounted = new Set<string>()
        for (const item of prepared) {
          for (const module of item.modules) {
            if (PRIVATE_SERVICES[module.id] !== undefined) {
              if (privateMounted.has(module.id)) continue
              privateMounted.add(module.id)
            }
            // 引擎入口既有同步也有 async：先 await 再判
            // disposer，否则 Promise 会被当成清理函数存下来，永不被调用。
            const result: unknown = await module.apply(scopeCtx, module.config)
            if (typeof result === 'function') scopeCtx.effect(() => result as () => void, module.id)
          }
        }
      },
    })
    const disposeFiber = ctx.effect(() => () => fiber.dispose(), `prompt-tool assembly ${agent.id}`)
    try {
      await fiber
    } catch (error) {
      await disposeFiber()
      throw error
    }
    if (!active || disposed.has(agent)) { await disposeFiber(); return }
    mounts.set(agent.id, {
      agent,
      fiber: { dispose: async () => { await disposeFiber() } },
      prepared,
      moduleIds: prepared.map((item) => item.moduleId),
      signature, plan,
    })
  }

  const sourceSignature = (ids: readonly string[], personas: readonly PersonaModule[] | undefined): string => JSON.stringify([
    ids.map(id => {
      const { variables: _variables, ...definition } = loadModuleSpec(assertModuleDirectory(options.moduleRoot, id))
      // 变量值在求值时读取；自增不能让下一步重新注册规则。
      return [id, definition]
    }),
    personas,
  ])
  const watchSources = (ids: readonly string[], personas: readonly PersonaModule[] | undefined): void => {
    const files = new Set([enableTablePath(options.moduleRoot), ...[...ids, ...(personas ?? []).map(item => item.moduleId)]
      .map(id => { assertModuleId(id); return join(options.moduleRoot, id, 'module.yml') })])
    for (const [file, listener] of watched) if (!files.has(file)) { unwatchFile(file, listener); watched.delete(file) }
    for (const file of files) if (!watched.has(file)) {
      const listener = (): void => { if (active) for (const agent of knownAgents) void ensureFresh(agent) }
      watched.set(file, listener)
      watchFile(file, { persistent: false, interval: 200 }, listener)
    }
  }
  const replace = async (targets: readonly Agent[]): Promise<void> => {
    const ids = [...options.enabledModules()]
    const personaModules = options.personaModules?.()
    watchSources(ids, personaModules)
    const signature = sourceSignature(ids, personaModules)
    const live = targets.filter(agent => active && !disposed.has(agent))
    const prepared: PreparedAssembly[] = []
    for (const id of ids) prepared.push(await prepareAssembly(options.moduleRoot, id, name => live.every(agent => agent.ctx.get(name) !== undefined)))
    const candidates = live.map(agent => ({ agent, prepared, previous: mounts.get(agent.id) }))
    if (!active) return
    const effectivePersonas = personaModules ?? prepared
    if (options.personaModules !== undefined) await readPersonaKnowledge()
    const sections = { main: completeSectionsOf(prepared, 'main'), subagent: completeSectionsOf(prepared, 'subagent') }
    for (const [audience, complete] of Object.entries(sections)) {
      if (complete.length > 1) throw new Error(`${audience} 有多个生效 complete 段：${complete.join('、')}`)
    }
    // 人设候选与独占冲突必须在撤旧之前算清：坏候选、同受众双 complete 都在这里拒绝。
    const plans = candidates.map(({ agent }) => {
      const plan = personaPlanFor(agent, effectivePersonas)
      const audience = isDelegated(agent.session) ? 'subagent' : 'main'
      if (plan.sections.some(section => section.name === PERSONA_PREFIX_SECTION && section.complete === true) && sections[audience].length > 0) {
        throw new Error(`Agent ${agent.id} 的 ${audience} 有多个生效 complete 段：人设与 ${sections[audience].join('、')}`)
      }
      return plan
    })
    const changed: typeof candidates = []
    try {
      for (const [index, candidate] of candidates.entries()) {
        if (!active || disposed.has(candidate.agent)) continue
        changed.push(candidate)
        await release(candidate.agent.id)
        await mount(candidate.agent, candidate.prepared, plans[index] as PersonaPlan, duplicateDedupeIdentities(candidate.prepared), signature)
      }
    } catch (error) {
      const restoreErrors: unknown[] = []
      for (const { agent, previous } of changed.reverse()) {
        if (!active || disposed.has(agent)) continue
        try {
          await release(agent.id)
          if (previous?.agent === agent) await mount(agent, previous.prepared, previous.plan, [], previous.signature)
        } catch (restoreError) { restoreErrors.push(restoreError) }
      }
      if (restoreErrors.length > 0) {
        throw new AggregateError([error, ...restoreErrors],
          `切换装配失败（${failureReason(error)}），且恢复原有装配也失败（${restoreErrors.map(failureReason).join('；')}）`)
      }
      throw error
    }
  }
  const install = async (agent: Agent): Promise<void> => {
    knownAgents.add(agent)
    if (!active || disposed.has(agent) || mounts.get(agent.id)?.agent === agent) return
    await replace([agent])
  }
  let lastReadError: string | undefined
  const ensureFresh = (agent: Agent): Promise<void> => serial(async () => {
    if (!active || disposed.has(agent) || !knownAgents.has(agent)) return
    try {
      // 热读失败保留旧贡献；初次装配仍按 manifest 的全局参数软失败约定处理。
      readGlobalLayerSettings(options.moduleRoot)
      const ids = options.enabledModules(), personas = options.personaModules?.()
      watchSources(ids, personas)
      if (mounts.get(agent.id)?.signature !== sourceSignature(ids, personas)) await replace([agent])
      lastReadError = undefined
    } catch (error) {
      const message = failureReason(error)
      if (message !== lastReadError) warn(error)
      lastReadError = message
    }
  })

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
    return pending.then(async () => {
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
    settled: () => pending,
    hasMounted: (sessionId) => mounts.has(sessionId),
    moduleIds: (sessionId) => mounts.get(sessionId)?.moduleIds ?? [],
    refresh: async (moduleId) => {
      if (!active) throw new Error('运行时配装已释放')
      try {
        await serial(async () => {
          const enabled = options.enabledModules()
          // 宿主 registry 未必列出全部存活 Agent（嵌入运行时、测试替身），已挂载的一并纳入。
          const known = new Set<Agent>([...(ctx.get('agents')?.list() ?? []), ...[...mounts.values()].map(mount => mount.agent)])
          const targets = [...known].filter(agent => {
            const current = mounts.get(agent.id)
            return options.personaModules !== undefined || moduleId === undefined || current === undefined || current.moduleIds.includes(moduleId) || enabled.includes(moduleId)
          })
          await replace(targets)
        })
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
      await pending
      for (const id of mounts.keys()) await release(id)
    },
  }
}
