/** 接入侧绑定检查及局部绕过；求值侧只执行，不认识能力种类。 */
export function bindHostDependency(rule, slot, dependency) {
  rule.hostDependencies ??= new Map()
  const dependencies = rule.hostDependencies.get(slot) ?? []
  rule.hostDependencies.set(slot, [...dependencies.filter(item => item.key !== dependency.key), dependency])
}

export function hostDependenciesAvailable(entry, frame, slot, unavailable) {
  for (const dependency of entry.rule?.hostDependencies?.get(slot) ?? []) {
    if (dependency.skip(frame) || dependency.available(entry, frame) !== false) continue
    if (dependency.reportUnavailable) unavailable()
    return false
  }
  return true
}
