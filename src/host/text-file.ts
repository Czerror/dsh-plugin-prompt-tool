/** 共用原子文本替换；来源授权与内容合法性由各领域调用方负责。 */
import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

/** 新目标的建文件权限；仍交给内核按进程 umask 收敛，不在 helper 里越过用户的 umask 策略。 */
const DEFAULT_MODE = 0o644

/** 暂存名的唯一形态：`.<目标名>.tmp-<uuid>`。写入端与残留清扫端共用它——只认这一种名字，普通点文件与用户素材一律不碰。 */
export function atomicTemporaryTarget(filename: string): string | undefined {
  return /^\.(.+)\.tmp-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.exec(filename)?.[1]
}

export function atomicWriteTextFile(file: string, content: string, options: {
  /** 显式权限位；省略时精确保留目标现有权限位（目标不存在则按 DEFAULT_MODE 与 umask 新建）。 */
  mode?: number
  /** 目标目录不存在时先建；默认不建，目录归属由调用方保证。 */
  mkdir?: boolean
  /** 暂存完成、替换原件之前复核路径与内容；抛错则取消写入。 */
  beforeReplace?: () => void
} = {}): void {
  if (options.mkdir === true) mkdirSync(dirname(file), { recursive: true })
  // 已有目标或显式 mode：写后 chmod 精确设位（`writeFileSync` 的 mode 会被 umask 再掩一次，只会收窄）。
  // 新目标：不指定 mode，交给内核按 umask 建，免得绕过用户的 umask 策略放宽权限。
  const mode = options.mode ?? targetMode(file)
  const temporary = join(dirname(file), `.${basename(file)}.tmp-${randomUUID()}`)
  try {
    // 已解析权限：先按属主可读写建暂存，再 chmod 精确设位——暂存在设位前不得比目标更宽。
    writeFileSync(temporary, content, mode === undefined
      ? { encoding: 'utf8', flag: 'wx', mode: DEFAULT_MODE }
      : { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    if (mode !== undefined) chmodSync(temporary, mode & 0o7777)
    options.beforeReplace?.()
    renameSync(temporary, file)
  } catch (error) {
    // 清理失败（文件被占用等）不掩盖原始错误，与 agents-cards 原实现同口径。
    try { rmSync(temporary, { force: true }) } catch { /* 残留暂存不影响原文件。 */ }
    throw error
  }
}

/** 目标当前权限位；只有 ENOENT 当「没有目标」，其余读取失败继续传播，不静默放宽权限。 */
function targetMode(file: string): number | undefined {
  try {
    return statSync(file).mode
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}
