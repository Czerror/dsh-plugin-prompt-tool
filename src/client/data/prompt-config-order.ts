import type { PromptConfigDraft } from '../prompt-tool-types.ts'
import { configIdentityKey, type ModuleConfigOrderEntry } from '../../shared/module-config-order.ts'

/** 只供跨模块排序视图使用：同名配置用完整身份区分，摘要不进入正文保存通道。 */
export function moduleOrderConfigs(entries: readonly ModuleConfigOrderEntry[]): PromptConfigDraft[] {
  return entries.map(entry => ({
    id: configIdentityKey(entry), name: entry.name, enabled: entry.enabled,
    layer: entry.layer, position: entry.position, order: entry.order, sequence: entry.sequence,
    audience: entry.audience, strategy: entry.strategy,
  }))
}

/** 跨模块只读视图：按模块分组其它模块的配置卡（当前模块的卡不在此列）。 */
export interface OtherModuleGroup {
  moduleId: string
  name: string
  entries: ModuleConfigOrderEntry[]
}

/**
 * 过滤出**非当前模块**的卡并按模块分组，供主会话/子代理页的只读区块渲染。
 *
 * 身份判据是 `entry.moduleId` 本身，不解析 `configIdentityKey` 的 JSON 字符串——
 * 解析字符串容易在模块 id 含 `,`/`"` 时出错，而 entries 上本来就有模块身份。
 * `nameOf` 提供模块显示名（`store.meta.modules` 按 id 反查），取不到时回落模块 id。
 * 空分组被丢弃：只声明了引擎行、没有规则的模块不该在 UI 里占一个空块。
 */
export function groupOtherModuleCards(
  entries: readonly ModuleConfigOrderEntry[] | undefined,
  currentModuleId: string,
  nameOf: (moduleId: string) => string | undefined,
): OtherModuleGroup[] {
  if (!Array.isArray(entries)) return []
  const groups = new Map<string, ModuleConfigOrderEntry[]>()
  for (const entry of entries) {
    if (entry.moduleId === currentModuleId) continue
    const list = groups.get(entry.moduleId)
    if (list === undefined) groups.set(entry.moduleId, [entry])
    else list.push(entry)
  }
  return [...groups.entries()].map(([moduleId, grouped]) => ({
    moduleId,
    name: nameOf(moduleId) ?? moduleId,
    entries: grouped,
  }))
}

/** 跨模块只交换同插入点、位置与官方档位中的可见槽位。 */export function sameConfigPosition(left: PromptConfigDraft, right: PromptConfigDraft): boolean {
  return promptConfigLayer(left) === promptConfigLayer(right)
    && (left.position ?? 'after-user') === (right.position ?? 'after-user')
    && (!(left.layer === 'system-section' || left.layer === 'runtime-context') || (left.order ?? 0) === (right.order ?? 0))
}

export const promptConfigLayer = (config: PromptConfigDraft): string => config.layer ?? 'pre-step'
export const promptConfigViewOrder = (config: PromptConfigDraft): number =>
  config.layer === 'system-section' || config.layer === 'runtime-context' ? config.order ?? 0 : config.sequence ?? config.order ?? 0
/** 与列表一致的显示视图排序：按（层序, order, 声明序）稳定排序，返回排序后 id 序列。
 *  strategy 传入时（世界书筛选视图）只在该策略子集内移动/排序，避免与不可见配置交换。 */
export function viewOrderedIds(
  all: PromptConfigDraft[],
  layer: string | undefined,
  layers: readonly string[],
  strategy?: string,
  visibleIds?: readonly string[],
): string[] {
  const layerRank = (config: PromptConfigDraft): number => {
    const index = layers.indexOf(promptConfigLayer(config))
    return index < 0 ? layers.length : index
  }
  return all
    .map((config, index) => ({ config, index }))
    .filter((entry) => layer === undefined || promptConfigLayer(entry.config) === layer)
    .filter((entry) => strategy === undefined || entry.config.strategy === strategy)
    .filter((entry) => visibleIds === undefined || visibleIds.includes(entry.config.id))
    .sort((a, b) => {
      const byLayer = layerRank(a.config) - layerRank(b.config)
      if (byLayer !== 0) return byLayer
      const byOrder = promptConfigViewOrder(a.config) - promptConfigViewOrder(b.config)
      if (byOrder !== 0) return byOrder
      const bySequence = (a.config.sequence ?? 0) - (b.config.sequence ?? 0)
      if (bySequence !== 0) return bySequence
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
  visibleIds?: readonly string[],
): PromptConfigDraft[] {
  const source = all[globalIndex]
  if (source === undefined || (layer !== undefined && promptConfigLayer(source) !== layer)) return all
  const currentId = source.id
  const view = viewOrderedIds(all, promptConfigLayer(source), layers ?? [], strategy, visibleIds)
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
  next[currentIndex] = { ...targetCard, order: current.order ?? 0, ...(current.sequence === undefined ? {} : { sequence: current.sequence }) }
  next[targetIndex] = { ...current, order: targetCard.order ?? 0, ...(targetCard.sequence === undefined ? {} : { sequence: targetCard.sequence }) }
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
  visibleIds?: readonly string[],
): PromptConfigDraft[] {
  const source = all.find((config) => config.id === sourceId)
  if (source === undefined || (layer !== undefined && promptConfigLayer(source) !== layer)) return all
  const view = viewOrderedIds(all, promptConfigLayer(source), layers ?? [], strategy, visibleIds)
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
    current = moveWithinLayer(current, globalIndex, delta, layer, layers, strategy, visibleIds)
  }
  return current
}
