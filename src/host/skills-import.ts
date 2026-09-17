/** 技能导入：把技能包复制进用户技能根（$DSH_HOME/skills）。
 *  两种入口共用同一实现：浏览器上传的文件列表、宿主机目录读取。
 *  复制完成后技能由官方 skill 文件提供者直接发现，插件不需要登记任何状态。 */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parseFrontmatter } from '../runtime/skills-parse.ts'
import { SKILL_NAME_PATTERN } from './skills-config.ts'
import { trashSkill } from './skills-actions.ts'

export interface SkillsImportFile { path?: unknown; content?: unknown }
export type SkillsImportResult = { ok: true; path: string; count: number; overwritten: number } | { ok: false; message: string }
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
  let stage: string | undefined
  try {
    // 技能根由插件状态提供，这里仍要求绝对路径：空串会解析成进程工作目录，把 cwd 当技能根写。
    if (typeof root !== 'string' || root.trim().length === 0 || !isAbsolute(root)) throw new Error('技能根必须是绝对路径')
    const base = resolve(root)
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
    // 被替换的旧技能先移入回收站：覆盖失败时从这里放回原处，成功时它就是用户的恢复点。
    const replaced: Array<{ target: string; trashed: string; container: string }> = []
    /** 逐条回滚：单条失败不影响其余条目，并把两类后果分开报告——
     *  「技能没放回原处」需要用户去回收站手动恢复，「容器没清干净」只是残留垃圾。
     *  两者混成一句话会让用户去回收站找一个其实已经恢复的技能。 */
    const restore = (): { notRestored: string[]; containerLeft: string[] } => {
      const notRestored: string[] = []
      const containerLeft: string[] = []
      for (const entry of [...replaced].reverse()) {
        try {
          if (existsSync(entry.target)) rmSync(entry.target, { recursive: true, force: true })
          if (existsSync(entry.trashed)) renameSync(entry.trashed, entry.target)
          else notRestored.push(entry.trashed)
          rmSync(entry.container, { recursive: true, force: true })
        } catch {
          if (existsSync(entry.target) && !existsSync(entry.trashed)) containerLeft.push(entry.container)
          else notRestored.push(entry.trashed)
        }
      }
      return { notRestored, containerLeft }
    }
    try {
      for (const name of tops) {
        if (!SKILL_NAME_PATTERN.test(name)) throw new Error(`技能目录名不是 kebab-case：${name}`)
        const target = join(base, name)
        if (existsSync(target)) {
          if (!overwrite) throw new Error(`技能已存在：${name}`)
          assertOverwritable(target)
          const trashed = trashSkill(base, name, 'import-overwrite')
          replaced.push({ target, trashed: trashed.path, container: trashed.container })
        }
        renameSync(join(stage, name), target)
      }
    } catch (error) {
      const { notRestored, containerLeft } = restore()
      const reason = error instanceof Error ? error.message : String(error)
      // 回滚本身失败时不能掩盖原始原因：两类后果分别表述，原错误始终在最前面。
      const notes: string[] = []
      if (notRestored.length > 0) notes.push(`有技能未放回原处，请在回收站手动恢复：${notRestored.join('、')}`)
      if (containerLeft.length > 0) notes.push(`回收站残留空容器，可忽略或手动删除：${containerLeft.join('、')}`)
      throw new Error(notes.length === 0 ? reason : `${reason}；${notes.join('；')}`)
    }
    return { ok: true, path: base, count: files.length, overwritten: replaced.length }
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

/** 校验宿主机导入来源并规范化：必须是非空绝对路径。
 *  空串会让 `resolve('')` 退化成进程工作目录，等于把整个 cwd 当技能导入。
 *  端点与实现层共用这一个入口，拒绝文案只有一份。 */
export function assertImportableSource(source: unknown): string {
  if (typeof source !== 'string' || source.trim().length === 0) throw new Error('来源目录路径为空')
  if (!isAbsolute(source)) throw new Error('来源目录必须是绝对路径')
  return resolve(source)
}

/** 宿主机目录导入：读取来源目录（校验符号链接与容量）后按目录名复制进用户根。 */
export function importSkillsDirectory(root: string, source: string): SkillsImportResult {
  try {
    const directory = assertImportableSource(source)
    const name = basename(directory)
    if (!SKILL_NAME_PATTERN.test(name)) throw new Error('来源目录名称必须是 kebab-case')
    return importFiles(root, readSkillDirectory(directory).map((file) => ({ ...file, path: `${name}/${file.path}` })), true)
  } catch (error) {
    return { ok: false, message: `技能导入失败：${error instanceof Error ? error.message : String(error)}` }
  }
}
