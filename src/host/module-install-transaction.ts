/**
 * 模块目录安装事务：暂存候选、锁内复核目标版本、备份/交换/回滚与清理。
 *
 * 这是**纯目录事务**：只认 root、id、expectedVersion 与 build(candidate)，不读 module.yml，
 * 不判断模块定义是否合法。候选内容的校验归调用方（writeModule / installModulePackage /
 * module-catalog）。目标版本为 null 表示目标必须不存在；为 string 表示必须等于该版本。
 */
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { isModuleId } from '../shared/module-ids.ts'
import { assertModuleId, assertModuleTree, canonicalModulesRoot, modulePathExists } from './module-install.ts'
import { directoryVersionOf } from './preview-revision.ts'
import { assertPlain, withModuleLock } from './module-write.ts'

const installStageName = /^\.(.+)\.install-[A-Za-z0-9]{6}$/

function pendingBackups(root: string, id?: string): Map<string, string[]> {
  const backups = new Map<string, string[]>()
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const owner = installStageName.exec(entry.name)?.[1]
    if (!isModuleId(owner) || (id !== undefined && owner !== id) || modulePathExists(join(root, owner))) continue
    const stage = join(root, entry.name)
    const stat = lstatSync(stage, { throwIfNoEntry: false })
    if (!stat) continue
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`模块安装暂存路径不是普通目录：${stage}`)
    const backup = join(stage, 'previous')
    // 已换入的候选不再位于 stage，残留备份不能复活后来删除的模块。
    const candidate = join(stage, owner)
    if (!modulePathExists(backup) || !modulePathExists(candidate)) continue
    assertPlain(candidate, true)
    const paths = backups.get(owner) ?? []
    paths.push(backup)
    backups.set(owner, paths)
  }
  return backups
}

/** 仅在换入候选前中断且目标缺失时恢复原目录。目标已发布时保留外部状态交接备份。 */
function restoreMissingTarget(root: string, id: string): boolean {
  const target = join(root, id)
  if (modulePathExists(target)) return false
  const backups = pendingBackups(root, id).get(id)
  if (backups === undefined) return false
  if (backups.length !== 1) throw new Error(`模块 ${id} 有多个待恢复目录：${backups.join('、')}`)
  const backup = backups[0]!
  assertPlain(backup, true)
  assertModuleTree(backup)
  renameSync(backup, target)
  return true
}

export function recoverModuleInstallations(root: string, warn?: (message: string) => void): void {
  const canonical = canonicalModulesRoot(root, true)
  if (!modulePathExists(canonical)) return
  for (const id of pendingBackups(canonical).keys()) {
    if (withModuleLock(canonical, id, () => restoreMissingTarget(canonical, id))) {
      warn?.(`prompt-tool: 已恢复中断安装前的模块目录：${join(canonical, id)}`)
    }
  }
}

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
  beforeCommit?: () => void
}
export interface ModuleInstallCommitOptions extends ModuleInstallOptions { commit: () => Promise<void> }

/** 清理本次 stage；失败返回路径供调用方报告，不掩盖已完成的安装。 */
function cleanupStage(stage: string): string | undefined {
  try {
    rmSync(stage, { recursive: true, force: true })
    return undefined
  } catch {
    return stage
  }
}

export function installModuleDirectory(options: ModuleInstallCommitOptions): Promise<ModuleInstallOutcome>
export function installModuleDirectory(options: ModuleInstallOptions): ModuleInstallOutcome
export function installModuleDirectory(options: ModuleInstallOptions | ModuleInstallCommitOptions): ModuleInstallOutcome | Promise<ModuleInstallOutcome> {
  const { root, id, expectedVersion, build, signal } = options
  assertModuleId(id)
  mkdirSync(resolve(root), { recursive: true })
  // 根也走同一路径判据：链接根在这里拒绝，stage 不会先落进链接目标。
  const rootPath = canonicalModulesRoot(resolve(root))
  const target = join(rootPath, id)
  // 暂存根与目标同文件系统；目录名带目标 id，失败时可由用户识别。
  const stage = mkdtempSync(join(rootPath, '.' + id + '.install-'))
  const candidate = join(stage, id)
  let outcome: ModuleInstallOutcome | Promise<ModuleInstallOutcome>
  try {
    mkdirSync(candidate)
    build(candidate)
    const stat = lstatSync(candidate)
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('候选不是普通目录：' + candidate)
    outcome = withModuleLock(rootPath, id, () => {
      signal?.throwIfAborted()
      if (expectedVersion === null) restoreMissingTarget(rootPath, id)
      const actualVersion = directoryVersionOf(target)
      if (actualVersion !== expectedVersion) return { state: 'conflict', actualVersion } as const
      options.beforeCommit?.()
      if (expectedVersion === null) {
        if ('commit' in options) throw new Error('状态交接只支持已存在模块的受控更新')
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
      if ('commit' in options) return Promise.resolve().then(options.commit).then(() => ({ state: 'installed' as const }), error => {
        if (error instanceof Error && 'code' in error && error.code === 'unknown-state') return { state: 'recovery-required' as const, backupPath: backup, cause: error }
        try {
          renameSync(target, candidate)
          renameSync(backup, target)
        } catch (restoreError) {
          return { state: 'recovery-required' as const, backupPath: backup, cause: restoreError }
        }
        throw error
      })
      return { state: 'installed' } as const
    })
  } catch (error) {
    // build 失败、锁竞争、目标不是普通目录或换入失败且已恢复：都不留 stage，原错误照抛。
    cleanupStage(stage)
    throw error
  }
  const finish = (result: ModuleInstallOutcome): ModuleInstallOutcome => {
    if (result.state === 'recovery-required') return result
    const leftoverStage = cleanupStage(stage)
    return result.state === 'installed' && leftoverStage !== undefined ? { state: 'installed', leftoverStage } : result
  }
  if (outcome instanceof Promise) return outcome.then(finish, error => { cleanupStage(stage); throw error })
  return finish(outcome)
}
