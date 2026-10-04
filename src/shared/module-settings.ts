/** 部署总闸的新旧字段只在读写边界归一。 */
export function readModulesEnabled(value: { modulesEnabled?: unknown; writePreset?: unknown }): boolean {
  const { modulesEnabled, writePreset } = value
  if (modulesEnabled !== undefined && typeof modulesEnabled !== 'boolean') throw new TypeError('modulesEnabled 必须是布尔值')
  if (writePreset !== undefined && typeof writePreset !== 'boolean') throw new TypeError('旧 writePreset 必须是布尔值')
  if (modulesEnabled !== undefined && writePreset !== undefined && modulesEnabled !== writePreset) throw new Error('modulesEnabled 与旧 writePreset 冲突')
  return (modulesEnabled ?? writePreset ?? true) as boolean
}

/** 一次官方 settings 事务完成改值与旧键退役，不产生新旧冲突中间态。 */
export function modulesEnabledOps(enabled: boolean): [{ op: 'set'; path: string[]; value: boolean }, { op: 'unset'; path: string[] }] {
  return [{ op: 'set', path: ['modulesEnabled'], value: enabled }, { op: 'unset', path: ['writePreset'] }]
}
