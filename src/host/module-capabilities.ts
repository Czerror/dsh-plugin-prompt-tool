/**
 * 引擎能力在模块定义上的创建与删除：模块声明、能力数据段、该能力的显式参数与行配置
 * 一起增删（`createModuleCapability` / `removeModuleCapability`）。从原 `manifest.ts` 按簇拆出；
 * 每次提交都过共享引用守卫，能力登记表是唯一事实源。
 */
import { existsSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Scalar, YAMLSeq, parseDocument } from 'yaml'
import { engineRecipe, isModuleCapabilityPresent, moduleCapability } from '../shared/engine-capabilities.ts'
import { isModuleId } from '../shared/module-ids.ts'
import { ENGINE_PARAM_DEFINITIONS, ENGINE_PARAM_KEYS } from '../shared/engine-params.ts'
import { MODULE_DEFINITION_FILE } from './paths.ts'
import { engineParamPath, readModuleLayerSettings } from './module-layer-settings.ts'
import { commitModuleDefinition, loadModuleDefinition } from './module-slices.ts'
import { assertUnownedUnchanged, withModuleLock } from './module-write.ts'
import { assertCompositionArray } from './module-composition.ts'
import { assertModuleDirectory, assertModuleTree } from './module-install.ts'
import { readStorageConfig } from './config-store.ts'
import { userModulesDir } from './module-dirs.ts'
import { renderComposition, resolveModuleFacts } from './module-params.ts'
import { invalidateModuleSpec } from './module-spec.ts'
import type { ModuleSpec } from './module-spec.ts'

/**
 * 从模块 module.yml 的 modules 清单移除一个模块 id（YAML Document 保留注释
 * 与其余字段）。返回是否发生修改；文件缺失或没有该模块时返回 false。
 */
export function removeModuleCapabilityDeclaration(dir: string, moduleId: string): boolean {
  const file = join(dir, MODULE_DEFINITION_FILE)
  if (!existsSync(file)) return false
  const snapshot = loadModuleDefinition(dir)
  const doc = snapshot.doc
  readModuleLayerSettings(doc.toJS())
  const modules = doc.getIn(['modules'])
  if (!(modules instanceof YAMLSeq)) return false
  const kept = modules.items.filter((item) => !(item instanceof Scalar) || item.value !== moduleId)
  if (kept.length === modules.items.length) return false
  modules.items = kept
  commitModuleDefinition(snapshot, doc)
  invalidateModuleSpec(dir)
  return true
}
/** 向 module.yml 的 modules 追加功能模块；空数组保持按需装配语义。 */
export function appendModuleCapabilities(
  doc: ReturnType<typeof parseDocument>,
  additions: readonly string[],
): void {
  if (additions.length === 0) return
  const source = doc.toJS() as { modules?: unknown }
  if (!Array.isArray(source.modules)) throw new Error('当前预设缺少 modules 数组，不能自动装配工具模块')
  const current = source.modules.filter((item): item is string => typeof item === 'string' && item.length > 0)
  const modules = [...current]
  for (const module of additions) {
    if (!isModuleId(module)) throw new Error('非法模块名：' + module)
    if (!modules.includes(module)) modules.push(module)
  }
  doc.set('modules', modules)
}

/** 删除具有合法身份的模块目录（模块根/<id>）；隐藏备份不经公共接口删除。
 *  仅作用于插件自有模块根，包内置模板不受影响；路径越界与非法 id 拒绝。
 *  模块不在宿主预设注册表里，删除后无需撤销官方登记；调用方按需重建当前模块。 */
export function removeUserModule(id: string, moduleRoot = userModulesDir()): { ok: true } | { ok: false; message: string } {
  try {
    // 来源选择与删除共用配置锁，避免校验后又被选中而留下悬空引用。
    withModuleLock(dirname(moduleRoot), 'config', () => withModuleLock(moduleRoot, id, () => {
      const sources = readStorageConfig(moduleRoot).source.personaSources
      if (sources !== null && typeof sources === 'object' && Object.values(sources).includes(id)) {
        throw new Error(`模块「${id}」正在作为人设来源，请先切换对应受众的人设`)
      }
      const target = assertModuleDirectory(moduleRoot, id)
      assertModuleTree(target)
      rmSync(target, { recursive: true, force: true })
      invalidateModuleSpec(target)
    }))
    return { ok: true }
  } catch (error) {
    return { ok: false, message: `删除失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

export type ModuleCapabilityCreateRequest =
  | { action: 'create'; capabilityId: string }
  | { action: 'create-recipe'; recipeId: string }

export interface ModuleCapabilityCreateResult {
  changed: boolean
  addedModules: string[]
  capabilityIds: string[]
}

export interface ModuleCapabilityRemoveResult {
  changed: boolean
  removedModules: string[]
  capabilityIds: string[]
}

/** 在内存候选文档中展开能力/recipe，校验成功后一次原子替换 module.yml。 */
/** 能力拥有的顶层数据段键（能力登记表的 `ownSection`）：守卫的 owns 从这里推，不硬编码。 */
function sectionKeysOf(capabilityIds: readonly string[]): string[] {
  const keys = new Set<string>()
  for (const id of capabilityIds) {
    const key = moduleCapability(id)?.ownSection?.key
    if (key !== undefined) keys.add(key)
  }
  return [...keys]
}
export function createModuleCapability(
  moduleDir: string,
  request: ModuleCapabilityCreateRequest,
): ModuleCapabilityCreateResult {
  const file = join(moduleDir, MODULE_DEFINITION_FILE)
  if (!existsSync(file)) throw new Error(`模块目录缺少 module.yml：${moduleDir}`)
  const snapshot = loadModuleDefinition(moduleDir)
  const doc = snapshot.doc
  const source = doc.toJS() as ModuleSpec
  const sourceParams = readModuleLayerSettings(source)
  if (!Array.isArray(source.modules)) throw new Error('当前预设没有可编辑的 modules 数组；请先复制为插件用户预设')
  const capabilityIds = request.action === 'create'
    ? [request.capabilityId]
    : (engineRecipe(request.recipeId)?.capabilities ? [...engineRecipe(request.recipeId)!.capabilities] : [])
  if (capabilityIds.length === 0 || capabilityIds.some((id) => moduleCapability(id) === undefined)) {
    throw new Error(`未知引擎能力或 recipe：${request.action === 'create' ? request.capabilityId : request.recipeId}`)
  }
  const currentFacts = resolveModuleFacts(source, moduleDir, true)
  // 创建检查磁盘声明，而不是实际装配：历史策略虽然已经运行，仍需允许补齐 modules。
  const declaredFacts = { ...currentFacts, effectiveModules: currentFacts.declaredModules }
  const additions = capabilityIds
    .filter((id) => !isModuleCapabilityPresent(id, declaredFacts))
    .flatMap((id) => moduleCapability(id)?.moduleKeys.slice(0, 1) ?? [])
  const modules = source.modules.filter((item): item is string => typeof item === 'string' && item.length > 0)
  const addedModules: string[] = []
  for (const module of additions) {
    if (!modules.includes(module)) {
      modules.push(module)
      addedModules.push(module)
    }
  }
  doc.set('modules', modules)
  const recipe = request.action === 'create-recipe' ? engineRecipe(request.recipeId) : undefined
  for (const [key, value] of Object.entries(recipe?.initialParams ?? {})) {
    if (!Object.prototype.hasOwnProperty.call(sourceParams, key)) doc.setIn(engineParamPath(key), value)
  }
  // 拥有顶层数据段的能力（`ownSection`）：启用即写入可用骨架，保证"模块在 ⇒ 数据在"。
  let sectionWritten = false
  for (const id of capabilityIds) {
    const section = moduleCapability(id)?.ownSection
    if (section === undefined) continue
    const existing = (source as unknown as Record<string, unknown>)[section.key]
    if (existing !== undefined && existing !== null) continue
    doc.setIn([section.key], JSON.parse(JSON.stringify(section.skeleton)))
    sectionWritten = true
  }
  const candidate = doc.toJS() as ModuleSpec
  const rendered = renderComposition(candidate, {}, moduleDir)
  const rows = assertCompositionArray(rendered, candidate)
  const rowPaths = new Map<string, string>()
  const visit = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[${index}]`))
      return
    }
    if (value === null || typeof value !== 'object') return
    const record = value as Record<string, unknown>
    if (typeof record.id === 'string' && record.id.length > 0) {
      const firstPath = rowPaths.get(record.id)
      if (firstPath !== undefined) {
        throw new Error(`预设 ${candidate.id} 的组合包含重复 row id ${JSON.stringify(record.id)}（${firstPath} 与 ${path}）`)
      }
      rowPaths.set(record.id, path)
    }
    for (const [key, child] of Object.entries(record)) visit(child, `${path}.${key}`)
  }
  visit(rows, 'rows')
  for (const id of capabilityIds) {
    const capability = moduleCapability(id)!
    if (!capability.rowIds.some((rowId) => rowPaths.has(rowId))) throw new Error(`能力 ${id} 的组合缺少预期 row`)
  }
  if (addedModules.length === 0 && recipe === undefined && !sectionWritten) return { changed: false, addedModules, capabilityIds }
  if (addedModules.length === 0 && recipe !== undefined && Object.entries(recipe.initialParams ?? {}).every(([key]) => Object.prototype.hasOwnProperty.call(sourceParams, key))) {
    return { changed: false, addedModules, capabilityIds }
  }
  // 直调提交的路径同样过守卫：section 键取自能力登记表，不硬编码。
  assertUnownedUnchanged(source, doc, ['modules', 'layerSettings', ...sectionKeysOf(capabilityIds)], 'YAML 共享引用会改变其他定义；请先解除相关引用后再编辑')
  commitModuleDefinition(snapshot, doc)
  invalidateModuleSpec(moduleDir)
  return { changed: true, addedModules, capabilityIds }
}

/** 删除能力：模块声明、顶层数据段，以及该能力的**显式参数与行配置**一起移除。
 *  参数在 ⇒ 装配在（见 impliedModulesFromParams）：留下参数会让移除立刻被隐含装配拉回来，
 *  所以"移除能力"必须是完整移除。未登记参数、其他能力的数据与未知字段一律不动。 */
export function removeModuleCapability(
  moduleDir: string,
  capabilityId: string,
): ModuleCapabilityRemoveResult {
  const file = join(moduleDir, MODULE_DEFINITION_FILE)
  if (!existsSync(file)) throw new Error(`模块目录缺少 module.yml：${moduleDir}`)
  const snapshot = loadModuleDefinition(moduleDir)
  const doc = snapshot.doc
  const source = doc.toJS() as unknown as ModuleSpec & Record<string, unknown>
  const params = readModuleLayerSettings(source)
  if (!Array.isArray(source.modules)) throw new Error('当前预设没有可编辑的 modules 数组；官方组合不支持删除插件能力')
  const capability = moduleCapability(capabilityId)
  if (capability === undefined) throw new Error(`未知引擎能力：${capabilityId}`)
  const modules = source.modules.filter((item): item is string => typeof item === 'string' && item.length > 0)
  const removedModules = modules.filter((module) => capability.moduleKeys.includes(module))
  const section = capability.ownSection
  const sectionPresent = section !== undefined && source[section.key] !== undefined && source[section.key] !== null
  // 该能力的显式参数键与行配置：与模块声明同生共死。
  const paramKeys = ENGINE_PARAM_KEYS.filter((key) => ENGINE_PARAM_DEFINITIONS[key].card === capabilityId
    && Object.prototype.hasOwnProperty.call(params, key))
  const configs = (source.moduleConfigs ?? {}) as Record<string, unknown>
  const configRows = [...new Set([...capability.rowIds, ...capability.moduleKeys])]
    .filter((rowId) => Object.prototype.hasOwnProperty.call(configs, rowId))
  if (removedModules.length === 0 && !sectionPresent && paramKeys.length === 0 && configRows.length === 0) {
    return { changed: false, removedModules, capabilityIds: [capabilityId] }
  }
  if (removedModules.length > 0) doc.set('modules', modules.filter((module) => !capability.moduleKeys.includes(module)))
  if (sectionPresent) doc.deleteIn([section!.key])
  for (const key of paramKeys) doc.deleteIn(engineParamPath(key))
  for (const rowId of configRows) doc.deleteIn(['moduleConfigs', rowId])
  const candidate = doc.toJS() as ModuleSpec
  assertCompositionArray(renderComposition(candidate, {}, moduleDir), candidate)
  // 与创建同一条守卫：删能力拥有 modules、能力自己的数据段、参数与行配置。
  assertUnownedUnchanged(source, doc, ['modules', 'layerSettings', 'moduleConfigs', ...(section === undefined ? [] : [section.key])], 'YAML 共享引用会改变其他定义；请先解除相关引用后再编辑')
  commitModuleDefinition(snapshot, doc)
  invalidateModuleSpec(moduleDir)
  return { changed: true, removedModules, capabilityIds: [capabilityId] }
}