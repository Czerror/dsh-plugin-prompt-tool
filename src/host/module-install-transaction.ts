/**
 * 模块目录安装事务：暂存候选、锁内复核目标版本、备份/交换/回滚与清理。
 *
 * 这是**纯目录事务**：只认 root、id、expectedVersion 与 build(candidate)，不读 module.yml，
 * 不判断模块定义是否合法。候选内容的校验归调用方（writeModule / installModulePackage /
 * module-catalog）。目标版本为 null 表示目标必须不存在；为 string 表示必须等于该版本。
 */
import { lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { assertModuleId, canonicalModulesRoot } from './module-install.ts'
import { directoryVersionOf } from './preview-revision.ts'
import { withModuleLock } from './module-write.ts'

export type ModuleInstallExpectation = string | null

/** 安装成功但暂存目录清理失败时的统一告警文案；调用方决定日志落点。 */
export const leftoverStageWarning = (path: string): string =>
  `prompt-tool: 模块已安装，但暂存目录清理失败：${path}`

export type ModuleInstallOutcome =
  | { state: 'installed'; leftoverStage?: string }
  | { state: 'conflict'; actualVersion: string | null }
  | { state: 'recovery-required'; backupPath: string; cause: unknown }

export interface ModuleInstallOptions {
  root: string
  id: string
  /** null = 目标必须不存在；string = 目标必须正好是这个目录版本。 */
  expectedVersion: ModuleInstallExpectation
  /** 在事务创建的候选目录里写入完整候选；返回后事务负责交换。 */
  build: (candidate: string) => void
  /** 取消信号：提交前复核，已取消则抛出且不碰目标。 */
  signal?: AbortSignal
}

/** 清理本次 stage；失败返回路径供调用方报告，不掩盖已完成的安装。 */
function cleanupStage(stage: string): string | undefined {
  try {
    rmSync(stage, { recursive: true, force: true })
    return undefined
  } catch {
    return stage
  }
}

export function installModuleDirectory(options: ModuleInstallOptions): ModuleInstallOutcome {
  const { root, id, expectedVersion, build, signal } = options
  assertModuleId(id)
  mkdirSync(resolve(root), { recursive: true })
  // 根也走同一路径判据：链接根在这里拒绝，stage 不会先落进链接目标。
  const rootPath = canonicalModulesRoot(resolve(root))
  const target = join(rootPath, id)
  // 暂存根与目标同文件系统；目录名带目标 id，失败时可由用户识别。
  const stage = mkdtempSync(join(rootPath, '.' + id + '.install-'))
  const candidate = join(stage, id)
  let outcome: ModuleInstallOutcome
  try {
    mkdirSync(candidate)
    build(candidate)
    const stat = lstatSync(candidate)
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('候选不是普通目录：' + candidate)
    outcome = withModuleLock(rootPath, id, () => {
      signal?.throwIfAborted()
      const actualVersion = directoryVersionOf(target)
      if (actualVersion !== expectedVersion) return { state: 'conflict', actualVersion } as const
      if (expectedVersion === null) {
        // 目标必须不存在：没有旧目录可备份，直接落到目标。
        renameSync(candidate, target)
        return { state: 'installed' } as const
      }
      const backup = join(stage, 'previous')
      renameSync(target, backup)
      try {
        renameSync(candidate, target)
      } catch (error) {
        try {
          renameSync(backup, target)
        } catch (restoreError) {
          // 备份是唯一旧副本：不清理 stage，把路径交给调用方报告。
          return { state: 'recovery-required', backupPath: backup, cause: restoreError } as const
        }
        throw error
      }
      return { state: 'installed' } as const
    })
  } catch (error) {
    // build 失败、锁竞争、目标不是普通目录或换入失败且已恢复：都不留 stage，原错误照抛。
    cleanupStage(stage)
    throw error
  }
  if (outcome.state === 'recovery-required') return outcome
  const leftoverStage = cleanupStage(stage)
  if (outcome.state === 'installed' && leftoverStage !== undefined) {
    return { state: 'installed', leftoverStage }
  }
  return outcome
}
