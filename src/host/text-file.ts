/** 共用原子文本替换；来源授权与内容合法性由各领域调用方负责。 */
import { randomUUID } from 'node:crypto'
import { renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

export function atomicWriteTextFile(file: string, content: string, options: {
  mode?: number
  /** 暂存完成、替换原件之前复核路径与内容；抛错则取消写入。 */
  beforeReplace?: () => void
} = {}): void {
  const temporary = join(dirname(file), `.${basename(file)}.tmp-${randomUUID()}`)
  try {
    writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx', ...(options.mode === undefined ? {} : { mode: options.mode }) })
    options.beforeReplace?.()
    renameSync(temporary, file)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
}
