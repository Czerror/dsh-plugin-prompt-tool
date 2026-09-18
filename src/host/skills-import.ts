/** 技能导入：把技能包复制进用户技能根（$DSH_HOME/skills）。
 *  两种入口共用同一实现：浏览器上传的文件列表、宿主机目录读取。
 *  复制完成后技能由官方 skill 文件提供者直接发现，插件不需要登记任何状态。 */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parseFrontmatter } from '../runtime/skills-parse.ts'
import { SKILL_NAME_PATTERN } from './skills-config.ts'

export interface SkillsImportFile { path?: unknown; content?: unknown }
export type SkillsImportResult = { ok: true; path: string; count: number; overwritten: number; warning?: string }
  | { ok: false; message: string; code?: 'skills-overwrite-required'; conflicts?: string[] }
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
        if (files.length >= MAX_FILES || bytes + info.size > MAX_BYTES) throw new Error('技能目录超过文件数或容量上限')
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
  const marker = lstatSync(join(target, 'SKILL.md'), { throwIfNoEntry: false })
  if (marker === undefined || !marker.isFile() || marker.isSymbolicLink()) throw new Error(`拒绝覆盖非技能目录（缺少普通 SKILL.md）：${target}`)
}

/** 落盘事务：先写暂存目录，再逐顶层项切换；失败时把备份放回原处。 */
function importFiles(root: string, files: SkillFile[], overwrite: readonly string[]): SkillsImportResult {
  let stage: string | undefined
  let keepStage = false
  let conflicts: string[] = []
  let result: SkillsImportResult | undefined
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
    if (!Array.isArray(overwrite) || overwrite.some((name) => typeof name !== 'string' || !SKILL_NAME_PATTERN.test(name))) throw new Error('覆盖确认名单必须是技能目录名数组')
    const confirmed = new Set(overwrite.map(key))
    const seen = new Map<string, SkillFile>()
    let bytes = 0
    for (const file of files) {
      if (seen.has(key(file.path))) throw new Error(`重复技能文件路径：${file.path}`)
      seen.set(key(file.path), file)
      bytes += file.buffer.length
    }
    if (files.length > MAX_FILES || bytes > MAX_BYTES) throw new Error('导入超过文件数或容量上限')
    for (const file of files) {
      const parts = file.path.split('/')
      for (let index = 1; index < parts.length; index += 1) {
        if (seen.has(key(parts.slice(0, index).join('/')))) throw new Error(`技能路径同时是文件与目录：${file.path}`)
      }
    }
    const tops = [...new Set(files.map((file) => file.path.split('/')[0]!))]
    for (const name of tops) {
      if (!SKILL_NAME_PATTERN.test(name)) throw new Error(`技能目录名不是 kebab-case：${name}`)
      const marker = seen.get(key(`${name}/SKILL.md`))
      if (marker === undefined || marker.path !== `${name}/SKILL.md`) throw new Error(`技能目录缺少 SKILL.md：${name}`)
      const parsed = parseFrontmatter(marker.buffer.toString('utf8'))
      if (parsed.issue !== undefined) throw new Error(`${name}：${parsed.issue}`)
      if (typeof parsed.data.name !== 'string' || !SKILL_NAME_PATTERN.test(parsed.data.name)
        || typeof parsed.data.description !== 'string' || parsed.data.description.trim().length === 0) {
        throw new Error(`技能 ${name} 的 SKILL.md 必须包含合法 name 与非空 description`)
      }
    }
    if (existsSync(base)) assertSkillDirectory(base)
    const present = tops.filter((name) => lstatSync(join(base, name), { throwIfNoEntry: false }) !== undefined)
    conflicts = present.filter((name) => !confirmed.has(key(name)))
    if (conflicts.length > 0) throw new Error(`覆盖同名技能前需要确认：${conflicts.join('、')}`)
    for (const name of present) assertOverwritable(join(base, name))
    mkdirSync(base, { recursive: true })
    assertSkillDirectory(base)
    stage = mkdtempSync(join(base, '.skills-import-'))
    const incoming = join(stage, 'incoming')
    const backup = join(stage, 'backup')
    mkdirSync(backup)
    for (const file of files) {
      const target = join(incoming, file.path)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, file.buffer, { flag: 'wx' })
    }
    // 备份只属于这次事务；新增项同样记入日志，失败才能一并清理。
    const switched: Array<{ target: string; backup?: string; installed: boolean }> = []
    try {
      for (const name of tops) {
        const target = join(base, name)
        const entry: typeof switched[number] = { target, installed: false }
        if (lstatSync(target, { throwIfNoEntry: false }) !== undefined) {
          if (!confirmed.has(key(name))) {
            conflicts = [name]
            throw new Error(`覆盖同名技能前需要确认：${name}`)
          }
          assertOverwritable(target)
          const saved = join(backup, name)
          renameSync(target, saved)
          entry.backup = saved
        }
        switched.push(entry)
        renameSync(join(incoming, name), target)
        entry.installed = true
      }
    } catch (error) {
      const notRestored: string[] = []
      for (const entry of [...switched].reverse()) {
        try {
          if (entry.installed) rmSync(entry.target, { recursive: true, force: true })
          if (entry.backup !== undefined) renameSync(entry.backup, entry.target)
        } catch { notRestored.push(entry.target) }
      }
      // 回滚本身失败时保留临时备份，绝不能由 finally 再删除唯一剩下的旧内容。
      keepStage = notRestored.length > 0
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(keepStage ? `${reason}；回滚未完成：${notRestored.join('、')}；临时备份保留在 ${backup}` : reason)
    }
    result = { ok: true, path: base, count: files.length, overwritten: switched.filter((entry) => entry.backup !== undefined).length }
  } catch (error) {
    result = { ok: false, message: `技能导入失败：${error instanceof Error ? error.message : String(error)}`,
      ...(conflicts.length > 0 && !keepStage ? { code: 'skills-overwrite-required', conflicts } as const : {}) }
  } finally {
    if (stage !== undefined && !keepStage) {
      try { rmSync(stage, { recursive: true, force: true }) } catch (error) {
        const warning = `暂存清理失败，保留在 ${stage}：${error instanceof Error ? error.message : String(error)}`
        if (result?.ok) result.warning = warning
        else if (result !== undefined) result.message += `；${warning}`
      }
    }
  }
  return result!
}

/** 浏览器上传：base64 文件列表；单技能包（无顶层目录）按 frontmatter.name 归类。 */
export function importSkillsPackage(root: string, files: SkillsImportFile[], overwrite: readonly string[] = []): SkillsImportResult {
  try {
    if (typeof root !== 'string' || !Array.isArray(files)) throw new Error('技能目录或文件列表无效')
    const decoded = files.map((file) => {
      if (file === null || typeof file !== 'object' || typeof file.path !== 'string' || typeof file.content !== 'string') throw new Error('技能文件路径与内容必须为字符串')
      const path = file.path.replaceAll('\\', '/')
      if (!safePath(path)) throw new Error(`非法技能文件路径：${path}`)
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
      for (const file of decoded) file.path = `${name}/${file.path}`
    } else {
      // 浏览器会附上被选容器的目录名；已有 <技能>/SKILL.md 时它就是技能本身，不剥离。
      const top = decoded[0]?.path.split('/')[0]
      if (top !== undefined && decoded.every((file) => file.path.startsWith(`${top}/`))
        && !decoded.some((file) => file.path === `${top}/SKILL.md`)) {
        for (const file of decoded) file.path = file.path.slice(top.length + 1)
      }
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
export function importSkillsDirectory(root: string, source: string, overwrite: readonly string[] = []): SkillsImportResult {
  try {
    const directory = assertImportableSource(source)
    const name = basename(directory)
    if (!SKILL_NAME_PATTERN.test(name)) throw new Error('来源目录名称必须是 kebab-case')
    return importFiles(root, readSkillDirectory(directory).map((file) => ({ ...file, path: `${name}/${file.path}` })), overwrite)
  } catch (error) {
    return { ok: false, message: `技能导入失败：${error instanceof Error ? error.message : String(error)}` }
  }
}
