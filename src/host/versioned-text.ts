/**
 * 版本化文本替换：把「读版本 → 校验 → prepare → 替换前再核 → 原子替换」收成一处。
 *
 * 只处理文本文件；错误码/status 由 conflict() 与 prepare/recheck 的域错误提供，
 * 原语不解析错误类型，也不接管锁、队列或 publication 语义。
 */
import { atomicWriteTextFile } from './text-file.ts'

export interface VersionedTextSnapshot<T> {
  /** 当前字节版本；文件不存在为 null（是否允许创建由调用方按 expectedRevision 决定）。 */
  revision: string | null
  /** 域快照内容；prepare/recheck 只拿到这个值。 */
  value: T
  /** 当前原文；提供时用于「原文相同则不写盘」。 */
  text?: string
  /** 显式权限位；省略时由 atomicWriteTextFile 精确保留现有权限。 */
  mode?: number
}

export interface VersionedTextOptions<T> {
  file: string
  expectedRevision: string | null
  /** 无副作用快照；成功写入时会被调用两次。 */
  read: () => VersionedTextSnapshot<T>
  /** 返回新原文；undefined 表示无需写入。可在内做域校验。 */
  prepare: (value: T) => string | undefined
  /** 替换前额外身份检查；拿到第二次 read 的 value。 */
  recheck?: (value: T) => void
  /** 版本冲突时由域构造错误（保留 code/status/message）。 */
  conflict: () => Error
  /** 目标目录不存在时先建；默认不建。 */
  mkdir?: boolean
}

export interface VersionedTextResult {
  changed: boolean
  text?: string
}

export function replaceVersionedText<T>(options: VersionedTextOptions<T>): VersionedTextResult {
  const current = options.read()
  if (options.expectedRevision !== current.revision) throw options.conflict()
  const text = options.prepare(current.value)
  if (text === undefined) return { changed: false }
  if (current.text !== undefined && text === current.text) return { changed: false }
  atomicWriteTextFile(options.file, text, {
    ...(options.mkdir === true ? { mkdir: true } : {}),
    ...(current.mode === undefined ? {} : { mode: current.mode }),
    beforeReplace: () => {
      const again = options.read()
      if (again.revision !== current.revision) throw options.conflict()
      options.recheck?.(again.value)
    },
  })
  return { changed: true, text }
}
