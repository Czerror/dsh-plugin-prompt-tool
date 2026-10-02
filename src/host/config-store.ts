/**
 * 存储根的配置：**模块启用表**。
 *
 * `<存储根>/config.yml` 只回答一件事——哪些模块参与运行时装配，格式是
 * `schemaVersion: 3` + `enabled: [<id>, …]`。启用即配装：装了 A+B，再加 C 就是 A+B+C，
 * 每个模块各自贡献自己的定义与参数，互不合并、互不改写。
 *
 * 这里**没有**版本指针、配装段、参数副本与归属表：参数、提示词与素材都在各模块自己的
 * 目录里（`modules/<id>/`）。写模块卡与写参数都不是启用，它们不创建这个文件。
 *
 * 写盘走 yaml Document API（保留注释与未知字段）＋原子替换，与仓库其余写盘同规。
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isMap, parseDocument } from 'yaml'
import { atomicWriteTextFile } from './text-file.ts'
import { moduleDirExists } from './manifest.ts'

/** 启用表 schema：3 = `config.yml` 只有 `schemaVersion` 与 `enabled`。 */
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

function readDocument(file: string): ReturnType<typeof parseDocument> | undefined {
  if (!existsSync(file)) return undefined
  const doc = parseDocument(readFileSync(file, 'utf8'), { logLevel: 'silent' })
  if (doc.errors.length > 0 || !isMap(doc.contents)) return undefined
  return doc
}

/**
 * 读启用表：返回启用的模块 id（按声明顺序，重复项去掉）。
 *
 * 文件缺失、解析失败、schemaVersion 低于 3、`enabled` 不是字符串数组——一律返回空表。
 * 空表意味着「没有模块参与装配」，这是明确状态，不是错误：旧版本的索引文件里
 * `enabled` 还没有启用语义，当成启用会让历史键意外参与装配。
 */
export function enabledModuleIds(moduleRoot: string): string[] {
  const doc = readDocument(enableTablePath(moduleRoot))
  if (doc === undefined) return []
  if (Number(doc.get('schemaVersion')) < ENABLE_TABLE_SCHEMA) return []
  const list: unknown = doc.toJS()?.enabled
  if (!Array.isArray(list)) return []
  return [...new Set(list.filter((id): id is string => typeof id === 'string' && id.trim().length > 0).map((id) => id.trim()))]
}

/** 写启用表：保留既有注释与未知字段，只改 `schemaVersion` 与 `enabled`。 */
function writeEnabled(moduleRoot: string, ids: readonly string[]): void {
  const file = enableTablePath(moduleRoot)
  const doc = readDocument(file)
  if (doc === undefined) {
    const lines = [
      '# Prompt Tool 模块启用表：只记录哪些模块参与运行时装配。',
      '# 参数、提示词与素材在各模块自己的目录里（modules/<id>/）；这里没有版本指针，也没有配装段。',
      '',
      `schemaVersion: ${ENABLE_TABLE_SCHEMA}`,
      ...(ids.length === 0 ? ['enabled: []'] : ['enabled:', ...ids.map((id) => `  - ${id}`)]),
      '',
    ]
    atomicWriteTextFile(file, lines.join('\n'))
    return
  }
  doc.set('schemaVersion', ENABLE_TABLE_SCHEMA)
  doc.set('enabled', [...ids])
  atomicWriteTextFile(file, doc.toString())
}

/**
 * 解析**编辑目标**模块目录：请求声明了目标就按它定位，没声明则回退启用表首项。
 *
 * 这是「按请求定位编辑目标」的唯一入口——编辑器不必依赖某个全局单选：写请求带上
 * 模块 id 就写那个模块，不带则落到启用表第一项（= 装配顺序首项）。目标不存在时返回
 * 空串，由调用方按「无目标」拒绝，不静默改写到别的模块。
 */
export function resolveEditDir(moduleRoot: string, moduleId?: string): string {
  const target = moduleId !== undefined && moduleId.trim().length > 0 ? moduleId.trim() : enabledModuleIds(moduleRoot)[0]
  if (target === undefined) return ''
  return moduleDirExists(moduleRoot, target) ? join(moduleRoot, target) : ''
}

/**
 * 启用或停用一个模块。幂等：已在表里再启用不产生第二条，不在表里再停用不报错。
 * 顺序即装配顺序，新模块追加在末尾（同键参数的覆盖顺序因此可预测）。
 */
export function setModuleEnabled(moduleRoot: string, id: string, enabled: boolean): void {
  const current = enabledModuleIds(moduleRoot)
  const next = enabled
    ? (current.includes(id) ? current : [...current, id])
    : current.filter((existing) => existing !== id)
  if (next.length === current.length && next.every((value, index) => value === current[index])) return
  writeEnabled(moduleRoot, next)
}
