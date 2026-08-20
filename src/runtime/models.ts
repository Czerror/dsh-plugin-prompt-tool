/** 模型服务商/模型名检测与子代理固定模型路由（宿主侧运行时工具）。 */
import type { Context } from '@deepseek-ai/cordis'

/** 模型服务商检测结果（含诊断信息，供 Web/TUI 展示）。 */
export interface ModelDetection {
  /** 是否检测到任何已注册/可配置的服务商路由。 */
  available: boolean
  /** 全部模型服务商 id（live 路由 + 可配置目录，去重保序）。 */
  providers: string[]
  error?: string
}

/** 检测全部模型服务商：live provider + 可配置 provider 目录双通道合并（不限定厂商）。 */
export function detectModels(ctx: Context): ModelDetection {
  const empty = { available: false, providers: [] }
  try {
    const llm = ctx.get('llm') as {
      listProviders?: () => Array<{ id?: string; name?: string }>
      listConfigurableProviders?: () => Array<{ provider?: string; displayName?: string }>
    } | undefined
    if (llm === undefined) return { ...empty, error: 'ctx.get("llm") 返回 undefined' }
    const live = llm.listProviders?.() ?? []
    const configured = llm.listConfigurableProviders?.() ?? []
    const names = new Set<string>()
    for (const provider of live) {
      const id = typeof provider.id === 'string' ? provider.id : String(provider.id ?? '')
      names.add(id || provider.name || '(unnamed)')
    }
    for (const provider of configured) {
      const id = typeof provider.provider === 'string' ? provider.provider : ''
      if (id.length > 0) names.add(id)
    }
    return {
      available: names.size > 0,
      providers: [...names],
      ...(live.length === 0 && configured.length === 0 ? { error: 'llm 服务未返回任何 provider' } : {}),
    }
  } catch (error) {
    return { ...empty, error: error instanceof Error ? error.message : String(error) }
  }
}

/** 查询各已注册服务商公布的模型 id（对齐官方 web 选择器 buildModelCatalog：只遍历 listProviders() live 路由，单点失败不拖垮整体；仅作展示，不构成路由白名单）。 */
export async function listAdvertisedModels(ctx: Context): Promise<Record<string, string[]>> {
  const catalog: Record<string, string[]> = {}
  const llm = ctx.get('llm') as {
    listProviders?: () => Array<{ id?: string; name?: string }>
    listModels?: (provider: string) => Promise<Array<{ id?: string; name?: string }>>
  } | undefined
  if (llm?.listProviders === undefined || llm.listModels === undefined) return catalog
  const liveProviders = (llm.listProviders() ?? [])
    .map((entry) => (typeof entry?.id === 'string' && entry.id.length > 0 ? entry.id : (typeof entry?.name === 'string' ? entry.name : '')))
    .filter((id) => id.length > 0)
  for (const provider of liveProviders) {
    try {
      const models = await llm.listModels(provider)
      if (!Array.isArray(models)) continue
      const ids = models
        .map((entry) => (typeof entry?.id === 'string' && entry.id.length > 0 ? entry.id : (typeof entry?.name === 'string' ? entry.name : '')))
        .filter((id) => id.length > 0)
      if (ids.length > 0) catalog[provider] = ids
    } catch {
      // 单个服务商查询失败不影响其余（adapter 可能未公布模型）。
      continue
    }
  }
  return catalog
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
