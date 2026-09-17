/** 技能资产操作：创建与回收站删除，全部落在用户技能根（$DSH_HOME/skills）。
 *  技能实体就是 `<根>/<目录名>/SKILL.md`；本模块不写插件状态，也不碰其他来源的技能。 */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Document } from 'yaml'
import { SKILL_NAME_PATTERN } from './skills-config.ts'

export type SkillActionResult = { ok: true; id: string; path: string } | { ok: false; message: string }

/** 拒绝符号链接与其他非普通目录：资产操作只作用于用户自己建的实体目录。 */
function assertPlainDirectory(path: string): void {
  const info = lstatSync(path)
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`技能目录不是普通目录：${path}`)
}

/** 回收站目录（相对技能根），仅用于用户显式删除。 */
const TRASH_SEGMENTS = ['.system', 'prompt-tool', '.trash'] as const

export interface TrashedSkill {
  /** 技能目录在回收站里的完整路径（人工恢复时从这里搬回）。 */
  path: string
  /** 容器目录（含 record.json）；恢复完成后可整体删除。 */
  container: string
}

/** 把技能目录移入回收站：命名唯一、记录来源与时间，可人工恢复。
 *  失败时清理自己刚创建的容器，不在回收站里留下空条目。
 *  自带目录名校验：导出函数不依赖调用方先验，否则直接调用方可以用 '..' 把容器外的目录搬走。 */
export function trashSkill(base: string, folder: string, origin: 'delete'): TrashedSkill {
  if (!SKILL_NAME_PATTERN.test(folder)) throw new Error(`技能目录名不合法：${folder}`)
  const root = resolve(base)
  const recycle = join(root, ...TRASH_SEGMENTS)
  mkdirSync(recycle, { recursive: true })
  const container = mkdtempSync(join(recycle, `${folder}-`))
  try {
    const source = join(root, folder)
    const deletedAt = new Date().toISOString()
    writeFileSync(join(container, 'record.json'), JSON.stringify({
      folder, source, origin, deletedAt, files: readdirSync(source),
    }, null, 2), { flag: 'wx' })
    const path = join(container, folder)
    renameSync(source, path)
    return { path, container }
  } catch (error) {
    try { rmSync(container, { recursive: true, force: true }) } catch { /* 保留现场供人工检查 */ }
    throw error
  }
}

/** 创建标准技能：`<根>/<技能名>/SKILL.md`，frontmatter 只含 name 与 description。 */
export function createSkill(root: string, input: { name: unknown; description: unknown; content: unknown }): SkillActionResult {
  if (input === null || typeof input !== 'object' || typeof input.name !== 'string' || !SKILL_NAME_PATTERN.test(input.name)
    || typeof input.description !== 'string' || input.description.trim().length === 0 || input.description.length > 8192
    || typeof input.content !== 'string' || Buffer.byteLength(input.content) > 1024 * 1024) {
    return { ok: false, message: '技能名须为 kebab-case，描述必填，正文不能超过 1 MiB' }
  }
  const base = resolve(root)
  const target = join(base, input.name)
  let created = false
  try {
    mkdirSync(base, { recursive: true })
    assertPlainDirectory(base)
    if (existsSync(target)) return { ok: false, message: `技能已存在：${input.name}` }
    mkdirSync(target)
    created = true
    const frontmatter = new Document({ name: input.name, description: input.description }).toString()
    writeFileSync(join(target, 'SKILL.md'), `---\n${frontmatter}---\n${input.content}`, { encoding: 'utf8', flag: 'wx' })
    return { ok: true, id: input.name, path: target }
  } catch (error) {
    // 只回收本次 mkdir 成功创建的目录；根校验或同名竞争失败不能删除原有技能。
    try { if (created) rmSync(target, { recursive: true, force: true }) } catch { /* 保留现场供人工检查 */ }
    return { ok: false, message: `创建技能失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

/** 回收站删除：整个技能目录移入 `<根>/.system/prompt-tool/.trash/`，可人工恢复。 */
export function deleteSkill(root: string, folder: string): SkillActionResult {
  if (!SKILL_NAME_PATTERN.test(folder)) return { ok: false, message: '技能目录名不合法' }
  const base = resolve(root)
  const source = join(base, folder)
  try {
    assertPlainDirectory(base)
    if (!existsSync(source)) return { ok: false, message: `技能目录不存在：${folder}` }
    assertPlainDirectory(source)
    if (!existsSync(join(source, 'SKILL.md'))) return { ok: false, message: `不是技能目录（缺少 SKILL.md）：${folder}` }
    const trashed = trashSkill(base, folder, 'delete')
    return { ok: true, id: folder, path: trashed.path }
  } catch (error) {
    return { ok: false, message: `删除技能失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

/** 读取技能标记文件（供预览与测试使用）。 */
export function readSkillMarker(path: string): string {
  return readFileSync(join(path, 'SKILL.md'), 'utf8')
}
