/** 技能插件状态：屏蔽表 + 引用的技能文件夹（注册层屏蔽模型，v3）。
 *  技能实体始终留在官方各技能根里；本文件只记录"哪些技能名不注册给 dsh"和"用户添加了哪些技能文件夹"。 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { Document, isMap, parseDocument, visit } from 'yaml'
import type { BlockedSkill, SkillsState } from '../shared/skills.ts'
import { SKILLS_STATE_VERSION } from '../shared/skills.ts'
import { DSH_HOME } from './paths.ts'

export const SKILLS_STATE_RELATIVE = join('skills', '.system', 'prompt-tool', 'skills.yml')
/** 与官方 `SKILL_NAME` 同规则；屏蔽记录按技能名匹配，必须是合法技能名。 */
export const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const MAX_FOLDERS = 200
const MAX_BLOCKED = 5_000

export type SkillsStateRead =
  | { ok: true; state: SkillsState; exists: boolean }
  | { ok: false; state: SkillsState; message: string }

export function defaultSkillsState(): SkillsState {
  return { version: SKILLS_STATE_VERSION, blocked: [], folders: [] }
}

export function skillsStatePath(dshHome: string = DSH_HOME): string {
  return join(dshHome, SKILLS_STATE_RELATIVE)
}

const pathKey = (value: string): string => process.platform === 'win32' ? value.toLowerCase() : value

function readBlocked(value: unknown): BlockedSkill[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('blocked 必须是数组')
  if (value.length > MAX_BLOCKED) throw new Error('blocked 记录过多')
  const seen = new Set<string>()
  return value.map((item) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) throw new Error('blocked 记录必须是映射')
    const record = item as Record<string, unknown>
    if (typeof record.name !== 'string' || !SKILL_NAME_PATTERN.test(record.name)) throw new Error(`屏蔽记录的技能名不合法：${String(record.name)}`)
    if (typeof record.at !== 'string' || record.at.length === 0) throw new Error(`屏蔽记录缺少时间：${record.name}`)
    if (record.note !== undefined && (typeof record.note !== 'string' || record.note.length > 512)) throw new Error(`屏蔽记录备注不合法：${record.name}`)
    if (seen.has(record.name)) throw new Error(`屏蔽记录重复：${record.name}`)
    seen.add(record.name)
    return { name: record.name, at: record.at, ...(record.note === undefined ? {} : { note: record.note }) }
  })
}

function readFolders(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('folders 必须是数组')
  if (value.length > MAX_FOLDERS) throw new Error('引用的技能文件夹过多')
  const seen = new Set<string>()
  return value.map((item) => {
    if (typeof item !== 'string' || item.length === 0 || item.length > 1024) throw new Error('引用的技能文件夹必须是路径字符串')
    if (!isAbsolute(item)) throw new Error(`引用的技能文件夹必须是绝对路径：${item}`)
    const absolute = resolve(item)
    if (seen.has(pathKey(absolute))) throw new Error(`引用的技能文件夹重复：${absolute}`)
    seen.add(pathKey(absolute))
    return absolute
  })
}

/** 读写共用校验：非法状态不获得文件系统写入权限。 */
export function validateSkillsState(value: unknown): SkillsState {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('技能状态必须是映射')
  const data = value as Record<string, unknown>
  if (data.version !== undefined && data.version !== SKILLS_STATE_VERSION) throw new Error(`不支持的技能状态版本：${String(data.version)}`)
  return { version: SKILLS_STATE_VERSION, blocked: readBlocked(data.blocked), folders: readFolders(data.folders) }
}

function stateDocument(raw: string): Document {
  const doc = parseDocument(raw)
  if (doc.errors.length > 0) throw new Error(`技能状态不是合法 YAML：${doc.errors[0]?.message ?? '解析失败'}`)
  if (!isMap(doc.contents)) throw new Error('技能状态必须是 YAML 映射')
  visit(doc, { Alias() { throw new Error('技能状态不支持 YAML 别名') } })
  validateSkillsState(doc.toJS())
  return doc
}

export function readSkillsState(file: string = skillsStatePath()): SkillsStateRead {
  try {
    if (!existsSync(file)) return { ok: true, state: defaultSkillsState(), exists: false }
    return { ok: true, state: validateSkillsState(stateDocument(readFileSync(file, 'utf8')).toJS()), exists: true }
  } catch (error) {
    return { ok: false, state: defaultSkillsState(), message: `读取技能状态失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

/** 写状态：Document API 保留注释与未知字段；内容无变化时不落盘；写前核对版本，失败清理暂存文件。 */
export function writeSkillsState(
  patch: Partial<Pick<SkillsState, 'blocked' | 'folders'>>,
  file: string = skillsStatePath(),
  expectedContent?: string | null,
): SkillsStateRead {
  let temporary: string | undefined
  try {
    const raw = existsSync(file) ? readFileSync(file, 'utf8') : null
    if (expectedContent !== undefined && raw !== expectedContent) throw new Error('技能状态内容版本冲突，请刷新后重试')
    const doc = raw === null ? new Document({ version: SKILLS_STATE_VERSION }) : stateDocument(raw)
    const current = raw === null ? defaultSkillsState() : validateSkillsState(doc.toJS())
    const next = validateSkillsState({
      version: SKILLS_STATE_VERSION,
      blocked: patch.blocked ?? current.blocked,
      folders: patch.folders ?? current.folders,
    })
    if (patch.blocked !== undefined) {
      if (next.blocked.length === 0) doc.delete('blocked')
      else doc.set('blocked', doc.createNode(next.blocked.map((item) => ({
        name: item.name, at: item.at, ...(item.note === undefined ? {} : { note: item.note }),
      }))))
    }
    if (patch.folders !== undefined) {
      if (next.folders.length === 0) doc.delete('folders')
      else doc.set('folders', doc.createNode(next.folders))
    }
    const content = doc.toString()
    if (content !== raw) {
      mkdirSync(dirname(file), { recursive: true })
      temporary = `${file}.tmp-${randomUUID()}`
      writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx' })
      if ((existsSync(file) ? readFileSync(file, 'utf8') : null) !== raw) throw new Error('技能状态内容版本冲突，请刷新后重试')
      renameSync(temporary, file)
      temporary = undefined
    }
    return { ok: true, state: next, exists: true }
  } catch (error) {
    return { ok: false, state: defaultSkillsState(), message: `写入技能状态失败：${error instanceof Error ? error.message : String(error)}` }
  } finally {
    if (temporary !== undefined && existsSync(temporary)) unlinkSync(temporary)
  }
}
