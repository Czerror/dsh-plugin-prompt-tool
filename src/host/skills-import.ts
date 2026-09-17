/** 技能导入：把技能包复制进用户技能根（$DSH_HOME/skills）。
 *  两种入口共用同一实现：浏览器上传的文件列表、宿主机目录读取。
 *  复制完成后技能由官方 skill 文件提供者直接发现，插件不需要登记任何状态。 */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parseFrontmatter } from '../runtime/skills-parse.ts'
import { SKILL_NAME_PATTERN } from './skills-config.ts'

export interface SkillsImportFile { path?: unknown; content?: unknown }
export type SkillsImportResult = { ok: true; path: string; count: number } | { ok: false; message: string }
export interface SkillFile { path: string; buffer: Buffer }
const key = (path: string): string => process.platform === 'win32' ? path.toLowerCase() : path
const MAX_FILES = 10_000
const MAX_BYTES = 64 * 1024 * 1024

/** 技能包内的相对路径：禁止上跳、盘符、控制字符与保留管理目录。 */
function safePath(path: string): boolean {
  const parts = path.split('/')
  return path.length > 0 && path.length <= 2048
    && parts.every((part) => part.length > 0 && part !== '.' && part !== '..' && !/[<>:"|?*]/u.test(part) && !/[. ]$/.test(part)
      && ![...part].some((character) => character.charCodeAt(0) < 32) && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))
    && !['.system', '.skills-migration'].includes(parts[0] ?? '')
}

export function assertSkillDirectory(path: string): void {
  const info = lstatSync(path)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`技能目录不是普通目录：${path}`)
}

/** 读取宿主机技能目录：拒绝符号链接、硬链接、超限与非法路径。 */
export function readSkillDirectory(directory: string): SkillFile[] {
  const files: SkillFile[] = []
  let bytes = 0
  const walk = (current: string): void => {
    assertSkillDirectory(current)
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(current, entry.name)
      const path = relative(directory, full).split(sep).join('/')
      if (!safePath(path)) throw new Error(`非法技能资源路径：${path}`)
      const info = lstatSync(full)
      if (info.isSymbolicLink()) throw new Error(`技能资源不能是符号链接：${path}`)
      if (info.isDirectory()) walk(full)
      else if (info.isFile()) {
        if (info.nlink > 1) throw new Error(`技能资源不能是硬链接：${path}`)
        const buffer = readFileSync(full)
        bytes += buffer.length
        if (files.length >= MAX_FILES || bytes > MAX_BYTES) throw new Error('技能目录超过文件数或容量上限')
        files.push({ path, buffer })
      } else throw new Error(`不支持的技能资源类型：${path}`)
    }
  }
  walk(directory)
  return files
}

/** 覆盖前确认目标是技能目录：避免把用户根下的普通目录换掉。 */
function assertOverwritable(target: string): void {
  const info = lstatSync(target)
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`拒绝覆盖非普通目录：${target}`)
  if (!existsSync(join(target, 'SKILL.md'))) throw new Error(`拒绝覆盖非技能目录（缺少 SKILL.md）：${target}`)
}

/** 落盘事务：先写暂存目录，再逐顶层项切换；失败时把备份放回原处。 */
function importFiles(root: string, files: SkillFile[], overwrite: boolean): SkillsImportResult {
  const base = resolve(root)
  let stage: string | undefined
  try {
    if (files.length === 0) throw new Error('未收到技能文件')
    for (const file of files) {
      const path = file.path.replaceAll('\\', '/')
      file.path = path
      if (!safePath(path) || !path.includes('/')) throw new Error(`非法技能文件路径：${path}`)
    }
    const seen = new Set<string>()
    let bytes = 0
    for (const file of files) {
      if (seen.has(key(file.path))) throw new Error(`重复技能文件路径：${file.path}`)
      seen.add(key(file.path))
      bytes += file.buffer.length
    }
    if (files.length > MAX_FILES || bytes > MAX_BYTES) throw new Error('导入超过文件数或容量上限')
    mkdirSync(base, { recursive: true })
    assertSkillDirectory(base)
    stage = mkdtempSync(join(base, '.skills-import-'))
    for (const file of files) {
      const target = join(stage, file.path)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, file.buffer, { flag: 'wx' })
    }
    const tops = [...new Set(files.map((file) => file.path.split('/')[0]!))]
    const backups: Array<[string, string]> = []
    const restore = (): void => {
      for (const [target, backup] of [...backups].reverse()) {
        if (existsSync(target)) rmSync(target, { recursive: true, force: true })
        if (existsSync(backup)) renameSync(backup, target)
      }
    }
    try {
      for (const name of tops) {
        if (!SKILL_NAME_PATTERN.test(name)) throw new Error(`技能目录名不是 kebab-case：${name}`)
        const target = join(base, name)
        if (existsSync(target)) {
          if (!overwrite) throw new Error(`技能已存在：${name}`)
          assertOverwritable(target)
          const backup = join(stage, `.backup-${name}`)
          renameSync(target, backup)
          backups.push([target, backup])
        }
        renameSync(join(stage, name), target)
      }
    } catch (error) {
      restore()
      throw error
    }
    for (const [, backup] of backups) rmSync(backup, { recursive: true, force: true })
    return { ok: true, path: base, count: files.length }
  } catch (error) {
    return { ok: false, message: `技能导入失败：${error instanceof Error ? error.message : String(error)}` }
  } finally {
    if (stage !== undefined) rmSync(stage, { recursive: true, force: true })
  }
}

/** 浏览器上传：base64 文件列表；单技能包（无顶层目录）按 frontmatter.name 归类。 */
export function importSkillsPackage(root: string, files: SkillsImportFile[], overwrite = true): SkillsImportResult {
  try {
    if (typeof root !== 'string' || !Array.isArray(files)) throw new Error('技能目录或文件列表无效')
    const decoded = files.map((file) => {
      if (file === null || typeof file !== 'object' || typeof file.path !== 'string' || typeof file.content !== 'string') throw new Error('技能文件路径与内容必须为字符串')
      const path = file.path.replaceAll('\\', '/')
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.content)) throw new Error(`技能文件不是合法 base64：${path}`)
      return { path, buffer: Buffer.from(file.content, 'base64') }
    })
    const rootless = decoded.filter((file) => !file.path.includes('/'))
    if (rootless.length > 0) {
      const marker = rootless.find((file) => file.path === 'SKILL.md')
      if (marker === undefined) throw new Error('单技能包必须包含 SKILL.md')
      const parsed = parseFrontmatter(marker.buffer.toString('utf8'))
      const name = typeof parsed.data.name === 'string' ? parsed.data.name : ''
      if (!SKILL_NAME_PATTERN.test(name)) throw new Error('单技能包 frontmatter.name 不合法')
      for (const file of decoded) if (!file.path.includes('/')) file.path = `${name}/${file.path}`
    }
    return importFiles(root, decoded, overwrite)
  } catch (error) {
    return { ok: false, message: `技能导入失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

/** 宿主机目录导入：读取来源目录（校验符号链接与容量）后按目录名复制进用户根。
 *  来源必须是绝对路径：`resolve('')` 会退化成进程工作目录，等于把整个 cwd 当技能导入。 */
export function importSkillsDirectory(root: string, source: string): SkillsImportResult {
  try {
    if (typeof source !== 'string' || source.trim().length === 0) throw new Error('来源目录路径为空')
    if (!isAbsolute(source)) throw new Error('来源目录必须是绝对路径')
    const directory = resolve(source)
    const name = basename(directory)
    if (!SKILL_NAME_PATTERN.test(name)) throw new Error('来源目录名称必须是 kebab-case')
    return importFiles(root, readSkillDirectory(directory).map((file) => ({ ...file, path: `${name}/${file.path}` })), true)
  } catch (error) {
    return { ok: false, message: `技能导入失败：${error instanceof Error ? error.message : String(error)}` }
  }
}
