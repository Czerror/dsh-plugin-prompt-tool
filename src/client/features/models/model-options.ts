import type { MenuSelectOption } from '../../ui/MenuSelect.tsx'
import type { ModelReasoningView } from '../../../shared/bridge-contract.ts'

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

/**
 * 思维程度选项：只展示该 provider/model 路由真实声明的档位。
 *
 * - 目录未收录 / 尚未查到（known=false）：返回空列表，UI 不展示档位选择，也不用固定
 *   列表伪造能力（M-12）。
 * - 查过但不提供推理档位（known=true, efforts 空）：同样返回空列表。
 * - 已保存但不在目录中的值：保留为唯一可选项并标注，用户切换界面后仍然可回显，
 *   不会因为目录缺项把存量值吞掉。
 *
 * @param view 该路由的推理元数据视图（来自 store.modelReasoning）。
 * @param current 当前生效的档位值（会话选择 / 插件参数），空字符串表示未设置。
 */
export function buildEffortOptions(view: ModelReasoningView | undefined, current: string): MenuSelectOption[] {
  const known = view?.known === true
  const declared = known && Array.isArray(view.efforts) ? view.efforts : []
  const options: MenuSelectOption[] = []
  const seen = new Set<string>()
  for (const effort of declared) {
    if (typeof effort?.id !== 'string' || effort.id.length === 0 || seen.has(effort.id)) continue
    seen.add(effort.id)
    const label = typeof effort.name === 'string' && effort.name.length > 0 ? effort.name : effort.id
    options.push({ value: effort.id, label })
  }
  if (current.length > 0 && !seen.has(current)) {
    options.push({ value: current, label: `${current}（当前值，模型未声明）` })
  }
  if (options.length > 0 && current.length === 0 && !options.some((option) => option.value === '')) {
    options.unshift({ value: '', label: '（模型默认）' })
  }
  return options
}
