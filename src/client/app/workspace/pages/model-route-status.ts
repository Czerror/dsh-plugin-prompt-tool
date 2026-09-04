export interface HostModelView {
  provider?: string
  model?: string
}

/** 只返回当前选中服务商的目录模型；宿主默认模型仅在服务商一致时补入。 */
export function resolveProviderModels(
  catalog: Record<string, string[]>,
  selectedProvider: string,
  detectedProviders: readonly string[],
  host?: HostModelView,
): { provider: string; models: string[] } {
  const provider = selectedProvider || host?.provider || detectedProviders[0] || ''
  if (provider.length === 0) return { provider, models: [] }
  const models = catalog[provider] ?? []
  const hostModel = host?.provider === provider ? host.model : undefined
  return {
    provider,
    models: [...new Set([...models, ...(hostModel !== undefined && hostModel.length > 0 ? [hostModel] : [])])],
  }
}
