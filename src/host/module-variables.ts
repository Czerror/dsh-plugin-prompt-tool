/** 两级持久变量：全局先锁、模块后锁，单域提交校验全部读取依赖。 */
import { lstatSync, mkdirSync, readFileSync } from 'node:fs'
import type { Stats } from 'node:fs'
import { basename, dirname } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { isMap, isScalar, parseDocument } from 'yaml'
import { DSH_HOME, GLOBAL_VARIABLES_FILE } from './paths.ts'
import { atomicWriteTextFile } from './text-file.ts'
import { assertUnownedUnchanged, assertVariableValues, commitModuleDefinition, ensureModuleSlices, lastPublishedModuleDefinition, loadModuleDefinition, ModuleRulesError, revisionOf, withModuleLock } from './module-storage.ts'
import type { ModuleDefinitionSnapshot } from './module-storage.ts'
import type { ModuleVariableRevisions, ModuleVariablesSnapshot } from '../shared/module-variables.ts'
export type { ModuleVariableRevisions, ModuleVariablesSnapshot } from '../shared/module-variables.ts'

export interface ModuleVariablesEdit {
  scope: 'global' | 'module'
  changes?: Record<string, string | null>
  values?: Record<string, string>
  enabled?: boolean
  expectedRevisions: Partial<ModuleVariableRevisions>
}
export interface ModuleVariablesResult extends ModuleVariablesSnapshot {
  persisted: true
  publicationPending?: boolean
  publicationError?: string
}
interface GlobalSnapshot {
  doc: ReturnType<typeof parseDocument>
  values: Record<string, string>
  revision: string | null
  mode?: number
}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const conflict = (): ModuleRulesError => new ModuleRulesError('模块或全局变量已变化，请重新读取', 409, 'module-variables-conflict')

function plain(path: string, directory = false): Stats | undefined {
  try {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) throw new ModuleRulesError(`变量路径不是普通${directory ? '目录' : '文件'}，拒绝链接：${path}`, 403, 'module-variables-path')
    return stat
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}
function readGlobal(): GlobalSnapshot {
  plain(DSH_HOME, true)
  plain(dirname(GLOBAL_VARIABLES_FILE), true)
  const stat = plain(GLOBAL_VARIABLES_FILE)
  if (!stat) return { doc: parseDocument('variables: {}\n'), values: {}, revision: null }
  if (stat.size > 8 * 1024 * 1024) throw new ModuleRulesError('全局变量文件超过 8 MiB')
  const bytes = readFileSync(GLOBAL_VARIABLES_FILE)
  const doc = parseDocument(new TextDecoder('utf-8', { fatal: true }).decode(bytes), { logLevel: 'silent' })
  if (doc.errors.length || !isMap(doc.contents)) throw new ModuleRulesError('全局变量 YAML 必须是有效对象')
  const source: unknown = doc.toJS()
  if (!record(source)) throw new ModuleRulesError('全局变量 YAML 必须是对象')
  const values = source.variables === undefined ? {} : source.variables
  assertVariableValues(values)
  return { doc, values, revision: revisionOf(bytes), mode: stat.mode }
}
function snapshot(module: ModuleDefinitionSnapshot, global: GlobalSnapshot): ModuleVariablesSnapshot {
  return { global: { ...global.values }, module: { ...module.variables }, effective: { ...global.values, ...module.variables },
    revisions: { global: global.revision, module: module.revisions.variables, settings: module.revisions.settings }, enabled: module.variablesEnabled }
}

export function readModuleVariables(directory: string, options: { writable?: boolean; runtime?: boolean } = {}): ModuleVariablesSnapshot {
  let module: ModuleDefinitionSnapshot
  try { module = ensureModuleSlices(directory, options) }
  catch (error) {
    const previous = options.runtime === true ? lastPublishedModuleDefinition(directory) : undefined
    if (previous === undefined) throw error
    module = previous
  }
  return snapshot(module, readGlobal())
}

function validateRequest(request: ModuleVariablesEdit): void {
  if (!record(request) || !['global', 'module'].includes(request.scope)
    || Object.keys(request).some(key => !['scope', 'changes', 'values', 'enabled', 'expectedRevisions'].includes(key))) throw new ModuleRulesError('变量请求 scope 或字段非法')
  if (request.changes !== undefined && request.values !== undefined
    || request.changes === undefined && request.values === undefined && request.enabled === undefined) throw new ModuleRulesError('变量请求必须声明 changes、values 或模块开关，changes 与 values 不能混用')
  if (request.enabled !== undefined && (request.scope !== 'module' || typeof request.enabled !== 'boolean')) throw new ModuleRulesError('enabled 只接受模块范围的布尔值')
  if (request.values !== undefined) assertVariableValues(request.values)
  else if (request.changes !== undefined) {
    if (!record(request.changes)) throw new ModuleRulesError('changes 必须是字符串或 null 的对象')
    assertVariableValues(Object.fromEntries(Object.entries(request.changes).map(([key, value]) => [key, value === null ? '' : value])))
  }
  const revisions = request.expectedRevisions
  if (!record(revisions) || (request.values !== undefined || request.changes !== undefined) && !Object.hasOwn(revisions, request.scope)
    || request.enabled !== undefined && !Object.hasOwn(revisions, 'settings')
    || Object.entries(revisions).some(([key, value]) => !['global', 'module', 'settings'].includes(key)
      || !(key === 'global' && value === null) && !(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)))) throw new ModuleRulesError('写变量必须提供有效的目标版本及读取依赖版本')
}
function checkRevisions(request: ModuleVariablesEdit, module: ModuleDefinitionSnapshot, global: GlobalSnapshot): void {
  if (Object.hasOwn(request.expectedRevisions, 'global') && request.expectedRevisions.global !== global.revision
    || Object.hasOwn(request.expectedRevisions, 'module') && request.expectedRevisions.module !== module.revisions.variables
    || Object.hasOwn(request.expectedRevisions, 'settings') && request.expectedRevisions.settings !== module.revisions.settings) throw conflict()
}
function changedValues(previous: Record<string, string>, request: ModuleVariablesEdit): Record<string, string> {
  const values = { ...(request.values ?? previous) }
  for (const [key, value] of Object.entries(request.changes ?? {})) {
    if (value === null) delete values[key]
    else values[key] = value
  }
  assertVariableValues(values)
  return values
}
function replaceVariables(doc: ReturnType<typeof parseDocument>, values: Record<string, string>): void {
  const before = doc.toJS()
  const node = doc.get('variables', true)
  if (isMap(node)) {
    for (const key of node.items.map(pair => String(pair.key))) if (!Object.hasOwn(values, key)) node.delete(key)
    for (const [key, value] of Object.entries(values)) {
      const scalar = node.get(key, true)
      if (isScalar(scalar)) scalar.value = value
      else node.set(key, value)
    }
  } else doc.set('variables', values)
  assertUnownedUnchanged(before, doc, ['variables'], '变量 YAML 引用会改变其他字段，拒绝写入')
}

export function editModuleVariables(directory: string, request: ModuleVariablesEdit): ModuleVariablesResult {
  validateRequest(request)
  const initial = loadModuleDefinition(directory)
  readGlobal()
  mkdirSync(dirname(GLOBAL_VARIABLES_FILE), { recursive: true })
  plain(dirname(GLOBAL_VARIABLES_FILE), true)
  return withModuleLock(dirname(GLOBAL_VARIABLES_FILE), 'variables', () => {
    if (request.scope === 'module') {
      const module = loadModuleDefinition(initial.dir), global = readGlobal()
      checkRevisions(request, module, global)
      const values = changedValues(module.variables, request)
      const enabled = request.enabled ?? module.variablesEnabled
      if (isDeepStrictEqual(values, module.variables) && enabled === module.variablesEnabled) return { ...snapshot(module, global), persisted: true }
      if (!isDeepStrictEqual(values, module.variables)) replaceVariables(module.doc, values)
      if (request.enabled !== undefined) {
        if (enabled) module.doc.delete('variablesEnabled')
        else module.doc.set('variablesEnabled', false)
      }
      try { return { ...snapshot(commitModuleDefinition(module, module.doc), global), persisted: true } }
      catch (error) {
        if (!(error instanceof ModuleRulesError) || !error.persisted || !error.revisions) throw error
        return { ...snapshot({ ...module, variables: values, variablesEnabled: enabled, revisions: error.revisions }, global), persisted: true, publicationPending: true, publicationError: error.message }
      }
    }
    return withModuleLock(dirname(initial.dir), basename(initial.dir), () => {
      const module = loadModuleDefinition(initial.dir), global = readGlobal()
      checkRevisions(request, module, global)
      const values = changedValues(global.values, request)
      if (isDeepStrictEqual(values, global.values)) return { ...snapshot(module, global), persisted: true }
      replaceVariables(global.doc, values)
      const text = global.doc.toString()
      if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw new ModuleRulesError('全局变量文件超过 8 MiB')
      atomicWriteTextFile(GLOBAL_VARIABLES_FILE, text, { mode: global.mode, beforeReplace: () => {
        const current = readGlobal()
        if (current.revision !== global.revision) throw conflict()
        checkRevisions(request, loadModuleDefinition(module.dir), current)
      } })
      return { ...snapshot(module, { ...global, values, revision: revisionOf(text) }), persisted: true }
    })
  })
}
