/** 部署总闸：唯一键 modulesEnabled，未声明时启用。 */
export function readModulesEnabled(value: { modulesEnabled?: unknown }): boolean {
  const { modulesEnabled } = value
  if (modulesEnabled !== undefined && typeof modulesEnabled !== 'boolean') throw new TypeError('modulesEnabled 必须是布尔值')
  return (modulesEnabled ?? true) as boolean
}

/** 一次官方 settings 事务完成改值。 */
export function modulesEnabledOps(enabled: boolean): [{ op: 'set'; path: string[]; value: boolean }] {
  return [{ op: 'set', path: ['modulesEnabled'], value: enabled }]
}
