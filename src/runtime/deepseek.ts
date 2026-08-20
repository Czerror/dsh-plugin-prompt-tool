/** DeepSeek 模型检测与子代理固定模型路由（宿主侧运行时工具）。 */
import type { Context } from '@deepseek-ai/cordis'

/** DeepSeek 模型检测结果（含诊断信息，供 Web/TUI 展示）。 */
export interface DeepseekDetection {
  available: boolean
  providers: string[]
  error?: string
}

/** 检测 DeepSeek 模型：live provider + 可配置 provider 目录双通道匹配。 */
export function detectDeepseek(ctx: Context): DeepseekDetection {
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
    const matches = (id: string | undefined, name: string | undefined): boolean =>
      /deepseek/i.test(id ?? '') || /deepseek/i.test(name ?? '')
    for (const provider of live) {
      const id = typeof provider.id === 'string' ? provider.id : String(provider.id ?? '')
      names.add(id || provider.name || '(unnamed)')
      if (matches(provider.id, provider.name)) return { available: true, providers: [...names] }
    }
    for (const provider of configured) {
      const id = typeof provider.provider === 'string' ? provider.provider : ''
      if (id.length > 0) names.add(id)
      if (matches(provider.provider, provider.displayName)) return { available: true, providers: [...names] }
    }
    return { available: false, providers: [...names], ...(live.length === 0 && configured.length === 0 ? { error: 'llm 服务未返回任何 provider' } : {}) }
  } catch (error) {
    return { ...empty, error: error instanceof Error ? error.message : String(error) }
  }
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
