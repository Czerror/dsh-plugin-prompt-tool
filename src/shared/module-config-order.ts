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
  /** 官方文本层的定位档位；其他层不使用。 */
  order?: number
}

export interface ModuleConfigOrderSnapshot {
  revision: string
  entries: ModuleConfigOrderEntry[]
}

export const configIdentityKey = (entry: ModuleConfigIdentity): string => JSON.stringify([entry.moduleId, entry.configId])

/** 不以启用表次序打破同号平局；排序不改变配置卡身份。 */
export function compareModuleConfigOrder(a: ModuleConfigOrderEntry, b: ModuleConfigOrderEntry): number {
  const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0
  return a.sequence - b.sequence || compare(a.moduleId, b.moduleId) || compare(a.configId, b.configId)
}
