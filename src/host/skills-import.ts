/** 技能目录导入：把 webkitdirectory 上传的文件夹内容物化到当前技能目录。 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

export interface SkillsImportFile {
  path?: unknown
  content?: unknown
}

export type SkillsImportResult =
  | { ok: true; path: string; count: number }
  | { ok: false; message: string }

/** 浏览器路径 → 安全相对段；拒绝绝对路径、盘符与 `.` / `..` 段。 */
function normalizeImportPath(input: string): string[] | undefined {
  const normalized = input.replace(/\\/g, '/')
  if (normalized.length === 0 || normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) return undefined
  const segments = normalized.split('/').filter((segment) => segment.length > 0)
  if (segments.length === 0) return undefined
  if (segments.some((segment) => segment === '.' || segment === '..')) return undefined
  return segments
}

/** webkitdirectory 的首个目录段是“用户选中的文件夹”，不是技能根内容。 */
function relativeSegments(segments: string[]): string[] {
  return segments.length > 1 ? segments.slice(1) : segments
}

export function importSkillsPackage(skillsDir: string, files: SkillsImportFile[]): SkillsImportResult {
  if (typeof skillsDir !== 'string' || skillsDir.trim().length === 0) {
    return { ok: false, message: '技能目录未配置' }
  }
  const root = resolve(skillsDir)
  const normalized: Array<{ path: string; buffer: Buffer }> = []
  for (const file of files) {
    if (file === null || typeof file !== 'object') continue
    const path = typeof file.path === 'string' ? file.path : ''
    const content = typeof file.content === 'string' ? file.content : ''
    const segments = normalizeImportPath(path)
    if (segments === undefined) return { ok: false, message: `非法技能文件路径：${path}` }
    normalized.push({ path: relativeSegments(segments).join('/'), buffer: Buffer.from(content, 'base64') })
  }
  if (normalized.length === 0) return { ok: false, message: '未收到技能文件' }

  const moved: Array<{ target: string; backup?: string }> = []
  let tempRoot: string | undefined
  try {
    mkdirSync(root, { recursive: true })
    const stagingRoot = mkdtempSync(join(root, '.skills-import-'))
    tempRoot = stagingRoot
    for (const file of normalized) {
      const target = join(stagingRoot, file.path)
      const targetRelative = relative(stagingRoot, target)
      if (targetRelative === '' || targetRelative.startsWith(`..${sep}`) || targetRelative === '..' || resolve(target) !== join(stagingRoot, targetRelative)) {
        throw new Error(`非法技能文件路径：${file.path}`)
      }
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, file.buffer)
    }
    for (const entry of readdirSync(stagingRoot, { withFileTypes: true })) {
      const target = join(root, entry.name)
      const backup = join(root, `.skills-${entry.name}.bak-${Date.now().toString(36)}-${moved.length}`)
      const hadOld = existsSync(target)
      if (hadOld) renameSync(target, backup)
      moved.push(hadOld ? { target, backup } : { target })
      renameSync(join(stagingRoot, entry.name), target)
    }
  } catch (error) {
    for (let at = moved.length - 1; at >= 0; at -= 1) {
      const item = moved[at]!
      try {
        rmSync(item.target, { recursive: true, force: true })
        if (item.backup !== undefined) renameSync(item.backup, item.target)
      } catch {
        // 回滚失败保留备份现场，避免破坏用户数据。
      }
    }
    return { ok: false, message: `技能目录写入失败：${error instanceof Error ? error.message : String(error)}` }
  } finally {
    if (tempRoot !== undefined) {
      try {
        rmSync(tempRoot, { recursive: true, force: true })
      } catch {
        // 临时目录清理失败不覆盖导入结果；下次扫描会忽略点目录。
      }
    }
  }

  for (const item of moved) {
    if (item.backup !== undefined) {
      try {
        rmSync(item.backup, { recursive: true, force: true })
      } catch {
        // 导入已成功；残留备份不影响技能扫描（点前缀目录被忽略）。
      }
    }
  }
  return { ok: true, path: root, count: normalized.length }
}
