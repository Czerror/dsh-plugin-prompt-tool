/**
 * 存储根配置：模块启用表与独立主/子人设来源；正文仍归各模块。
 *
 * `<存储根>/config.yml` 保存 schemaVersion、enabled 和 personaSources。
 * enabled 决定普通模块配装，personaSources 单独选择主/子人设来源，不互相启用。
 *
 * 这里**没有**版本指针、配装段、参数副本与归属表：参数、提示词与素材都在各模块自己的
 * 目录里（`modules/<id>/`）。写模块卡与写参数都不是启用，它们不创建这个文件。
 *
 * 写盘走 yaml Document API（保留注释与未知字段）＋原子替换，与仓库其余写盘同规。
 */
import { lstatSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { isMap, isSeq, parseDocument } from 'yaml'
import { atomicWriteTextFile } from './text-file.ts'
import { moduleDirExists } from './manifest.ts'
import { assertModuleId, assertNoModuleLinks, modulePathExists } from './module-install.ts'
import { ModuleRulesError, revisionOf, withModuleLock } from './module-storage.ts'

/** 启用表 schema：3 起 enabled 才拥有普通模块启用语义。 */
export const ENABLE_TABLE_SCHEMA = 3
/** 存储根配置文件名。 */
export const STORAGE_CONFIG_FILE = 'config.yml'

/**
 * 启用表文件位置。
 *
 * 以**模块根**为入口、上溯一级取存储根：模块级常量在 import 时按 `DSH_HOME` 冻结，
 * 而测试会在动态 import 之后才设 `DSH_HOME`，所以这里必须按传入的根现算
 * （与 `charactersDir(moduleRoot)` 同一条约定）。
 */
export function enableTablePath(moduleRoot: string): string {
  return join(dirname(moduleRoot), STORAGE_CONFIG_FILE)
}

export interface StorageConfigSnapshot {
  doc: ReturnType<typeof parseDocument>
  source: Record<string, unknown>
  text: string | null
  revision: string | null
  mode?: number
}

/** 人设选择等新 owner 必须看到读取失败，不能用空配置覆盖损坏文件。 */
export function readStorageConfig(moduleRoot: string): StorageConfigSnapshot {
  const file = enableTablePath(moduleRoot)
  assertNoModuleLinks(moduleRoot)
  assertNoModuleLinks(file)
  if (!modulePathExists(file)) {
    const doc = parseDocument(`schemaVersion: ${ENABLE_TABLE_SCHEMA}\nenabled: []\n`)
    return { doc, source: doc.toJS() as Record<string, unknown>, text: null, revision: null }
  }
  const stat = lstatSync(file)
  if (!stat.isFile()) throw new ModuleRulesError('存储配置必须是普通文件', 403, 'storage-config-path')
  if (stat.size > 1024 * 1024) throw new ModuleRulesError('存储配置超过 1 MiB')
  const bytes = readFileSync(file), text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  const doc = parseDocument(text, { logLevel: 'silent' })
  if (doc.errors.length > 0 || !isMap(doc.contents)) throw new ModuleRulesError('存储配置 YAML 必须是有效对象')
  return { doc, source: doc.toJS() as Record<string, unknown>, text, revision: revisionOf(bytes), mode: stat.mode }
}

/** 启用表与人设选择共用跨进程锁；回调声明完整候选以拒绝共享别名连带修改。 */
export function updateStorageConfig(moduleRoot: string, expectedRevision: string | null | undefined,
  update: (doc: ReturnType<typeof parseDocument>, source: Record<string, unknown>) => Record<string, unknown>,
): StorageConfigSnapshot {
  const file = enableTablePath(moduleRoot), storageRoot = dirname(file)
  readStorageConfig(moduleRoot)
  mkdirSync(storageRoot, { recursive: true })
  return withModuleLock(storageRoot, 'config', () => {
    const current = readStorageConfig(moduleRoot)
    if (expectedRevision !== undefined && expectedRevision !== current.revision) throw new ModuleRulesError('存储配置已变化，请重新读取', 409, 'storage-config-conflict')
    const expected = update(current.doc, current.source)
    let text: string
    try {
      text = current.doc.toString()
      if (!isDeepStrictEqual(current.doc.toJS(), expected)) throw new Error('shared alias changed')
    } catch { throw new ModuleRulesError('YAML 共享引用会改变其他配置；请先解除相关引用') }
    if (text === current.text || isDeepStrictEqual(expected, current.source)) return current
    if (Buffer.byteLength(text) > 1024 * 1024) throw new ModuleRulesError('存储配置超过 1 MiB')
    atomicWriteTextFile(file, text, { mode: current.mode, beforeReplace: () => {
      if (readStorageConfig(moduleRoot).revision !== current.revision) throw new ModuleRulesError('存储配置已变化，请重新读取', 409, 'storage-config-conflict')
    } })
    return { ...current, source: expected, text, revision: revisionOf(text) }
  })
}

/**
 * 读启用表：返回启用的模块 id（按声明顺序，重复项去掉）。
 *
 * 文件缺失、解析失败、schemaVersion 低于 3、`enabled` 不是字符串数组——一律返回空表。
 * 空表意味着「没有模块参与装配」，这是明确状态，不是错误：旧版本的索引文件里
 * `enabled` 还没有启用语义，当成启用会让历史键意外参与装配。
 */
export function enabledModuleIds(moduleRoot: string): string[] {
  let doc: ReturnType<typeof parseDocument>
  try { doc = readStorageConfig(moduleRoot).doc } catch { return [] }
  if (Number(doc.get('schemaVersion')) < ENABLE_TABLE_SCHEMA) return []
  const list: unknown = doc.toJS()?.enabled
  if (!Array.isArray(list)) return []
  return [...new Set(list.filter((id): id is string => typeof id === 'string' && id.trim().length > 0).map((id) => id.trim()))]
}

/**
 * 解析**编辑目标**模块目录：只按请求声明定位，没有声明就没有目标。
 *
 * 这是「按请求定位编辑目标」的唯一入口——编辑器不必依赖某个全局单选：写请求带上
 * 模块 id 就写那个模块。目标目录不存在或 `<root>/<id>/module.yml` 缺失时返回空串，
 * 由调用方按「无目标」拒绝，不静默改写到别的模块（尤其是启用表首项）。
 */
export function resolveEditDir(moduleRoot: string, moduleId: string): string {
  const target = moduleId.trim()
  if (target.length === 0) return ''
  return moduleDirExists(moduleRoot, target) ? join(moduleRoot, target) : ''
}

/** 请求主语（`x-module-id` 解析结果）→ 模块目录；未声明主语即无目标，不选默认模块。 */
export function resolveRequestedModuleDir(modulesDir: string, subject: string | undefined): string {
  return subject === undefined ? '' : resolveEditDir(modulesDir, subject)
}

/**
 * 启用或停用一个模块。幂等：已在表里再启用不产生第二条，不在表里再停用不报错。
 * 顺序即装配顺序，新模块追加在末尾（同键参数的覆盖顺序因此可预测）。
 */
export function setModuleEnabled(moduleRoot: string, id: string, enabled: boolean): void {
  assertModuleId(id)
  if (typeof enabled !== 'boolean') throw new TypeError('enabled 必须是布尔值')
  updateStorageConfig(moduleRoot, undefined, (doc, source) => {
    const current = enabledModuleIds(moduleRoot)
    const next = enabled ? current.includes(id) ? current : [...current, id] : current.filter(existing => existing !== id)
    if (isDeepStrictEqual(current, next)) return source
    doc.set('schemaVersion', ENABLE_TABLE_SCHEMA)
    const list = doc.get('enabled', true)
    if (isSeq(list)) list.items = next.map(value => list.items.find(item => String(item) === value) ?? doc.createNode(value))
    else doc.set('enabled', next)
    return { ...source, schemaVersion: ENABLE_TABLE_SCHEMA, enabled: next }
  })
}
