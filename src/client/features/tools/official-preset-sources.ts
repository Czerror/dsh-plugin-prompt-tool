/**
 * 工具面「来源」清单的过滤规则。
 *
 * 这一层要回答的是：官方 preset roster 里哪些该作为**工具面来源**列出来。
 *
 * 唯一判据是**可用性**：`broken` 非空的项缺组合文件，选中它读不出工具面，因此排除。
 * 本插件的模块不登记为官方预设，本来就不在 roster 里，无需在此识别或排除。
 */
/**
 * 官方 roster 的一项。形状对齐 `PromptToolHostApi['listAgentPresets']` 的元素——
 * 官方 `AgentPreset`（`agent-presets` 的 `list()`）只有这几个字段。
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
 * - 其余保持 roster 原顺序，不重排、不合并。
 */
export function officialPresetSources(roster: readonly AgentPresetSource[]): AgentPresetSource[] {
  return roster.filter((preset) => preset.broken === undefined)
}
