/** 配置卡身份与排序快照；序号归模块定义，正文不进入排序载荷。 */
export interface ModuleConfigIdentity {
  moduleId: string
  configId: string
}

export interface ModuleConfigOrderEntry extends ModuleConfigIdentity {
  name: string
  layer: string
  position: string
  sequence: number
  enabled: boolean
  audience?: 'main' | 'subagent' | null
  strategy?: string
  /** 官方文本层的定位档位；其他层不使用。 */
  order?: number
}

export interface ModuleConfigOrderSnapshot {
  revision: string
  entries: ModuleConfigOrderEntry[]
}

export const configIdentityKey = (entry: ModuleConfigIdentity): string => JSON.stringify([entry.moduleId, entry.configId])

/**
 * 尾部序号：现有（含保留）最大序号 + 10，下限 -10。
 *
 * 保留序号 `reserved` 由调用方给：排序追加传其他启用模块的序号，规则事务传跨模块避碰集合；
 * 切片恢复只传本模块。合并与上限检查只在这里一份。
 */
export function nextConfigSequence(current: Record<string, number>, reserved: readonly number[] = []): number {
  let next = -10
  for (const value of Object.values(current)) next = Math.max(next, value)
  for (const value of reserved) next = Math.max(next, value)
  next += 10
  if (!Number.isSafeInteger(next)) throw new Error('配置卡排序序号超出安全整数范围')
  return next
}

/** 不以启用表次序打破同号平局；排序不改变配置卡身份。 */
export function compareModuleConfigOrder(a: ModuleConfigOrderEntry, b: ModuleConfigOrderEntry): number {
  const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0
  return a.sequence - b.sequence || compare(a.moduleId, b.moduleId) || compare(a.configId, b.configId)
}

/** 已启用模块的全部配置卡里，启用与总条数：状态栏的「X/Y 规则」直接用它。 */
export function countEnabledConfigs(entries: readonly ModuleConfigOrderEntry[]): { enabled: number; total: number } {
  return { enabled: entries.filter(entry => entry.enabled).length, total: entries.length }
}
