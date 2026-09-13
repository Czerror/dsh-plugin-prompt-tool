/**
 * prompt-tool skills 的安装副本。
 *
 * 安装命令 `dsh plugin add` 是官方的 pnpm 转发器，插件代码不会在该命令中
 * 执行（本项目也不修改官方源码）。因此复制动作放在插件首次 apply 时：
 * 把包内 `skills/` 增量复制到 **DSH_HOME 技能根**（`$DSH_HOME/skills`，
 * 官方 dsh-skill-filesystem 的 `user-dsh` 来源），并且后续启动优先使用这份
 * 副本。这份副本跨越 profile 共享：无论从 `dsh web` / `dsh-tui` 启动，官方
 * provider 与本插件都从同一目录发现技能。旧版本写在
 * `$DSH_HOME/profiles/<profile>/skills` 的副本不再使用，也不清理。
 *
 * 合并规则（内容哈希账本，无手写版本清单）：
 *  - 包内技能 = 包 `skills/` 下的一级目录（点开头忽略）；
 *  - 目标副本通过 `.prompt-tool-manifest.json` 记录每个技能**部署时**的包内容哈希；
 *  - 包内容哈希与账本一致 → 不动目标副本（用户对副本的改动保留）；
 *  - 包内容变了 → 整体覆盖该技能目录（升级），并保留 SKILL.md.disabled 停用态；
 *  - 用户自建技能目录（不在包内）与账本外内容一律不动。
 */
import { createHash } from 'node:crypto'
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DSH_HOME } from './host/paths.ts'
import { DISABLED_SUFFIX, SKILL_MARKER } from './host/skill-toggle.ts'

/** DSH_HOME 技能根：官方 dsh-skill-filesystem 的 user-dsh 来源。 */
const SKILLS_ROOT = 'skills'
/** 目标副本中记录"部署时包内容哈希"的隐藏账本。 */
const TARGET_MANIFEST = '.prompt-tool-manifest.json'

interface SkillsLedger {
  version: number
  /** folder → 部署时包内技能目录的内容哈希。 */
  deployed: Record<string, string>
}

function readLedger(file: string): SkillsLedger {
  const empty: SkillsLedger = { version: 2, deployed: {} }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<SkillsLedger> | null
    if (parsed === null || typeof parsed !== 'object') return empty
    const deployed = parsed.deployed
    if (deployed === null || typeof deployed !== 'object') return empty
    const entries = Object.entries(deployed).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    return { version: 2, deployed: Object.fromEntries(entries) }
  } catch {
    // 文件缺失/损坏（含旧版 version+skills 格式）：按空账本处理，下次启动重铺一次包内技能。
    return empty
  }
}

/** 原子写账本（tmp + rename）：失败保留旧副本状态。 */
function writeLedger(file: string, ledger: SkillsLedger): void {
  const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`
  writeFileSync(tmp, JSON.stringify(ledger, null, 2) + '\n', 'utf8')
  renameSync(tmp, file)
}

/** 包内技能目录清单：一级目录，点开头（.system 等）忽略。 */
function listPackageSkills(sourceDir: string): string[] {
  try {
    return readdirSync(sourceDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b))
  } catch {
    return []
  }
}

/**
 * 技能目录内容哈希：递归遍历（相对路径 + 文件内容；符号链接按链接目标），
 * 排序后逐项喂给 sha256，保证同一份内容在任何机器/时刻得到同一哈希。
 */
function hashSkillDir(dir: string): string {
  const hash = createHash('sha256')
  const walk = (current: string, rel: string): void => {
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    } catch {
      hash.update(`${rel}\u0000!unreadable\n`)
      return
    }
    for (const entry of entries) {
      const full = join(current, entry.name)
      const entryRel = rel.length > 0 ? `${rel}/${entry.name}` : entry.name
      const lstat = lstatSync(full)
      if (lstat.isSymbolicLink()) {
        hash.update(`${entryRel}\u0000link\u0000${readlinkSync(full)}\n`)
      } else if (lstat.isDirectory()) {
        hash.update(`${entryRel}\u0000dir\n`)
        walk(full, entryRel)
      } else {
        hash.update(`${entryRel}\u0000file\u0000`)
        hash.update(readFileSync(full))
        hash.update('\n')
      }
    }
  }
  walk(dir, '')
  return hash.digest('hex')
}

/** 按内容哈希同步包内技能副本：包内容变了才覆盖，用户自建技能与本地改动保留。 */
function syncPackageSkills(sourceDir: string, targetDir: string): void {
  const folders = listPackageSkills(sourceDir)
  if (folders.length === 0) return
  mkdirSync(targetDir, { recursive: true })
  const ledger = readLedger(join(targetDir, TARGET_MANIFEST))

  // 需部署（缺失或包内容变化）的技能先整体复制到暂存目录，避免逐个直接写目标
  // 造成「进程中断 = 技能半写」；暂存完成后逐技能 tmp+rename 原子替换，失败
  // 恢复旧目录。包内容未变或用户自建技能保持不动。
  const pending: Array<{ folder: string; staged: string; hash: string }> = []
  for (const folder of folders) {
    const sourceEntry = join(sourceDir, folder)
    const hash = hashSkillDir(sourceEntry)
    if (ledger.deployed[folder] === hash) continue
    const staged = join(targetDir, `.skills-sync-${process.pid}-${Date.now().toString(36)}-${folder}`)
    cpSync(sourceEntry, staged, { recursive: true })
    pending.push({ folder, staged, hash })
  }
  try {
    for (const { folder, staged, hash } of pending) {
      const targetEntry = join(targetDir, folder)
      const backup = join(targetDir, `.skills-${folder}.bak-${Date.now().toString(36)}`)
      const hadOld = existsSync(targetEntry)
      // 停用是用户的磁盘事实（SKILL.md.disabled）：版本升级换目录后必须保留，
      // 否则包内技能一升级就把用户关掉的技能悄悄打开。
      const wasDisabled = hadOld && existsSync(join(targetEntry, SKILL_MARKER + DISABLED_SUFFIX))
      if (hadOld) renameSync(targetEntry, backup)
      try {
        renameSync(staged, targetEntry)
      } catch (error) {
        if (hadOld) {
          try { renameSync(backup, targetEntry) } catch { /* 恢复失败保留 backup 供人工处理 */ }
        }
        throw error
      }
      if (wasDisabled) {
        try {
          renameSync(join(targetEntry, SKILL_MARKER), join(targetEntry, SKILL_MARKER + DISABLED_SUFFIX))
        } catch {
          // 新副本没有可停用的标记文件（或改名失败）：保留启用态并留下备份现场。
        }
      }
      if (hadOld) rmSync(backup, { recursive: true, force: true })
      ledger.deployed[folder] = hash
    }
  } finally {
    for (const { staged } of pending) rmSync(staged, { recursive: true, force: true })
  }

  writeLedger(join(targetDir, TARGET_MANIFEST), ledger)
}

/**
 * 返回本插件应使用的 skills 目录：
 * 优先 `$DSH_HOME/skills` 副本（官方 user-dsh 根，与官方 provider 同源）；
 * 复制失败时回退到 sourceDir（默认包内 `skills/`）。
 */
export function resolveSkillsDir(sourceDir: string, warn: (message: string) => void): string {
  const targetDir = join(DSH_HOME, SKILLS_ROOT)
  try {
    if (!existsSync(sourceDir)) return targetDir
    syncPackageSkills(sourceDir, targetDir)
    return targetDir
  } catch (error) {
    warn(`prompt-tool: failed to copy skills into ${targetDir}: ${error instanceof Error ? error.message : String(error)}`)
    return sourceDir
  }
}

