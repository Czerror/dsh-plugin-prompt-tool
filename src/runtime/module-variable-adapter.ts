import { readModuleVariables, editModuleVariables } from '../host/module-variables.ts'
import type { ModuleVariablesEdit } from '../host/module-variables.ts'
import { assertModuleDirectory, assertModuleId } from '../host/module-install.ts'
import { join } from 'node:path'
import { ensureModuleSlices } from '../host/module-slices.ts'

/** 引擎只收受控来源身份；读取新快照和发布切片均不重挂 Agent。 */
export function createModuleVariableAdapter(moduleRoot: string) {
  const directory = (id: string) => assertModuleDirectory(moduleRoot, id)
  return {
    read: (id: string) => { assertModuleId(id); return readModuleVariables(join(moduleRoot, id), { runtime: true }); },
    commit: (id: string, request: ModuleVariablesEdit) => editModuleVariables(directory(id), request),
    publish: (id: string) => { ensureModuleSlices(directory(id)); },
  }
}
