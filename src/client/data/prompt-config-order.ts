/**
 * 配置卡在视图内的移动与同位置判据（**全仓唯一一份**）。
 *
 * 顺序的唯一权威是 `module.yml` 顶层的 `configOrder`。写它的有两处：排序保存
 * （`host/module-config-order.ts`）与规则事务新建卡（`host/module-rules.ts`）；切片恢复
 * 只把缺号卡的 `order` 写进 `rules/_settings.yml`，不改 `module.yml.configOrder`。尾部算法
 * 只有 `shared/module-config-order.ts#nextConfigSequence` 一份。本模块只把「拖到哪」翻译成
 * 「身份的新顺序」，**不改卡定义、不碰官方档位 `order`**——那个值属于宿主
 * `systemPrompt.section({ order })` 的装配刻度，插件的排序通道不提交它。
 */
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

/** 插入点归属：省略层按引擎缺省 `pre-step`。 */
const layerOf = (config: SortableConfig): string => config.layer ?? 'pre-step'

type SortableConfig = Pick<PromptConfigDraft, 'layer' | 'position'>

/**
 * 同位置判据：同插入点、同位置。`system-section` / `runtime-context` 的官方档位
 * 只决定装配初始槽位，先后由 `configOrder` 覆盖（引擎以 prepend 监听 `system-prompt/assemble`，在 `next()` 之后回填），
 * 因此跨档位也允许排序。
 *
 * 入参只要排序相关的字段：排序快照的条目（`ModuleConfigOrderEntry`）与视图草稿
 * （`PromptConfigDraft`）都能直接传，页内不再另写一份判据。
 */
export const configPositionKey = (config: SortableConfig): string => JSON.stringify([layerOf(config), config.position ?? 'after-user'])
export const sameConfigPosition = (left: SortableConfig, right: SortableConfig): boolean => configPositionKey(left) === configPositionKey(right)

/** 交换同位置的两个条目，保留其他条目在完整列表中的槽位。 */
export function swapConfigOrder(all: PromptConfigDraft[], sourceId: string, targetId: string): PromptConfigDraft[] {
  if (sourceId === targetId) return all
  const sourceIndex = all.findIndex(config => config.id === sourceId)
  const targetIndex = all.findIndex(config => config.id === targetId)
  const source = all[sourceIndex], target = all[targetIndex]
  if (source === undefined || target === undefined || !sameConfigPosition(source, target)) return all
  const next = all.slice()
  next[sourceIndex] = target
  next[targetIndex] = source
  return next
}
