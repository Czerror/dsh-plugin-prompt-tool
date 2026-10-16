/**
 * 存储根配置：模块启用表、独立主/子人设来源与**全局层引擎参数**。
 *
 * `<存储根>/config.yml` 保存 schemaVersion、enabled、personaSources 与 layerSettings。
 * enabled 决定普通模块配装，personaSources 单独选择主/子人设来源，不互相启用；
 * `layerSettings` 是**全局层**引擎参数（用户裁定 2026-10-12：「模块未声明 ⇒ 回退为全局」），
 * 与 `module.yml` 的 `layerSettings` 同形同校验。
 *
 * 全局层与模块层只有一条关系：**存在即覆盖**——模块对该参数有显式取值（`false` 也算）就用
 * 模块的，没有这个键才回退全局。判据与合并都收在 `manifest.ts#resolveModuleParams` 一处，
 * 读写端点与客户端都不重复判优先级。固定卡（指令卡）是全局段，它的参数设置区写这里；
 * 模块自己的覆盖仍旧写各自 module.yml。
 *
 * 写盘走 yaml Document API（保留注释与未知字段）＋原子替换，与仓库其余写盘同规。
 */
import { lstatSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { isMap, isSeq, parseDocument } from 'yaml'
import { atomicWriteTextFile } from './text-file.ts'
import { moduleDirExists } from './module-dirs.ts'
import { assertModuleId, assertNoModuleLinks, modulePathExists } from './module-install.ts'
import { ModuleWriteError, deleteYamlPath, revisionOf, serializeWithoutSharedAlias, withModuleLock } from './module-write.ts'
import { engineParamPath, readLayerSettings } from './module-layer-settings.ts'
import { isModuleId } from '../shared/module-ids.ts'

/** 启用表 schema：3 起 enabled 才拥有普通模块启用语义。 */
export const ENABLE_TABLE_SCHEMA = 3
/** 存储根配置文件名。 */
export const STORAGE_CONFIG_FILE = 'config.yml'

/**
 * 启用表文件位置。
 *
 * 以**模块根**为入口、上溯一级取存储根：调用方手里已经有根时按它现算，不去读环境
 * （与 `charactersDir(moduleRoot)` 同一条约定；paths.ts 自 2026-10-16 起也按调用求值）。
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
  if (!stat.isFile()) throw new ModuleWriteError('存储配置必须是普通文件', 403, 'storage-config-path')
  if (stat.size > 1024 * 1024) throw new ModuleWriteError('存储配置超过 1 MiB')
  const bytes = readFileSync(file), text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  const doc = parseDocument(text, { logLevel: 'silent' })
  if (doc.errors.length > 0 || !isMap(doc.contents)) throw new ModuleWriteError('存储配置 YAML 必须是有效对象')
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
    if (expectedRevision !== undefined && expectedRevision !== current.revision) throw new ModuleWriteError('存储配置已变化，请重新读取', 409, 'storage-config-conflict')
    const expected = update(current.doc, current.source)
    const text = serializeWithoutSharedAlias(current.doc, expected, 'YAML 共享引用会改变其他配置；请先解除相关引用')
    if (text === current.text || isDeepStrictEqual(expected, current.source)) return current
    if (Buffer.byteLength(text) > 1024 * 1024) throw new ModuleWriteError('存储配置超过 1 MiB')
    atomicWriteTextFile(file, text, { mode: current.mode, beforeReplace: () => {
      if (readStorageConfig(moduleRoot).revision !== current.revision) throw new ModuleWriteError('存储配置已变化，请重新读取', 409, 'storage-config-conflict')
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
 * 模块 id 就写那个模块。id 形状非法（`../x`、`..`、含大写或斜杠）或目标目录不存在、
 * `<root>/<id>/module.yml` 缺失时返回空串，由调用方按「无目标」拒绝，不静默改写到
 * 别的模块（尤其是启用表首项）。形状判据必须先于存在性：`join` 不拦 `..`，只查
 * 「文件在不在」会让存储根之外的同级模块被当成本插件管理的模块读写。
 */
export function resolveEditDir(moduleRoot: string, moduleId: string): string {
  const target = moduleId.trim()
  if (!isModuleId(target)) return ''
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

/**
 * 全局层引擎参数：`config.yml` 顶层 `layerSettings` 展平后的参数子集。
 *
 * 与 `module.yml` 同形同校验（`readLayerSettings`），未知插入点/错位键响亮失败——
 * 调用方（读端点、模块参数解析）不得把损坏的全局层当空值吞掉。
 */
export function readGlobalLayerSettings(moduleRoot: string): Record<string, unknown> {
  return readLayerSettings(readStorageConfig(moduleRoot).source.layerSettings)
}

/**
 * 全局层的**软失败**读：解析失败不抛，返回空参数 + 一条诊断。
 *
 * 全局层挂在**每次 `loadModuleSpec`**（装配）与 `/bootstrap`（首屏）上，而它的形状校验是
 * 响亮的（未知插入点/错位键即抛）——用户手写 `config.yml` 一个层名笔误就会同时打掉整个
 * 工作台与全部模块装配，爆炸半径远大于单个 `module.yml`。因此这两条读路径按「没有全局层」
 * 继续，诊断由 `/meta` 与 `/bootstrap` 的 `meta.moduleWarnings` 下发（模块页可见）。
 * **写路径不软**：目标文件坏掉时拒绝写入（响亮 400），不覆盖用户内容。
 */
export function readGlobalLayerSettingsSafe(moduleRoot: string): { params: Record<string, unknown>; error?: string } {
  try {
    return { params: readGlobalLayerSettings(moduleRoot) }
  } catch (error) {
    return { params: {}, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 写全局层引擎参数（固定卡指令卡的设置区）。
 *
 * 只动 `layerSettings.<层>.<参数键>`，其余内容（注释、未知字段、enabled、personaSources）
 * 原样保留；空值（`''` / `[]`）删除键，`false` 与 `0` 是显式值照常写入。
 *
 * 删键要连**空的父层**一起回收：`deleteIn` 不会清掉 `pre-step: {}`，而 `expected` 是按
 * 「这个键没了」算的，留下空壳会让 `updateStorageConfig` 的 shared-alias 守卫（`doc.toJS()`
 * 与 `expected` 深比）不成立、写盘被 400 拒绝；层键本来就缺失时 `deleteIn` 还会直接抛。
 * 所以每次删键都走 `hasIn` 守卫 + 空层回收。
 */
export function writeGlobalLayerSettings(moduleRoot: string, params: Record<string, unknown>): void {
  updateStorageConfig(moduleRoot, undefined, (doc, source) => {
    const expected: Record<string, unknown> = { ...source }
    // 先核现有全局层的形状（未知层/错位键响亮失败），与 saveModuleParams 对 module.yml 同规。
    readLayerSettings(source.layerSettings)
    const next = { ...(source.layerSettings === null || typeof source.layerSettings !== 'object' || Array.isArray(source.layerSettings)
      ? {} : source.layerSettings as Record<string, Record<string, unknown>>) }
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue
      const [section, layer, paramKey] = engineParamPath(key)
      const empty = value === '' || (Array.isArray(value) && value.length === 0)
      const entries = { ...next[layer] }
      if (empty) {
        deleteYamlPath(doc, [section, layer, paramKey])
        delete entries[paramKey]
        // 该层没内容了就连层键一起删：留着 `pre-step: {}` 会与 expected 不一致。
        if (Object.keys(entries).length === 0) {
          deleteYamlPath(doc, [section, layer])
          delete next[layer]
        } else next[layer] = entries
      } else {
        doc.setIn([section, layer, paramKey], value)
        next[layer] = { ...entries, [paramKey]: value }
      }
    }
    if (Object.keys(next).length === 0) {
      deleteYamlPath(doc, ['layerSettings'])
      delete expected.layerSettings
    } else expected.layerSettings = next
    return expected
  })
}
