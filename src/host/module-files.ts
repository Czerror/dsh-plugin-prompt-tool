/** 模块私有文件的唯一 owner：memory.md、assets/ 只读、data/ 只追加。 */
import { appendFileSync, readFileSync, statSync } from 'node:fs'
import { ensureDataDirectory, moduleFilePath, resolveModuleFilePath } from './module-file-path.ts'

/** 单次读写上限；与变量文件的 8 MiB 账本上限分开。 */
export const MAX_FILE_BYTES = 1024 * 1024
/** data/ 下的账本类文件总量上限。 */
export const MAX_DATA_FILE_BYTES = 8 * 1024 * 1024

export interface ModuleFileContent {
  path: string
  content: string
  bytes: number
}

export function readModuleFile(moduleDir: string, path: string): ModuleFileContent {
  const { file } = moduleFilePath(moduleDir, path, ['assets', 'data'], { allowRootMemory: true })
  // 缺失（含上级目录尚未装配）按空处理；存在时才做链接与真实路径校验。
  if (statSync(file, { throwIfNoEntry: false }) === undefined) return { path, content: '', bytes: 0 }
  const resolved = resolveModuleFilePath(moduleDir, path, ['assets', 'data'], { allowRootMemory: true })
  const stat = statSync(resolved)
  if (!stat.isFile()) throw new Error(`模块文件不是普通文件：${path}`)
  // data/ 的写上限是 8 MiB，读上限必须对齐，否则账本长大后读不出来。
  const limit = path.startsWith('data/') ? MAX_DATA_FILE_BYTES : MAX_FILE_BYTES
  if (stat.size > limit) throw new Error(`模块文件超过 ${limit === MAX_FILE_BYTES ? '1 MiB' : '8 MiB'}：${path}`)
  const bytes = readFileSync(resolved)
  return { path, content: new TextDecoder('utf-8', { fatal: true }).decode(bytes), bytes: bytes.length }
}

/**
 * 追加一行：memory.md 与 data/ 下的文件都只往后加，不覆盖、不删除。
 * data/ 目录缺失时只建这一级；单次 1 MiB、账本文件 8 MiB。
 */
export function appendModuleLine(moduleDir: string, path: string, line: string): void {
  if (typeof line !== 'string') throw new TypeError('追加内容必须是字符串')
  const isMemory = path === 'memory.md'
  if (!isMemory && !path.startsWith('data/')) {
    throw new Error(`只能追加到 memory.md 或 data/：${path}`)
  }
  if (Buffer.byteLength(line) > MAX_FILE_BYTES) throw new Error('单次追加超过 1 MiB')
  const file = isMemory
    ? resolveModuleFilePath(moduleDir, path, [], { allowRootMemory: true })
    : (ensureDataDirectory(moduleDir), resolveModuleFilePath(moduleDir, path, ['data']))
  const existing = statSync(file, { throwIfNoEntry: false })?.size ?? 0
  const nextBytes = Buffer.byteLength(line) + 1
  // 写进超过读上限的文件等于让用户再也读不出来；写侧先挡住。
  if (isMemory && existing + nextBytes > MAX_FILE_BYTES) throw new Error('memory.md 超过 1 MiB')
  if (!isMemory && existing + nextBytes > MAX_DATA_FILE_BYTES) throw new Error(`data 文件超过 8 MiB：${path}`)
  if (line.length === 0) return
  // shortcut: 校验与追加之间没有 O_NOFOLLOW，同进程外并发写不保证；升级时改用 open 句柄校验。
  appendFileSync(file, line.endsWith('\n') ? line : line + '\n', 'utf8')
}
