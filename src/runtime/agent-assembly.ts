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
import { existsSync } from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { packageEngineDir, resolveModuleFacts, resolveModuleDir, loadModuleSpec } from '../host/manifest.ts'
import type { ModuleSpec } from '../host/manifest.ts'
import { assertModuleId } from '../host/module-install.ts'
import { readConfigOrder } from '../host/module-config-order.ts'
import { rulePromptConfigOptions } from '../host/module-rules.ts'
import { compileCustomTool, validateCustomTools } from '../host/custom-tools.ts'
import { recordRuleOutcome } from './rule-diagnostics.ts'

// @ts-expect-error ESM 引擎源码随插件提供。
import { compileRules, isFixedRegistration } from '../../engine/rule-spec.mjs'
// @ts-expect-error ESM 引擎源码随插件提供。
import { mountRuleSources } from '../../engine/rule-runtime.mjs'
// @ts-expect-error ESM 引擎源码随插件提供（去重身份判据的唯一来源）。
import { identityOf } from '../../engine/executor.mjs'
// @ts-expect-error 条件在真实挂载 scope 绑定；准备期只保留经过预检的定义快照。
import { compileWhen, loadStandingMountFor } from '../../engine/conditions/index.mjs'

/** 引擎模块的受管配置字段：值按历史语义相对模块根书写（如 `../<id>/custom-tools`）。 */
const MANAGED_FIELDS = ['configsDir', 'strategyDir', 'policyFile', 'rulesFile'] as const

/** 私有工具适配器依赖的服务；适配器仍复用包内引擎入口。 */
const PRIVATE_SERVICES: Record<string, string> = {
  'character-tools': 'pt-character-tools',
  'world-book-tools': 'pt-world-book-tools',
  'session-var-tools': 'pt-session-var-tools',
}

export interface AgentAssemblyRuntime {
  /** 等待当前排队的装配任务收敛（测试与诊断用；生产路径不依赖它）。 */
  settled(): Promise<void>
  /** 某个 Agent 当前是否装上了配装（装配失败的 Agent 不在其中）。 */
  hasMounted(sessionId: string): boolean
  /**
   * 这个 Agent 当前装着哪几层提示词，按**启用表顺序**给出（装配失败的为空数组）。
   *
   * 这是「运行时配装」对外唯一的身份答案：工具写入目标等按 Agent 定位的判据都取它，
   * 因此不必再去问宿主「这个会话绑定了哪个官方预设」——模块早已与官方预设解耦。
   */
  moduleIds(sessionId: string): readonly string[]
  /** 保存完成后重装存活 Agent；省略 id 表示启用表或部署开关改变。 */
  refresh(moduleId?: string): Promise<void>
  dispose(): Promise<void>
}

export interface AgentAssemblyOptions {
  moduleRoot: string
  /**
   * 参与装配的模块 id 列表（= 存储根 `config.yml` 启用表 ∩ 磁盘存在）。
   *
   * **启用即配装**：列了 A+B 就装 A+B，追加 C 就是 A+B+C。每个模块各自贡献自己的
   * 提示词配置、引擎参数与能力声明，彼此不合并、不互相改写。配置执行按各卡的持久序号，
   * `agent-request` 后序覆盖前序；启用表顺序仅保留模块身份与工具写入目标语义。
   * 返回空数组表示没有模块参与装配（此时不注册任何贡献）。
   */
  enabledModules: () => readonly string[]
  warn?: (message: string) => void
}

/**
 * 受管字段的路径换算：`configsDir` / `strategyDir` / `policyFile` / `rulesFile`
 * 一律解析到**当前模块目录内的真实位置**——声明怎么写都按模块目录作基准，三种形态同结果：
 *   - `./configs`（新形态）→ `<模块目录>/configs`；
 *   - `../<id>/triggers.yml`（历史形态：`ENGINE_MANAGED_PATHS` 的改写成这样，语义是
 *     「从历史引擎位置 `<模块根>/.engine/` 回到 `<模块根>/<id>/`」）→ `<模块目录>/triggers.yml`；
 *   - `../subagent-tools/policy.yml`（组合源初值）→ 相对模块内历史引擎位置，
 *     同样落进当前模块目录；引擎继续负责资源越界校验。
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
  ruleConditions: ReadonlyMap<string, unknown>
  modules: Array<{ id: string; apply: (ctx: Context, config: Record<string, unknown>) => unknown; config: Record<string, unknown> }>
  services: Set<string>
  moduleId: string
  persona?: ModuleSpec['persona']
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
  const rules = compileRules(spec.rules ?? [], {
    moduleId,
    configOrder: readConfigOrder(spec.configOrder),
    variables: spec.variables, variablesEnabled: spec.variablesEnabled,
    promptConfigOptions: rulePromptConfigOptions(moduleDir, ruleConfig.strategyDir),
  })
  const ruleConditions = new Map((spec.rules ?? []).map(rule => [rule.id, structuredClone(rule.if)]))
  // 「独占」（`complete`）组装期兜底：宿主 system-prompt 对「多于一个生效 complete 段」
  // 直接抛错（packages/core/system-prompt/src/index.ts:597-600），而写盘前的互斥门控只
  // 覆盖两个 bridge 端点——手改 module.yml、还原 ZIP/备份、导入包都能绕过。这里在装配前
  // 查一次，把「system 提示被清到只剩一段 / 组装失败」挡在 Agent 创建之前。
  // 判据与写盘门控同源（引擎的 isFixedRegistration；`module-storage.ts:112` 的
  // `compileRules(…, { personaComplete })` 用同一判据），但本兜底**更窄**：只扫 `rule.then`、
  // 不接收 personaComplete——正常读路径已先拒（那处扫全部展开动作，含 else 与嵌套分支），
  // 这里只挡绕过读路径（手改 yml / 还原备份 / 导入包）的漏网。「独占」是 system-section 层的
  // params.complete，只有它会被宿主当作唯一 system 段；其他层的同名键不是独占。
  const exclusiveConfigs = (spec.rules ?? []).filter(rule => rule.enabled !== false).flatMap(rule => rule.then.filter(action => {
    const config = action.config as { params?: { complete?: unknown } } | undefined
    return action.kind === 'inject-text' && config?.params?.complete === true && isFixedRegistration(config, rule.layer)
  }))
  const personaComplete = spec.persona?.complete === true
  if (exclusiveConfigs.length > 1 || (personaComplete && exclusiveConfigs.length > 0)) {
    throw new Error(
      `模块 ${moduleId} 有多个生效的「独占」段（顶层人设${personaComplete ? '已' : '未'}开启），`
      + '同一模块只能有一个：请先关闭其一',
    )
  }
  const engineDir = packageEngineDir()
  const services = new Set<string>()
  const modules: PreparedAssembly['modules'] = []
  for (const id of new Set([...facts.effectiveModules, ...facts.rowIds])) {
    if (id === 'rule-engine') continue
    if (id === 'subagent-tool-policy' && (spec.subagentToolPolicy === undefined || spec.subagentToolPolicy === null)) continue
    if (id === 'prompt-config-engine' || id === 'declared-triggers') throw new Error(`模块 ${moduleId} 仍声明旧规则引擎 ${id}，请先离线迁移`)
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
    if (id === 'subagent-tool-policy') config.policy = structuredClone(spec.subagentToolPolicy)
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
  return { rules, ruleConditions, modules, services, moduleId, persona: spec.persona }
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
 * 两条通道都要查：`plugin`（消息来源身份，进 `source.plugin`）与 `sourceKind`（进
 * `source.kind`）。只查 plugin 会漏掉「两张 id 不同、却声明同一个 sourceKind」的两卡：
 * 它们同样经 kind 通道互相压制。`suspectedCopy` 标出「同一份 rule/action 身份被两个模块
 * 各带一份」，那才是复制模块的指纹；只有一份（或 rule/action 身份不同）时是有意共享同一
 * 身份去重，措辞不劝改。sourceKind 未显式声明时按配置 id 编译（`plugin:<id>`），那是
 * plugin 通道的同一笔账，不另算一条 kind 重复。
 */
interface DuplicateIdentity { channel: 'plugin' | 'kind'; identity: string; suspectedCopy: boolean; moduleIds: string[] }

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
    const sourceKind = typeof config.sourceKind === 'string' && config.sourceKind.length > 0 ? config.sourceKind : undefined
    // sourceKind 缺省时由配置 id 编译成 `plugin:<id>`：那与 plugin 通道同源，不另立一条 kind 重复。
    const declaredKind = sourceKind !== undefined && sourceKind !== `plugin:${String(config.id)}` ? sourceKind : undefined
    return [
      { key: `plugin:${pluginIdentity}`, channel: 'plugin' as const, identity: pluginIdentity, copyKey: ruleKeyOf(config), moduleId },
      ...(declaredKind === undefined ? [] : [{ key: `kind:${declaredKind}`, channel: 'kind' as const, identity: declaredKind, copyKey: ruleKeyOf(config), moduleId }]),
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
  const mounts = new Map<string, { agent: Agent; fiber: { dispose(): Promise<void> | void }; prepared: PreparedAssembly[]; moduleIds: readonly string[] }>()
  const disposed = new WeakSet<Agent>()
  const queues = new Map<string, Promise<void>>()
  let active = true
  const warn = (error: unknown): void => {
    const message = `prompt-tool: 运行时配装失败：${failureReason(error)}`
    if (options.warn !== undefined) options.warn(message)
    else ctx.logger?.warn?.(message)
  }
  // 跨模块重复身份按「身份 → 模块集」只报一次：反复重装（每次保存、每个新 Agent）不刷屏；
  // 装上第二处（新模块）时再加报一次。
  const reportedDuplicates = new Set<string>()
  const warnOnce = (message: string): void => {
    if (reportedDuplicates.has(message)) return
    reportedDuplicates.add(message)
    if (options.warn !== undefined) options.warn(message)
    else ctx.logger?.warn?.(message)
  }
  const serial = (sessionId: string, task: () => Promise<void>): Promise<void> => {
    const next = (queues.get(sessionId) ?? Promise.resolve()).then(task)
    const settled = next.then(() => {}, () => {})
    queues.set(sessionId, settled)
    void settled.then(() => { if (queues.get(sessionId) === settled) queues.delete(sessionId) })
    return next
  }
  const release = async (sessionId: string, agent?: Agent): Promise<void> => {
    const current = mounts.get(sessionId)
    if (current === undefined) return
    if (agent !== undefined && current.agent !== agent) return
    mounts.delete(sessionId)
    await current.fiber.dispose()
  }

  const mount = async (agent: Agent, prepared: PreparedAssembly[], duplicateIdentities: DuplicateIdentity[] = []): Promise<void> => {
    // 宿主能力取并集；模块身份独立保留，提示词配置在各自插入点按持久序号执行。
    const services = new Set<string>()
    for (const item of prepared) for (const name of item.services) services.add(name)
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
            ? `模块 ${item.moduleIds.join('、')} 疑似由复制产生同一个${where}（dedupe: session/batch）：按会话去重只保留先到者，请改 rule id 或显式 identity 以区分`
            : `模块 ${item.moduleIds.join('、')} 有意共享同一个${where}（dedupe: session/batch）：两模块按会话共享这一份去重；同一批内各自仍会注入一次`)
        }
        const standingMountFor = await loadStandingMountFor()
        // 只重绑纯条件，不重读定义、模板或动作。每次挂载/失败恢复都获得自己的闭包与观察状态。
        const ruleSources = prepared.filter(item => item.rules.length > 0).map(item => ({
          moduleId: item.moduleId,
          rules: item.rules.map(value => {
            const rule = value as { id: string; actions?: unknown[] } & Record<string, unknown>
            return {
              ...rule,
              when: compileWhen(item.ruleConditions.get(rule.id), { ctx: scopeCtx, standingMountFor }),
              // 动作级条件同样在真实挂载 scope 重绑，否则 else / 嵌套 if 里的 preset 恒 UNAVAILABLE。
              actions: rule.actions?.map(rawAction => {
                const action = rawAction as { conditions?: unknown } & Record<string, unknown>
                return { ...action, actionWhen: compileWhen(action.conditions, { ctx: scopeCtx, standingMountFor }) }
              }),
            }
          }),
        }))
        for (const item of prepared) {
          if (item.persona !== undefined) {
            const persona = item.persona
            // 独立模块贡献使用独立段名，避免覆盖宿主或子代理 setup 的同名注册。
            scopeCtx.systemPrompt.section({
              name: `prompt-tool:${item.moduleId}:persona-prefix`,
              order: scopeCtx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
              text: persona.prefix, complete: persona.complete === true,
            })
            scopeCtx.systemPrompt.section({
              name: `prompt-tool:${item.moduleId}:persona-suffix`,
              order: scopeCtx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX'),
              text: persona.suffix ?? '',
            })
            if (persona.includeRuntimeContext === false) scopeCtx.systemPrompt.suppressRuntimeContext()
          }
        }
        scopeCtx.effect(() => mountRuleSources(scopeCtx, ruleSources, { onOutcome: recordRuleOutcome }))
        for (const item of prepared) {
          for (const module of item.modules) {
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
    })
  }

  const install = async (agent: Agent, refresh = false): Promise<void> => {
    if (!active || disposed.has(agent)) return
    const previous = mounts.get(agent.id)
    if (!refresh && previous?.agent === agent) return
    // 完整准备后才撤旧；坏配置不得拆掉当前可用贡献。
    const prepared: PreparedAssembly[] = []
    for (const id of options.enabledModules()) {
      prepared.push(await prepareAssembly(options.moduleRoot, id, (name) => agent.ctx.get(name) !== undefined))
    }
    if (!active || disposed.has(agent)) return
    try {
      // 撤旧也在 try 里：撤旧失败同样要尽力把旧装配装回去，否则旧贡献凭空消失。
      await release(agent.id)
      await mount(agent, prepared, duplicateDedupeIdentities(prepared))
    } catch (error) {
      if (previous?.agent === agent && active && !disposed.has(agent)) {
        // ponytail: 撤旧只失败在 dispose 上时旧 fiber 可能半撤且已出账；出现重复贡献再改成「撤旧成功才记账」。
        try {
          await mount(agent, previous.prepared)
        } catch (restoreError) {
          // 两个原因都得留下：只读 message 的上报点看不到 errors。
          throw new AggregateError([error, restoreError],
            `切换装配失败（${failureReason(error)}），且恢复原有装配也失败（${failureReason(restoreError)}）`)
        }
      }
      throw error
    }
  }

    const listeners = [
      // `agent/created` 对四种来源都触发（startup / resume / clear / compact），每次都是一个新
      // Agent。**装配失败不得冒泡**：该事件的监听器被 await，抛错会让会话创建整个失败
      // （`dsh-agent` 的 runtime-types 契约），那会违背「任何一步停下插件都完整可用」。
      // 装载后由 mounts 的身份判据挡住重复；失败的不记入，避免重试风暴。
      ctx.on('agent/created', async ({ agent }) => {
        // 宿主在首条请求前等待此 Promise；失败只告警，不中止官方会话创建。
        await serial(agent.id, async () => {
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
        void serial(agent.id, () => release(agent.id, agent)).catch(warn)
      }),
    ]
  ctx.effect(() => () => {
    active = false
    for (const remove of listeners) remove()
    return Promise.all(queues.values()).then(async () => {
      for (const id of mounts.keys()) await release(id)
    })
  }, 'prompt-tool assembly runtime')
  // 启动时已存在的 Agent 也要补装；`agents` 服务缺失时（极简/嵌入运行时）静默跳过，
  // 新增 Agent 仍由 `agent/created` 兜住——构造期绝不因缺服务而抛。
  try {
    for (const agent of ctx.agents.list()) {
      void serial(agent.id, () => install(agent)).catch(warn)
    }
  } catch (error) {
    warn(error)
  }
  return {
    settled: () => Promise.all(queues.values()).then(() => undefined),
    hasMounted: (sessionId) => mounts.has(sessionId),
    moduleIds: (sessionId) => mounts.get(sessionId)?.moduleIds ?? [],
    refresh: async (moduleId) => {
      if (!active) throw new Error('运行时配装已释放')
      const results = await Promise.allSettled(ctx.agents.list().map((agent) => serial(agent.id, async () => {
        const current = mounts.get(agent.id)
        if (moduleId !== undefined && current !== undefined
          && !current.moduleIds.includes(moduleId) && !options.enabledModules().includes(moduleId)) return
        await install(agent, true)
      })))
      const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      if (errors.length > 0) {
        // 本层是唯一到达 bridge / TUI 的出口，而它们只读 message：原因必须带出来。
        throw new AggregateError(errors.map((result) => result.reason),
          `模块已保存，但运行时配装更新失败：${errors.map((result) => failureReason(result.reason)).join('；')}`)
      }
    },
    dispose: async () => {
      active = false
      for (const remove of listeners) remove()
      await Promise.all(queues.values())
      for (const id of mounts.keys()) await release(id)
    },
  }
}
