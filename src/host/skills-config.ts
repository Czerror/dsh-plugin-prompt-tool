/** 技能插件状态（v4）：只保存用户显式引用的技能文件夹。
 *
 *  调用策略（模型端 / 用户端是否可调用）写在技能文件自己的 frontmatter 里，不进状态文件。
 *  v3 的 `blocked` 屏蔽表已弃用（注册层影子候选被最近层覆盖，见 docs/skills-management.md）：
 *  读取时忽略该键，写入时删除它——留着一个不再生效的键只会误导。 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { Document, isMap, parseDocument, visit } from 'yaml'
import type { SkillsState } from '../shared/skills.ts'
import { SKILLS_STATE_VERSION } from '../shared/skills.ts'
import { DSH_HOME } from './paths.ts'

export const SKILLS_STATE_RELATIVE = join('skills', '.system', 'prompt-tool', 'skills.yml')
/** 与官方 `SKILL_NAME` 同规则；技能目录名、引用校验与调用策略写入共用。 */
export const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const MAX_FOLDERS = 200

export type SkillsStateRead =
  | { ok: true; state: SkillsState; exists: boolean }
  | { ok: false; state: SkillsState; message: string }

export function defaultSkillsState(): SkillsState {
  return { version: SKILLS_STATE_VERSION, folders: [] }
}

export function skillsStatePath(dshHome: string = DSH_HOME): string {
  return join(dshHome, SKILLS_STATE_RELATIVE)
}

const pathKey = (value: string): string => process.platform === 'win32' ? value.toLowerCase() : value

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

/** 读写共用校验：非法状态不获得文件系统写入权限。
 *  接受缺失版本、v3（`blocked` 一并忽略，不校验其内容——它已经不影响任何行为）与 v4。 */
export function validateSkillsState(value: unknown): SkillsState {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('技能状态必须是映射')
  const data = value as Record<string, unknown>
  if (data.version !== undefined && data.version !== 3 && data.version !== SKILLS_STATE_VERSION) {
    throw new Error(`不支持的技能状态版本：${String(data.version)}`)
  }
  return { version: SKILLS_STATE_VERSION, folders: readFolders(data.folders) }
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

/** 写状态：Document API 保留注释与未知字段；内容无变化时不落盘；写前核对版本，失败清理暂存文件。
 *  版本号一并抬到 v4，并删除 v3 留下的 `blocked` 键。 */
export function writeSkillsState(
  patch: Partial<Pick<SkillsState, 'folders'>>,
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
      folders: patch.folders ?? current.folders,
    })
    doc.set('version', SKILLS_STATE_VERSION)
    doc.delete('blocked')
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
