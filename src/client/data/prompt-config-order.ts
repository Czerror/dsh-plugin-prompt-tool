/**
 * 配置卡在视图内的移动与同档位判据（**全仓唯一一份**）。
 *
 * 顺序的唯一权威是 `module.yml` 顶层的 `configOrder`（`src/host/module-config-order.ts` 写、
 * `src/host/module-storage.ts` 的 `order[rule.id] ?? tail` 读）：本模块只把「拖到哪」翻译成
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

type SortableConfig = Pick<PromptConfigDraft, 'layer' | 'position' | 'order'>

/**
 * 同档位判据：同插入点、同位置；`system-section` / `runtime-context` 另要求同官方档位
 * （不同档位之间的先后由宿主装配刻度决定，插件不假装能排）。
 *
 * 入参只要排序相关的三个字段：排序快照的条目（`ModuleConfigOrderEntry`）与视图草稿
 * （`PromptConfigDraft`）都能直接传，页内不再另写一份判据。
 */
export function sameConfigPosition(left: SortableConfig, right: SortableConfig): boolean {
  return layerOf(left) === layerOf(right)
    && (left.position ?? 'after-user') === (right.position ?? 'after-user')
    && (!(left.layer === 'system-section' || left.layer === 'runtime-context') || (left.order ?? 0) === (right.order ?? 0))
}

/**
 * 把 `sourceId` 移到 `targetId` 前（`before`）或后：一步重排，返回新的身份顺序。
 *
 * `movableIds` 是**必填**的可移动集合（身份键）——调用方用 `sameConfigPosition` 过滤出同档位集合，
 * 跨插入点/跨官方档位的目标不在集合里，本函数原样返回入参。这个参数刻意没有「不限制」的缺省值：
 * 缺省不限制正是历史上跨插入点错位的来源。
 *
 * 返回值交给 `use-module-config-order` 的 `save(next)`，由 `/module-config-order` 端点写回
 * `configOrder`；本函数只重排身份顺序，不修改任何卡的字段。
 */
export function reorderToView(
  all: PromptConfigDraft[],
  sourceId: string,
  targetId: string,
  before: boolean,
  movableIds: readonly string[],
): PromptConfigDraft[] {
  if (sourceId === targetId) return all
  if (!movableIds.includes(sourceId) || !movableIds.includes(targetId)) return all
  const sourceIndex = all.findIndex(config => config.id === sourceId)
  if (sourceIndex < 0 || !all.some(config => config.id === targetId)) return all
  const source = all[sourceIndex]!
  const rest = all.filter((_, index) => index !== sourceIndex)
  const anchor = rest.findIndex(config => config.id === targetId)
  const insertAt = before ? anchor : anchor + 1
  return [...rest.slice(0, insertAt), source, ...rest.slice(insertAt)]
}
