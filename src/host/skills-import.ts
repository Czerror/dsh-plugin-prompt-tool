/** 技能导入：资源物化至 skills/.system，并同步受管配置。 */
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { parseFrontmatter } from '../runtime/skills-parse.ts'
import { isSafeSkillPath, type SkillsConfig } from './skills-config.ts'
import { updateSkillsLibrary } from './skills-library.ts'

export interface SkillsImportFile { path?: unknown; content?: unknown }
export type SkillsImportResult = { ok: true; path: string; count: number } | { ok: false; message: string }
export interface SkillFile { path: string; buffer: Buffer }
const key = (path: string): string => process.platform === 'win32' ? path.toLowerCase() : path
const MAX_FILES = 10_000
const MAX_BYTES = 64 * 1024 * 1024

function safePath(path: string): boolean {
  const parts = path.split('/')
  return path.length > 0 && path.length <= 2048 && parts.every((part) => part.length > 0 && part !== '.' && part !== '..' && !/[<>:"|?*]/u.test(part) && !/[. ]$/.test(part) && ![...part].some((c) => c.charCodeAt(0) < 32) && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part)) && !['.system', '.skills-migration'].includes(parts[0] ?? '')
}

export function assertSkillDirectory(path: string): void {
  const info = lstatSync(path)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`技能目录不是普通目录：${path}`)
}

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

export function skillFilesHash(files: SkillFile[]): string {
  const hash = createHash('sha256')
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) hash.update(`${file.path}\0`).update(file.buffer)
  return hash.digest('hex')
}

function registerImported(config: SkillsConfig, files: SkillFile[], source: string): void {
  const links = new Set(Object.values(config.skills).map((record) => key(record.link)))
  for (const file of files.filter((item) => item.path.endsWith('/SKILL.md'))) {
    const path = file.path.slice(0, -'/SKILL.md'.length)
    if (!isSafeSkillPath(path)) throw new Error(`非法技能实体路径：${path}`)
    const prior = Object.entries(config.skills).find(([, record]) => key(record.path) === key(path))
    if (prior !== undefined) continue
    const parsed = parseFrontmatter(file.buffer.toString('utf8'))
    if (parsed.issue !== undefined) throw new Error(`${path}：${parsed.issue}`)
    if (typeof parsed.data.name !== 'string' || typeof parsed.data.description !== 'string' || parsed.data.name.length === 0 || parsed.data.description.length === 0) throw new Error(`${path}：frontmatter 必须包含 name 与 description`)
    let link = path.replaceAll('/', '--')
    if (links.has(key(link))) link = `${link}-${createHash('sha256').update(path).digest('hex').slice(0, 12)}`
    config.skills[path] = { path, link, enabled: true, modelInvocable: parsed.data.disableModelInvocation !== true, userInvocable: parsed.data.userInvocable !== false, source }
    if (!config.order.includes(path)) config.order.push(path)
    links.add(key(link))
  }
  if (files.every((item) => !item.path.endsWith('/SKILL.md'))) throw new Error('导入目录内未找到 SKILL.md')
}

function importFiles(skillsDir: string, files: SkillFile[], source: string, overwrite: boolean): SkillsImportResult {
  const root = resolve(skillsDir)
  let stage: string | undefined
  try {
    if (files.length === 0) throw new Error('未收到技能文件')
    for (const file of files) {
      const path = file.path.replaceAll('\\', '/')
      if (!safePath(path) || !path.includes('/')) throw new Error(`非法技能文件路径：${path}`)
    }
    mkdirSync(root, { recursive: true })
    assertSkillDirectory(root)
    const system = join(root, '.system')
    mkdirSync(system, { recursive: true })
    assertSkillDirectory(system)
    const seen = new Set<string>()
    let bytes = 0
    for (const file of files) {
      const path = file.path.replaceAll('\\', '/')
      file.path = path
      if (!safePath(path) || !path.includes('/')) throw new Error(`非法技能文件路径：${path}`)
      if (seen.has(key(path))) throw new Error(`重复技能文件路径：${path}`)
      seen.add(key(path))
      bytes += file.buffer.length
    }
    if (files.length === 0 || files.length > MAX_FILES || bytes > MAX_BYTES) throw new Error('未收到技能文件或导入超过文件数/容量上限')
    stage = mkdtempSync(join(root, '.skills-import-'))
    for (const file of files) { const target = join(stage, file.path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, file.buffer, { flag: 'wx' }) }
    const top = new Set(files.map((file) => file.path.split('/')[0]).filter((name): name is string => name !== undefined))
    const backups: Array<[string, string]> = []
    const restore = (): void => {
      for (const [target, backup] of [...backups].reverse()) {
        if (existsSync(target)) rmSync(target, { recursive: true, force: true })
        if (existsSync(backup)) renameSync(backup, target)
      }
    }
    const result = updateSkillsLibrary(root, (config) => {
      for (const name of top) {
        const target = join(system, name)
        const managed = Object.values(config.skills).some((record) => key(record.path) === key(name) || key(record.path).startsWith(`${key(name)}/`))
        if (existsSync(target) && (!overwrite || !managed)) throw new Error(`拒绝覆盖未受管或已存在技能：${name}`)
        if (existsSync(target)) { const backup = join(stage!, `.backup-${name}`); renameSync(target, backup); backups.push([target, backup]) }
        renameSync(join(stage!, name), target)
      }
      registerImported(config, files, source)
      return config
    }, undefined, { rollback: restore })
    if (!result.ok) throw new Error(result.message)
    for (const [, backup] of backups) rmSync(backup, { recursive: true, force: true })
    return { ok: true, path: system, count: files.length }
  } catch (error) {
    return { ok: false, message: `技能导入失败：${error instanceof Error ? error.message : String(error)}` }
  } finally { if (stage !== undefined) rmSync(stage, { recursive: true, force: true }) }
}

export function importSkillsPackage(skillsDir: string, files: SkillsImportFile[], overwrite = true): SkillsImportResult {
  try {
    if (typeof skillsDir !== 'string' || !Array.isArray(files)) throw new Error('技能目录或文件列表无效')
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
      if (!isSafeSkillPath(name, true)) throw new Error('单技能包 frontmatter.name 不合法')
      for (const file of decoded) if (!file.path.includes('/')) file.path = `${name}/${file.path}`
    }
    return importFiles(skillsDir, decoded, 'import', overwrite)
  } catch (error) { return { ok: false, message: error instanceof Error ? error.message : String(error) } }
}

export function importSkillsDirectory(skillsDir: string, source: string): SkillsImportResult {
  try {
    const directory = resolve(source)
    const name = basename(directory)
    if (!isSafeSkillPath(name, true)) throw new Error('来源目录名称不合法')
    return importFiles(skillsDir, readSkillDirectory(directory).map((file) => ({ ...file, path: `${name}/${file.path}` })), directory, true)
  } catch (error) { return { ok: false, message: error instanceof Error ? error.message : String(error) } }
}
