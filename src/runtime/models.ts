/** 模型服务商/模型名检测与子代理固定模型路由（宿主侧运行时工具）。 */
import type { Context } from '@deepseek-ai/cordis'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import type { ModelReasoningView } from '../shared/bridge-contract.ts'

/**
 * 官方子代理 seam 的类型锚点：本插件只读 `list()` / `getProvider()` 并显式传参，
 * 不替换 {@link SubagentRuntime.start} 或 `startContinuable`；这里保留类型引用是为了
 * 让「不碰 registry 方法」这条边界在类型层随 rc.2 契约一起编译校验。
 */
export type PluginSubagentSeam = Pick<SubagentRuntime, 'list' | 'getProvider'>

/** 模型服务商检测结果（含诊断信息，供 Web/TUI 展示）。 */
export interface ModelDetection {
  /** 是否检测到任何已注册/可配置的服务商路由。 */
  available: boolean
  /** 已检测到（live 注册）的模型服务商 id——状态提示用。 */
  providers: string[]
  error?: string
}

/** 检测模型服务商：只统计 live 注册路由（状态提示与下拉共用同一来源）。 */
export function detectModels(ctx: Context): ModelDetection {
  const empty = { available: false, providers: [] }
  try {
    const llm = ctx.get('llm') as {
      listProviders?: () => Array<{ id?: string; name?: string }>
    } | undefined
    if (llm === undefined) return { ...empty, error: 'ctx.get("llm") 返回 undefined' }
    const live = llm.listProviders?.() ?? []
    const liveNames = new Set<string>()
    for (const provider of live) {
      const id = typeof provider.id === 'string' ? provider.id : String(provider.id ?? '')
      liveNames.add(id || provider.name || '(unnamed)')
    }
    return {
      available: liveNames.size > 0,
      providers: [...liveNames],
      ...(live.length === 0 ? { error: 'llm 服务未返回任何 provider' } : {}),
    }
  } catch (error) {
    return { ...empty, error: error instanceof Error ? error.message : String(error) }
  }
}

/** 模型目录会话内缓存（10min TTL）：provider 模型列表在会话内基本固定，
 *  而 listModels 可能走远端查询——每次 /describe 全量重查会拖慢工作台加载与每次保存。
 *  TTL 过短（60s）会让「首次打开工作台」每次都重新全量查询。 */
interface CatalogEntry {
  at: number
  value: Record<string, string[]>
  /** 同源并发刷新合并：两个调用共享同一次 provider 查询。 */
  inflight?: Promise<Record<string, string[]>>
  /** 递增代次：晚到的旧刷新不得覆盖新一代结果。 */
  generation: number
}

/** 目录缓存按 Context 实例隔离：两个互不相干的 Context 不共享 provider 目录。 */
const catalogCaches = new WeakMap<object, CatalogEntry>()
const CATALOG_TTL_MS = 600_000
/** 单 provider 模型查询超时：远端 listModels 慢/挂起时快速降级，不拖垮整个目录。 */
const MODEL_QUERY_TIMEOUT_MS = 1500
/** 单模型推理档位查询超时：与目录查询同一降级策略，不让慢 adapter 拖住下拉。 */
const REASONING_QUERY_TIMEOUT_MS = 1500

/** provider/model 未查过时的空视图（不虚构档位）。 */
const UNKNOWN_REASONING: ModelReasoningView = { known: false, efforts: [] }

const reasoningCache = new WeakMap<object, Map<string, ModelReasoningView | undefined>>()
const reasoningInflight = new WeakMap<object, Map<string, Promise<ModelReasoningView | undefined>>>()

/** provider/model 的缓存键：用 \u0000 分隔，避免 provider 或 model 含分隔符时串键。 */
const reasoningKey = (provider: string, model: string): string => `${provider}\u0000${model}`

function reasoningStore(ctx: Context): Map<string, ModelReasoningView | undefined> {
  const key = ctx as unknown as object
  const existing = reasoningCache.get(key)
  if (existing !== undefined) return existing
  const created = new Map<string, ModelReasoningView | undefined>()
  reasoningCache.set(key, created)
  return created
}

function reasoningInflightStore(ctx: Context): Map<string, Promise<ModelReasoningView | undefined>> {
  const key = ctx as unknown as object
  const existing = reasoningInflight.get(key)
  if (existing !== undefined) return existing
  const created = new Map<string, Promise<ModelReasoningView | undefined>>()
  reasoningInflight.set(key, created)
  return created
}

/** 官方一模型路由的推理元数据 → 展示视图（缺席 = 查过但没有档位，不虚构）。 */
function reasoningViewOf(value: unknown): ModelReasoningView {
  if (value === null || value === undefined || typeof value !== 'object') return { known: true, efforts: [] }
  const record = value as { efforts?: unknown; defaultEffort?: unknown }
  const efforts: ModelReasoningView['efforts'] = []
  if (Array.isArray(record.efforts)) {
    for (const entry of record.efforts) {
      if (entry === null || typeof entry !== 'object') continue
      const effort = entry as { id?: unknown; name?: unknown; description?: unknown }
      if (typeof effort.id !== 'string' || effort.id.length === 0) continue
      efforts.push({
        id: effort.id,
        name: typeof effort.name === 'string' && effort.name.length > 0 ? effort.name : effort.id,
        ...(typeof effort.description === 'string' && effort.description.length > 0 ? { description: effort.description } : {}),
      })
    }
  }
  const defaultEffort = typeof record.defaultEffort === 'string' && record.defaultEffort.length > 0 ? record.defaultEffort : undefined
  return { known: true, efforts, ...(defaultEffort === undefined ? {} : { defaultEffort }) }
}

/**
 * 某个 provider/model 路由的推理档位：命中缓存同步返回，未命中返回 UNKNOWN（不触发查询）。
 * 已查过但不提供档位的路由返回 `{ known: true, efforts: [] }`，调用方据此隐藏档位选择
 * 而不是用固定列表伪造能力（M-12）。
 */
export function peekModelReasoning(ctx: Context, provider: string, model: string): ModelReasoningView {
  return reasoningStore(ctx).get(reasoningKey(provider, model)) ?? UNKNOWN_REASONING
}

/**
 * 查询并缓存某个 provider/model 路由的推理档位。
 *
 * 官方 `llm.resolveModelInfo` 是唯一元数据来源（不按模型名推断档位）；同一 Context 的
 * 并发查询合并为一次，单点失败/超时返回 undefined（调用方回退到「未查到」而不是空档位）。
 * 目录只作展示，不是授权白名单：查询失败不影响用户保存任意模型 id。
 */
export async function refreshModelReasoning(ctx: Context, provider: string, model: string): Promise<ModelReasoningView | undefined> {
  if (provider.length === 0 || model.length === 0) return undefined
  const key = reasoningKey(provider, model)
  const cache = reasoningStore(ctx)
  const cached = cache.get(key)
  if (cached !== undefined) return cached
  const inflight = reasoningInflightStore(ctx)
  const pending = inflight.get(key)
  if (pending !== undefined) return pending
  const query = (async (): Promise<ModelReasoningView | undefined> => {
    try {
      const llm = ctx.get('llm') as {
        resolveModelInfo?: (provider: string, model: string, signal?: AbortSignal) => Promise<unknown>
      } | undefined
      if (llm?.resolveModelInfo === undefined) return undefined
      // 官方方法是类方法（内部经 this 访问 adapters）：解构调用会丢 this，必须 bind。
      const resolveModelInfo = llm.resolveModelInfo.bind(llm)
      const resolved = await withModelTimeout(resolveModelInfo(provider, model), REASONING_QUERY_TIMEOUT_MS)
      if (resolved === undefined) return undefined
      const view = reasoningViewOf((resolved as { reasoning?: unknown }).reasoning)
      cache.set(key, view)
      return view
    } catch {
      // 未注册路由 / adapter 拒绝：保持「未查到」，不写空档位缓存，也不阻断保存。
      return undefined
    } finally {
      inflight.delete(key)
    }
  })()
  inflight.set(key, query)
  return query
}

/** 拓扑变化或显式刷新时清空推理档位缓存（与目录缓存同一失效时机）。 */
function clearReasoningCache(ctx: Context): void {
  const key = ctx as unknown as object
  reasoningCache.get(key)?.clear()
  reasoningInflight.get(key)?.clear()
}

/**
 * 目录失效：provider 注册/移除（官方 `llm/adapters-updated`）、服务重挂或显式刷新时
 * 调用。代次前进让已在飞的旧查询回来后不再写缓存（M-11：变更必须让相关缓存失效）。
 * 只清目录，不碰 provider 单点失败的既有语义。
 */
export function invalidateModelCatalog(ctx: Context): void {
  const key = ctx as unknown as object
  const entry = catalogCaches.get(key)
  if (entry === undefined) return
  entry.generation += 1
  entry.at = 0
  entry.value = {}
  // 在飞的同源刷新继续跑完，但代次不匹配，结果不会回写。
  entry.inflight = undefined
  // 推理档位元数据同样属于 provider 拓扑的产物，同一时机失效。
  clearReasoningCache(ctx)
}

function catalogEntry(ctx: Context): CatalogEntry {
  const key = ctx as unknown as object
  const existing = catalogCaches.get(key)
  if (existing !== undefined) return existing
  const created: CatalogEntry = { at: 0, value: {}, generation: 0 }
  catalogCaches.set(key, created)
  return created
}

/** 缓存命中返回同一对象；未命中/过期返回 undefined（/describe 不触发查询）。 */
function freshCatalog(entry: CatalogEntry, now: number): Record<string, string[]> | undefined {
  return entry.at > 0 && now - entry.at < CATALOG_TTL_MS ? entry.value : undefined
}

/** 查询超时：AbortSignal.timeout 驱动竞速，超时解析 undefined 降级（不拖垮目录）。 */
function withModelTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  const signal = AbortSignal.timeout(ms)
  return Promise.race([
    promise,
    new Promise<undefined>((resolve) => {
      if (signal.aborted) {
        resolve(undefined)
        return
      }
      signal.addEventListener('abort', () => resolve(undefined), { once: true })
    }),
  ])
}

/** 同步读模型目录缓存（命中返回，未命中/过期返回空）：/describe 不触发查询。 */
export function peekModelCatalog(ctx: Context): Record<string, string[]> {
  return freshCatalog(catalogEntry(ctx), Date.now()) ?? {}
}

/**
 * 查询各已注册服务商公布的模型 id（对齐官方 web 选择器 buildModelCatalog：只遍历
 * listProviders() live 路由，单点失败/超时不拖垮整体；仅作展示，不构成路由白名单）。
 * 并行查询 + 10min 缓存 + 单点超时；同 Context 的并发刷新合并为一次查询，
 * 失败只影响该次刷新（不写空缓存），旧代次结果不回写新数据。
 */
export async function listAdvertisedModels(ctx: Context): Promise<Record<string, string[]>> {
  const entry = catalogEntry(ctx)
  const cached = freshCatalog(entry, Date.now())
  if (cached !== undefined) return cached
  if (entry.inflight !== undefined) return entry.inflight
  const generation = entry.generation
  const refresh = refreshModelCatalog(ctx).then((catalog) => {
    if (entry.generation === generation) {
      entry.at = Date.now()
      entry.value = catalog
    }
    entry.inflight = undefined
    return entry.value
  }, (error: unknown) => {
    entry.inflight = undefined
    throw error
  })
  entry.inflight = refresh
  return refresh
}

/** 单次全量刷新；单 provider 失败只丢弃该 provider 的本轮结果，其余照常入目录。 */
async function refreshModelCatalog(ctx: Context): Promise<Record<string, string[]>> {
  const catalog: Record<string, string[]> = {}
  const llm = ctx.get('llm') as {
    listProviders?: () => Array<{ id?: string; name?: string }>
    listModels?: (provider: string) => Promise<Array<{ id?: string; name?: string }>>
  } | undefined
  if (llm?.listProviders === undefined || llm.listModels === undefined) return catalog
  // 官方 llm 服务方法是类方法（内部经 this 访问 adapters/registration）：
  // 解构后直接调用会丢失 this 绑定（TypeError）→ 必须 bind。
  const listModels = llm.listModels.bind(llm)
  const liveProviders = (llm.listProviders() ?? [])
    .map((entry) => (typeof entry?.id === 'string' && entry.id.length > 0 ? entry.id : (typeof entry?.name === 'string' ? entry.name : '')))
    .filter((id) => id.length > 0)
  await Promise.all(liveProviders.map(async (provider) => {
    try {
      const models = await withModelTimeout(listModels(provider), MODEL_QUERY_TIMEOUT_MS)
      if (!Array.isArray(models)) return
      const ids = models
        .map((entry) => (typeof entry?.id === 'string' && entry.id.length > 0 ? entry.id : (typeof entry?.name === 'string' ? entry.name : '')))
        .filter((id) => id.length > 0)
      if (ids.length > 0) catalog[provider] = ids
    } catch {
      // 单个服务商查询失败不影响其余（adapter 可能未公布模型）。
    }
  }))
  return catalog
}

/**
 * 本插件子代理入口的显式模型路由（subagentModelProvider + subagentModelName 同时非空时生效）。
 *
 * 只产出要传给 {@link SubagentRuntime.start} 的 `agentOptions`，由调用方显式传入；
 * 不修改 registry 上的 `start` / `startContinuable` 方法，也不在根 scope 强加默认值——
 * 官方 API 的替换会让第三方直派调用也带上本插件的模型，超出插件授权范围。
 */
export function resolveSubagentStartOptions(
  isEnabled: () => boolean,
  provider: () => string,
  model: () => string,
  getReasoningEffort?: () => string,
): AgentOptions | undefined {
  if (!isEnabled()) return undefined
  const providerId = provider()
  const modelId = model()
  if (providerId.length === 0 || modelId.length === 0) return undefined
  const effort = (getReasoningEffort?.() ?? '').trim()
  return {
    provider: providerId,
    model: modelId,
    ...(effort.length > 0 ? { reasoningEffort: effort as ReasoningEffortId } : {}),
  }
}

