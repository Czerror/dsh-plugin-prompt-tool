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
 *   - 物化目录优先：`configs/`（原 `prompt-configs/`）、`custom-tools/` 存在就按它装配，
 *     缺失时回退 `module.yml` 内嵌，两条路径的切片同源（`resolveModuleFacts`）。
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
import { assertPresetId } from '../host/module-install.ts'
import { MODULE_CONFIGS_DIR } from '../host/paths.ts'
import { readConfigOrder } from '../host/module-config-order.ts'

// @ts-expect-error ESM 引擎源码随插件提供。
import { createPromptConfigs, loadPromptConfigFiles } from '../../engine/schema.mjs'
// @ts-expect-error ESM 引擎源码随插件提供。
import { applyPromptConfigSources } from '../../engine/executor.mjs'

/** 引擎模块的受管配置字段：值按历史语义相对模块根书写（如 `../<id>/custom-tools`）。 */
const MANAGED_FIELDS = ['configsDir', 'strategyDir', 'policyFile', 'triggersFile'] as const

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
 * 受管字段的路径换算：`configsDir` / `strategyDir` / `policyFile` / `triggersFile`
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
  configs: unknown[]
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
  assertPresetId(moduleId)
  const moduleDir = resolveModuleDir(moduleId, moduleRoot)
  const spec = loadModuleSpec(moduleDir) as ModuleSpec
  const facts = resolveModuleFacts(spec, moduleDir)
  if (facts.effectiveModules === null) throw new Error(`模块 ${moduleId} 的模块声明无效，无法配装`)
  const configsByModule = facts.effectiveConfigs ?? {}
  const promptDir = join(moduleDir, MODULE_CONFIGS_DIR)
  const specs = existsSync(promptDir)
    ? loadPromptConfigFiles(pathToFileURL(promptDir + sep))
    : (spec.promptConfigs ?? [])
  const promptConfig = absolutizeManagedFields(configsByModule['prompt-config-engine'] ?? {}, moduleDir)
  const configs = createPromptConfigs(specs, {
    sourceModuleId: moduleId,
    configOrder: readConfigOrder(spec.configOrder),
    templateBaseUrl: pathToFileURL(join(moduleRoot, '.engine', 'prompt-config-engine.mjs')),
    templatePresetRoot: pathToFileURL(moduleRoot + sep),
    strategyDir: typeof promptConfig.strategyDir === 'string'
      ? promptConfig.strategyDir.replace(/\/?$/, '/') : undefined,
  })
  // 「独占」（`complete`）组装期兜底：宿主 system-prompt 对「多于一个生效 complete 段」
  // 直接抛错（packages/core/system-prompt/src/index.ts:597-600），而写盘前的互斥门控只
  // 覆盖两个 bridge 端点——手改 module.yml、还原 ZIP/备份、导入包都能绕过。这里在装配前
  // 查一次，把「system 提示被清到只剩一段 / 组装失败」挡在 Agent 创建之前。
  // 判据与写门控同源：`enabled !== false` 才参与，「独占」是 system-section 的 params.complete。
  const exclusiveConfigs = configs.filter((config: unknown) => {
    if (config === null || typeof config !== 'object') return false
    const entry = config as { enabled?: unknown; params?: { complete?: unknown } }
    return entry.enabled !== false && entry.params?.complete === true
  })
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
    if (id === 'prompt-config-engine') continue
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
    if (id === 'tool-config-engine' || id === 'declared-triggers') {
      config.presetRoot = pathToFileURL(moduleRoot + sep).href
    }
    // 引擎自带的声明就绪校验（未知键 fail loud）在装配期先跑一次，避免挂载到一半才炸。
    const contract = (module as { configContract?: { parse?: (value: unknown, name: string) => unknown } }).configContract
    contract?.parse?.(config, id)
    modules.push({ id, apply: module.apply, config })
  }
  if (configs.length > 0) {
    services.add('systemPrompt')
    services.add('tools')
    services.add('llm')
  }
  if (spec.persona !== undefined) services.add('systemPrompt')
  for (const name of services) {
    if (!hasService(name)) throw new Error(`配装所需宿主能力不可用：${name}`)
  }
  return { configs, modules, services, moduleId, persona: spec.persona }
}

export function createAgentAssembly(ctx: Context, options: AgentAssemblyOptions): AgentAssemblyRuntime {
  const mounts = new Map<string, { agent: Agent; fiber: { dispose(): Promise<void> | void }; prepared: PreparedAssembly[]; moduleIds: readonly string[] }>()
  const disposed = new WeakSet<Agent>()
  const queues = new Map<string, Promise<void>>()
  let active = true
  const warn = (error: unknown): void => {
    const message = `prompt-tool: 运行时配装失败：${error instanceof Error ? error.message : String(error)}`
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

  const mount = async (agent: Agent, prepared: PreparedAssembly[]): Promise<void> => {
    // 宿主能力取并集；模块身份独立保留，提示词配置在各自插入点按持久序号执行。
    const services = new Set<string>()
    for (const item of prepared) for (const name of item.services) services.add(name)
    const fiber = agent.ctx.plugin({
      name: 'prompt-tool-assembly',
      inject: [...services],
      apply: async (scopeCtx: Context) => {
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
        scopeCtx.effect(() => applyPromptConfigSources(scopeCtx, prepared
          .filter(item => item.configs.length > 0)
          .map(item => ({ sourceId: `module:${item.moduleId}`, configs: item.configs })), { prepend: true }))
        for (const item of prepared) {
          for (const module of item.modules) {
            // 引擎入口既有同步也有 async（`declared-triggers.apply` 是 async）：先 await 再判
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
    await release(agent.id)
    try {
      await mount(agent, prepared)
    } catch (error) {
      if (previous?.agent === agent && active && !disposed.has(agent)) {
        await mount(agent, previous.prepared)
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
      if (errors.length > 0) throw new AggregateError(errors.map((result) => result.reason), '模块已保存，但运行时配装更新失败')
    },
    dispose: async () => {
      active = false
      for (const remove of listeners) remove()
      await Promise.all(queues.values())
      for (const id of mounts.keys()) await release(id)
    },
  }
}
