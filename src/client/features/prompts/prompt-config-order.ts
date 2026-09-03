import type { PromptConfigDraft } from '../../prompt-tool-types.ts'

export const promptConfigLayer = (config: PromptConfigDraft): string => config.layer ?? 'pre-step'
/** 与列表一致的显示视图排序：按（层序, order, 声明序）稳定排序，返回排序后 id 序列。
 *  strategy 传入时（世界书筛选视图）只在该策略子集内移动/排序，避免与不可见配置交换。 */
export function viewOrderedIds(
  all: PromptConfigDraft[],
  layer: string | undefined,
  layers: readonly string[],
  strategy?: string,
): string[] {
  const layerRank = (config: PromptConfigDraft): number => {
    const index = layers.indexOf(promptConfigLayer(config))
    return index < 0 ? layers.length : index
  }
  return all
    .map((config, index) => ({ config, index }))
    .filter((entry) => layer === undefined || promptConfigLayer(entry.config) === layer)
    .filter((entry) => strategy === undefined || entry.config.strategy === strategy)
    .sort((a, b) => {
      const byLayer = layerRank(a.config) - layerRank(b.config)
      if (byLayer !== 0) return byLayer
      const byOrder = (a.config.order ?? 0) - (b.config.order ?? 0)
      if (byOrder !== 0) return byOrder
      return a.index - b.index
    })
    .map((entry) => entry.config.id)
}

/**
 * 在显示视图中向上/向下移动：目标 = 当前项的显示相邻项（层序/order/声明序），
 * 交换两者的 order 与数组位置——显示顺序与引擎注入顺序（数组序）同步变化。
 * 修复：此前按数组相邻交换，跨层配置混合时数组顺序 ≠ 显示顺序，上移/下移视觉失效。
 */
export function moveWithinLayer(
  all: PromptConfigDraft[],
  globalIndex: number,
  delta: -1 | 1,
  layer?: string,
  layers?: readonly string[],
  strategy?: string,
): PromptConfigDraft[] {
  const currentId = all[globalIndex]?.id
  if (currentId === undefined) return all
  const view = viewOrderedIds(all, layer, layers ?? [], strategy)
  const viewIndex = view.indexOf(currentId)
  const targetViewIndex = viewIndex + delta
  if (viewIndex < 0 || targetViewIndex < 0 || targetViewIndex >= view.length) return all
  const targetId = view[targetViewIndex]!
  const currentIndex = all.findIndex((config) => config.id === currentId)
  const targetIndex = all.findIndex((config) => config.id === targetId)
  if (currentIndex < 0 || targetIndex < 0) return all
  const next = [...all]
  const current = next[currentIndex]
  const targetCard = next[targetIndex]
  // 引擎按 order 升序渲染（executor pre-step / layers 同规则）：层内移动必须同步
  // 交换 order，否则拖拽后实际注入顺序不变（显示与引擎脱节 = 排序混乱）。
  if (current === undefined || targetCard === undefined) return all
  next[currentIndex] = { ...targetCard, order: current.order ?? 0 }
  next[targetIndex] = { ...current, order: targetCard.order ?? 0 }
  return next
}

/** 拖拽移动到目标显示位置：把 source 移到 target 前/后，用显示视图相邻交换逐步到位
 *  （order 链式交换，与连续点击上移/下移等价）。 */
export function moveToView(
  all: PromptConfigDraft[],
  sourceId: string,
  targetId: string,
  before: boolean,
  layer?: string,
  layers?: readonly string[],
  strategy?: string,
): PromptConfigDraft[] {
  const view = viewOrderedIds(all, layer, layers ?? [], strategy)
  const sourceIndex = view.indexOf(sourceId)
  if (sourceIndex < 0) return all
  const rest = view.filter((id) => id !== sourceId)
  const targetIndex = rest.indexOf(targetId)
  if (targetIndex < 0) return all
  const targetViewIndex = targetIndex + (before ? 0 : 1)
  if (targetViewIndex === sourceIndex) return all
  const steps = targetViewIndex - sourceIndex
  const delta: -1 | 1 = steps > 0 ? 1 : -1
  let current = all
  for (let step = 0; step < Math.abs(steps); step++) {
    const globalIndex = current.findIndex((config) => config.id === sourceId)
    if (globalIndex < 0) break
    current = moveWithinLayer(current, globalIndex, delta, layer, layers, strategy)
  }
  return current
}
