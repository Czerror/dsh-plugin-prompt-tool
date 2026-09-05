import type { MenuSelectOption } from '../../ui/MenuSelect.tsx'

export interface ModelSelection {
  provider: string
  model: string
}

/** 用无歧义的复合值承载 provider + model；同名模型可跨服务商共存。 */
export const modelChoiceValue = (provider: string, model: string): string =>
  JSON.stringify([provider, model])

export function parseModelChoice(value: string): ModelSelection | undefined {
  if (value.length === 0) return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed) || parsed.length !== 2
      || typeof parsed[0] !== 'string' || parsed[0].length === 0
      || typeof parsed[1] !== 'string' || parsed[1].length === 0) return undefined
    return { provider: parsed[0], model: parsed[1] }
  } catch {
    return undefined
  }
}

/** 将完整模型目录展平为按 provider 连续分组的下拉选项。 */
export function buildModelOptions(
  catalog: Record<string, readonly string[]>,
  extras: readonly ModelSelection[] = [],
): MenuSelectOption[] {
  const options: MenuSelectOption[] = [{ value: '', label: '（不设置，继承默认）' }]
  const seen = new Set<string>()
  const add = (provider: string, model: string): void => {
    if (provider.length === 0 || model.length === 0) return
    const value = modelChoiceValue(provider, model)
    if (seen.has(value)) return
    seen.add(value)
    options.push({ value, label: model, group: provider })
  }

  for (const [provider, models] of Object.entries(catalog)) {
    if (!Array.isArray(models)) continue
    for (const model of models) {
      if (typeof model === 'string') add(provider, model)
    }
  }
  for (const selection of extras) add(selection.provider, selection.model)
  return options
}
