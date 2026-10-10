const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0

/** 模块配置按持久序号执行；无物化来源的独立调用保留原 order 语义。 */
export function compareConfigSequence(a, b) {
  const difference = (a.sequence ?? a.order ?? 0) - (b.sequence ?? b.order ?? 0)
  if (difference !== 0) return difference
  if (a.sourceModuleId === undefined && b.sourceModuleId === undefined) return 0
  return compareText(a.sourceModuleId ?? '', b.sourceModuleId ?? '')
    || compareText(a.ruleId ?? a.id, b.ruleId ?? b.id)
    || (a.ruleActionIndex ?? 0) - (b.ruleActionIndex ?? 0)
    || compareText(a.id, b.id)
}

/** 官方文本段的定位仍由 order 决定；序号只提供同位置的稳定顺序。 */
export function compareTextPlacement(a, b) {
  return a.order - b.order || compareConfigSequence(a, b)
}
