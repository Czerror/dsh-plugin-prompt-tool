/**
 * agent-assembly — 运行时配装通道。
 *
 * 目标形态：预设不再靠「注册进官方 agent-presets + 由宿主 Loader 挂载插件树」装配，
 * 而是插件在**每个 Agent 自己的 scope** 里建一份装配。
 *
 * 判据（与原预设形态逐项对齐，能力一项不删）：
 *   - 挂的是插件自己的引擎模块（`engine/*.mjs` 的 `apply(ctx, config)`），
 *     不再声明 `agent.cordis.yml` 这类「给宿主 Loader 用的组合本体」；
 *   - 官方工具行（`@deepseek-ai/dsh-persona` / `dsh-tool-*` 等）由会话原有预设提供，
 *     本通道**不**装第二棵官方插件树——那些包也不在插件包的解析面内；
 *   - 物化目录优先：`configs/`（原 `prompt-configs/`）、`custom-tools/` 存在就按它装配，
 *     缺失时回退 `preset.yml` 内嵌，两条路径的切片同源（`resolvePresetModuleFacts`）。
 *
 * 与官方挂载并存时不会重复：官方树里没有引擎行，引擎贡献只由本通道提供。
 */
import { existsSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { packageEngineDir, resolvePresetModuleFacts, resolvePresetDir, loadPresetSpec } from '../host/manifest.ts'
import type { PresetSpec } from '../host/manifest.ts'
import { assertPresetId } from '../host/preset-install.ts'

// @ts-expect-error ESM 引擎源码随插件提供。
import { loadPromptConfigFiles } from '../../engine/schema.mjs'
// @ts-expect-error ESM 引擎源码随插件提供。
import { applyPromptConfigs } from '../../engine/executor.mjs'

/** 引擎模块的受管配置字段：值按历史语义相对预设根书写（如 `../<id>/custom-tools`）。 */
const MANAGED_FIELDS = ['configsDir', 'strategyDir', 'policyFile', 'triggersFile'] as const

/** 私有服务提供的引擎能力：以 `pt-*` 服务挂载，不从包内 engine 目录 import。 */
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
  dispose(): Promise<void>
}

export interface AgentAssemblyOptions {
  presetRoot: string
  /** 当前激活预设 id（缺省或非法时回退默认预设）。 */
  currentPreset: () => string
  warn?: (message: string) => void
}

/**
 * 受管字段的路径换算：`configsDir` / `strategyDir` / `policyFile` / `triggersFile`
 * 一律解析到**当前预设目录内的真实位置**——声明怎么写都按预设目录作基准，三种形态同结果：
 *   - `./configs`（新形态）→ `<预设目录>/configs`；
 *   - `../<id>/triggers.yml`（历史形态：`ENGINE_MANAGED_PATHS` 的改写成这样，语义是
 *     「从历史引擎位置 `<预设根>/.engine/` 回到 `<预设根>/<id>/`」）→ `<预设目录>/triggers.yml`；
 *   - `../subagent-tools/policy.yml`（引擎行**初值**形态，只有组合源这么写）→ 同样按预设目录，
 *     落进该预设目录内——越出预设根的值由引擎自己的越界校验拒绝，不会被静默采信。
 * 已是 `file:` URL 的值原样保留。
 */
function absolutizeManagedFields(
  config: Record<string, unknown>, presetDir: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...config }
  for (const field of MANAGED_FIELDS) {
    const value = out[field]
    if (typeof value !== 'string' || value.length === 0) continue
    if (value.startsWith('file:')) continue
    out[field] = pathToFileURL(resolve(presetDir, value)).href
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
  presetId: string
}

/**
 * 读一份预设的装配输入：切片、引擎模块、所需宿主能力。
 *
 * 纯读缝（只依赖包内引擎与预设目录），供挂载与回归测试共用；`hasService` 是宿主能力探针。
 */
export async function prepareAssembly(
  presetRoot: string, presetId: string, hasService: (name: string) => boolean,
): Promise<PreparedAssembly> {
  assertPresetId(presetId)
  const presetDir = resolvePresetDir(presetId, presetRoot)
  const spec = loadPresetSpec(presetDir) as PresetSpec
  const facts = resolvePresetModuleFacts(spec, presetDir)
  if (facts.effectiveModules === null) throw new Error(`预设 ${presetId} 的模块声明无效，无法配装`)
  const configsByModule = facts.effectiveConfigs ?? {}
  const promptDir = join(presetDir, 'prompt-configs')
  const configs = existsSync(promptDir)
    ? loadPromptConfigFiles(pathToFileURL(promptDir + sep))
    : (spec.promptConfigs ?? [])
  const engineDir = packageEngineDir()
  const services = new Set<string>()
  const modules: PreparedAssembly['modules'] = []
  for (const id of facts.effectiveModules) {
    if (id === 'prompt-config-engine') continue
    const privateService = PRIVATE_SERVICES[id]
    if (privateService !== undefined) {
      if (!hasService(privateService)) throw new Error(`配装所需能力不可用：${privateService}`)
      services.add(privateService)
      continue
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
    const config = absolutizeManagedFields(configsByModule[id] ?? {}, presetDir)
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
  for (const name of services) {
    if (!hasService(name)) throw new Error(`配装所需宿主能力不可用：${name}`)
  }
  return { configs, modules, services, presetId }
}

export function createAgentAssembly(ctx: Context, options: AgentAssemblyOptions): AgentAssemblyRuntime {
  const mounts = new Map<string, { agent: Agent; fiber: { dispose(): Promise<void> | void } }>()
  /** 准备期就失败的 Agent：不反复重试同一份坏定义。 */
  const failed = new Set<string>()
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

  const install = async (agent: Agent): Promise<void> => {
    if (!active || failed.has(agent.id) || mounts.has(agent.id)) return
    const presetId = options.currentPreset()
    let prepared: PreparedAssembly
    try {
      prepared = await prepareAssembly(options.presetRoot, presetId, (name) => agent.ctx.get(name) !== undefined)
    } catch (error) {
      // 同一个 Agent 不反复重试同一份坏定义；改好定义后的新 Agent 会重新尝试。
      failed.add(agent.id)
      throw error
    }
    if (!active || failed.has(agent.id)) return
    const fiber = agent.ctx.plugin({
      name: 'prompt-tool-assembly',
      inject: [...prepared.services],
      apply: async (scopeCtx: Context) => {
        if (prepared.configs.length > 0) {
          applyPromptConfigs(scopeCtx, prepared.configs, {
            sourceId: `preset:${prepared.presetId}`,
            prepend: true,
            officialInstructions: false,
          })
        }
        for (const module of prepared.modules) {
          // 引擎入口既有同步也有 async（`declared-triggers.apply` 是 async）：先 await 再判
          // disposer，否则 Promise 会被当成清理函数存下来，永不被调用。
          const result: unknown = await module.apply(scopeCtx, module.config)
          if (typeof result === 'function') scopeCtx.effect(() => result as () => void, module.id)
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
    if (!active) { await disposeFiber(); return }
    mounts.set(agent.id, { agent, fiber: { dispose: async () => { await disposeFiber() } } })
  }

    const listeners = [
      // `agent/created` 对四种来源都触发（startup / resume / clear / compact），每次都是一个新
      // Agent。**装配失败不得冒泡**：该事件的监听器被 await，抛错会让会话创建整个失败
      // （`dsh-agent` 的 runtime-types 契约），那会违背「任何一步停下插件都完整可用」。
      // 装载后由 mounts 的身份判据挡住重复；失败的不记入，避免重试风暴。
      ctx.on('agent/created', ({ agent }) => {
        // 返回 undefined 而非 void：该事件的回调契约是 `Promise<undefined> | undefined`。
        void serial(agent.id, async () => {
          try {
            await install(agent)
          } catch (error) {
            warn(error)
          }
        })
        return undefined
      }),
      ctx.on('agent/disposed', ({ agent }) => {
        void serial(agent.id, () => release(agent.id, agent)).catch(warn)
      }),
    ]
  ctx.effect(() => () => {
    active = false
    for (const remove of listeners) remove()
    // release 会改 mounts：先把迭代器收敛成任务数组，再等它们结束。
    return Promise.all(Array.from(mounts.keys(), (id) => release(id))).then(() => undefined)
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
    dispose: async () => {
      active = false
      await Promise.all(queues.values())
      for (const id of mounts.keys()) await release(id)
    },
  }
}
