/**
 * 工具面「来源」清单的过滤规则。
 *
 * 这一层要回答的是：官方 preset roster 里哪些该作为**工具面来源**列出来。
 *
 * 背景：本插件的模块会被登记成官方预设身份（组合本体为空，装配由插件的运行时通道承担），
 * 于是官方 roster 里混着两类 id——真官方预设与本插件模块。而**模块的工具面由会话装配
 * 决定**，已由「当前会话工具」完整体现；把它再当作「预设来源」列出来，会让这一栏名不符实
 * （它读的其实是宿主预设的 scope）。所以这里把本插件模块排除，只留官方预设。
 */
/**
 * 官方 roster 的一项。形状对齐 `PromptToolHostApi['listAgentPresets']` 的元素——
 * 官方 `AgentPreset`（`agent-presets` 的 `list()`）只有这几个字段，没有可用来区分
 * 「官方预设 / 本插件模块」的来源标记，故识别只能靠调用方传入的 `managedIds`。
 */
export interface AgentPresetSource {
  id: string
  name?: string
  description?: string
  broken?: string
}

/**
 * 从官方 roster 中挑出可作工具面来源的项。
 *
 * - 排除损坏项（`broken` 非空：缺组合文件等，选了也读不出工具面）；
 * - 排除本插件自己的模块（`managedIds`，见文件头说明）；
 * - 其余保持 roster 原顺序，不重排、不合并。
 */
export function officialPresetSources(
  roster: readonly AgentPresetSource[],
  managedIds: readonly string[] | undefined,
): AgentPresetSource[] {
  const managed = new Set(managedIds ?? [])
  return roster.filter((preset) => preset.broken === undefined && !managed.has(preset.id))
}
