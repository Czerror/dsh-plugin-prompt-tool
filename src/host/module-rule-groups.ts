import { accessSync, constants, existsSync } from 'node:fs'
import { join } from 'node:path'
import { ModuleWriteError } from './module-write.ts'
import { loadModuleDefinition } from './module-slices.ts'
import { assertModuleId, assertNoModuleLinks } from './module-install.ts'

interface GroupRule { id?: string; group?: string; groupScope?: string; enabled?: boolean; exclusive?: boolean }

/** 先核参与者身份与路径，再允许任何定义读取。 */
export function assertCrossModuleParticipantPaths(moduleRoot: string, moduleIds: readonly string[]): void {
  for (const moduleId of moduleIds) {
    try { assertModuleId(moduleId) } catch (error) { throw new ModuleWriteError(String((error as Error).message ?? error), 403, 'module-readonly') }
    try {
      assertNoModuleLinks(join(moduleRoot, moduleId))
      assertNoModuleLinks(join(moduleRoot, moduleId, 'module.yml'))
    } catch {
      throw new ModuleWriteError(`跨模块互斥成员 ${moduleId} 路径非法`, 403, 'module-readonly')
    }
  }
}

/** 校验一组模块定义的跨模块互斥候选；调用方可用 overrides 做未写盘的目标投影。 */
export function assertCrossModuleGroups(
  moduleRoot: string,
  moduleIds: readonly string[],
  overrides: ReadonlyMap<string, readonly GroupRule[]> = new Map(),
): void {
  assertCrossModuleParticipantPaths(moduleRoot, moduleIds)
  const groups = new Map<string, GroupRule[]>()
  for (const moduleId of moduleIds) {
    const directory = join(moduleRoot, moduleId)
    if (!existsSync(join(directory, 'module.yml'))) continue
    let rules = overrides.get(moduleId)
    if (rules === undefined) {
      try { rules = loadModuleDefinition(directory).rules }
      catch { continue }
    }
    if (!(rules as GroupRule[]).some(rule => rule.groupScope === 'cross-module' && typeof rule.group === 'string' && rule.group.trim() !== '')) continue
    try {
      assertNoModuleLinks(directory)
      assertNoModuleLinks(join(directory, 'module.yml'))
      accessSync(directory, constants.W_OK)
      accessSync(join(directory, 'module.yml'), constants.W_OK)
    } catch {
      throw new ModuleWriteError(`跨模块互斥成员 ${moduleId} 不可写或路径非法`, 403, 'module-readonly')
    }
    for (const rule of rules as GroupRule[]) {
      if (rule.groupScope !== 'cross-module' || typeof rule.group !== 'string' || rule.group.trim() === '') continue
      const members = groups.get(rule.group) ?? []
      members.push(rule)
      groups.set(rule.group, members)
    }
  }
  for (const [name, members] of groups) {
    if (members.some(rule => rule.exclusive === true) && members.filter(rule => rule.enabled !== false).length > 1) {
      throw new ModuleWriteError(`跨模块互斥组 ${JSON.stringify(name)} 有多个启用规则，请显式选择后保存`, 409, 'rules-conflict')
    }
  }
}
