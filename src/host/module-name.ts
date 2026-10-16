import { assertModuleId } from './module-install.ts'
import { commitModuleDefinition, loadModuleDefinition } from './module-slices.ts'

const MAX_MODULE_NAME_LENGTH = 128

export class ModuleNameError extends Error {
  readonly status: number
  readonly code: string
  constructor(message: string, status = 400, code = 'module-name-rejected') {
    super(message)
    this.status = status
    this.code = code
  }
}

function validateName(value: unknown): string {
  if (typeof value !== 'string') throw new ModuleNameError('名称必须是字符串')
  const name = value.trim()
  if (name.length === 0 || name.length > MAX_MODULE_NAME_LENGTH) throw new ModuleNameError(`名称长度必须为 1-${MAX_MODULE_NAME_LENGTH} 个字符`)
  return name
}

export function readModuleName(directory: string): { name: string; revision: string } {
  const snapshot = loadModuleDefinition(directory)
  const name = snapshot.source.name
  return { name: typeof name === 'string' && name.trim().length > 0 ? name : '', revision: snapshot.revision }
}

export function writeModuleName(directory: string, request: { name: unknown; expectedRevision: unknown; expectedModuleId: unknown }): { name: string; revision: string } {
  const name = validateName(request.name)
  if (typeof request.expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(request.expectedRevision)) throw new ModuleNameError('expectedRevision 无效')
  if (typeof request.expectedModuleId !== 'string') throw new ModuleNameError('expectedModuleId 必须是字符串')
  assertModuleId(request.expectedModuleId)
  const current = loadModuleDefinition(directory)
  if (current.revision !== request.expectedRevision) throw new ModuleNameError('模块定义已变化，请重新读取', 409, 'module-name-conflict')
  if (current.source.id !== request.expectedModuleId) throw new ModuleNameError('模块身份不一致', 400, 'module-subject-conflict')
  current.doc.set('name', name)
  const saved = commitModuleDefinition(current, current.doc)
  return { name, revision: saved.revision }
}
