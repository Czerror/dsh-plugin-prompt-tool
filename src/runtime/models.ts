/** 模型服务商/模型名检测与子代理固定模型路由（宿主侧运行时工具）。 */
import type { Context } from '@deepseek-ai/cordis'

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
const catalogCache = new Map<string, { at: number; value: Record<string, string[]> }>()
const CATALOG_TTL_MS = 600_000
/** 单 provider 模型查询超时：远端 listModels 慢/挂起时快速降级，不拖垮整个目录。 */
const MODEL_QUERY_TIMEOUT_MS = 1500

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
export function peekModelCatalog(): Record<string, string[]> {
  const cached = catalogCache.get('default')
  return cached !== undefined && Date.now() - cached.at < CATALOG_TTL_MS ? cached.value : {}
}

/** 查询各已注册服务商公布的模型 id（对齐官方 web 选择器 buildModelCatalog：只遍历 listProviders() live 路由，单点失败/超时不拖垮整体；仅作展示，不构成路由白名单）。并行查询 + 10min 缓存 + 单点超时。 */
export async function listAdvertisedModels(ctx: Context): Promise<Record<string, string[]>> {
  const cached = catalogCache.get('default')
  if (cached !== undefined && Date.now() - cached.at < CATALOG_TTL_MS) return cached.value
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
  catalogCache.set('default', { at: Date.now(), value: catalog })
  return catalog
}

/**
 * 主对话默认模型控制：modelProvider + modelName 同时非空时，经官方
 * `agentDefaultModel.saveSelection` 写入新会话默认模型（对齐官方 web 切换模型的
 * 默认级持久化；只影响新创建的 Agent，不干预已有会话）。任一为空时若思维程度非空，
 * 则与宿主当前默认选择（currentSelection）合并、只同步思维程度而不劫持模型路由；
 * 三者皆空 = 不干预（继承用户在宿主 web 的选择）；agent-default-model 服务未装配时静默跳过。
 */
export function installDefaultModelRoute(
  ctx: Context,
  isEnabled: () => boolean,
  provider: () => string,
  model: () => string,
  getReasoningEffort?: () => string,
): () => void {
  const apply = (): void => {
    try {
      const service = ctx.get('agentDefaultModel') as {
        currentSelection?: () => { provider?: string; model?: string }
        saveSelection?: (selection: { provider: string; model: string; reasoningEffort?: string }) => void | Promise<void>
      } | undefined
      if (service?.saveSelection === undefined) return
      if (!isEnabled()) return
      // 官方 AgentDefaultModelSettings 含 reasoningEffort：插件思维程度设置非空时一并写入
      // 宿主默认（saveSelection 整体替换语义；插件 agent-request patch 仍按会话生效）。
      const effort = (getReasoningEffort?.() ?? '').trim()
      let targetProvider = provider()
      let targetModel = model()
      if (targetProvider.length === 0 || targetModel.length === 0) {
        // 未固定模型路由但设了思维程度：与宿主当前默认选择合并，只改思维程度不劫持模型/服务商。
        if (effort.length === 0) return
        const current = service.currentSelection?.()
        if (typeof current?.provider !== 'string' || current.provider.length === 0
          || typeof current?.model !== 'string' || current.model.length === 0) return
        targetProvider = current.provider
        targetModel = current.model
      }
      const result = service.saveSelection({
        provider: targetProvider,
        model: targetModel,
        ...(effort.length > 0 ? { reasoningEffort: effort } : {}),
      })
      // 官方 saveSelection 可能返回 Promise：拒绝必须捕获，避免 unhandledRejection。
      if (result !== null && typeof result === 'object' && typeof (result as Promise<void>).then === 'function') {
        (result as Promise<void>).catch(() => {
          // 异步保存失败不阻断插件（宿主默认未写入，下次设置变更重试）。
        })
      }
    } catch {
      // agent-default-model 服务缺失（core 未装配）时静默跳过，不阻断插件。
    }
  }
  apply()
  return apply
}

/** 给宿主直派子代理补固定模型路由（modelProvider + modelName 同时非空时生效）；调用方显式 provider/model 优先，不覆盖 persona 与工具白名单。 */
export function installSubagentModelRoute(ctx: Context, isEnabled: () => boolean, provider: () => string, model: () => string): void {
  ctx.inject(['subagents'], (sctx: Context) => {
    const service = sctx.get('subagents') as { start?: (name: string, request: Record<string, unknown>) => unknown } | undefined
    if (service === undefined || typeof service.start !== 'function') return
    const original = service.start
    const wrapped = (name: string, request: Record<string, unknown>): unknown => {
      if (!isEnabled() || request === null || typeof request !== 'object') return original.call(service, name, request)
      const agentOptions = request.agentOptions !== null && typeof request.agentOptions === 'object'
        ? request.agentOptions as Record<string, unknown>
        : {}
      if (agentOptions.provider === undefined && agentOptions.model === undefined) {
        return original.call(service, name, { ...request, agentOptions: { ...agentOptions, provider: provider(), model: model() } })
      }
      return original.call(service, name, request)
    }
    service.start = wrapped
    return () => {
      if (service.start === wrapped) service.start = original
    }
  })
}

