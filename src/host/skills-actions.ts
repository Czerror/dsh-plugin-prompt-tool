/** 受管技能创建与回收站删除。 */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Document } from 'yaml'
import { SKILL_NAME_RE } from '../runtime/skills-provider.ts'
import { isSafeSkillPath } from './skills-config.ts'
import { assertSkillDirectory, importSkillsPackage } from './skills-import.ts'
import { updateSkillsLibrary } from './skills-library.ts'

export type SkillActionResult = { ok: true; id: string; path: string } | { ok: false; message: string }

export function createManagedSkill(root: string, input: { name: unknown; description: unknown; content: unknown }): SkillActionResult {
  if (input === null || typeof input !== 'object' || typeof input.name !== 'string' || !SKILL_NAME_RE.test(input.name)
    || typeof input.description !== 'string' || input.description.trim().length === 0 || input.description.length > 8192
    || typeof input.content !== 'string' || Buffer.byteLength(input.content) > 1024 * 1024) {
    return { ok: false, message: '技能名须为 kebab-case，描述必填，正文不能超过 1 MiB' }
  }
  const frontmatter = new Document({ name: input.name, description: input.description }).toString()
  const text = `---\n${frontmatter}---\n${input.content}`
  const result = importSkillsPackage(root, [{ path: `${input.name}/SKILL.md`, content: Buffer.from(text).toString('base64') }], false)
  return result.ok ? { ok: true, id: input.name, path: join(resolve(root), '.system', input.name) } : result
}

export function deleteManagedSkill(root: string, id: string): SkillActionResult {
  if (!isSafeSkillPath(id)) return { ok: false, message: '技能身份不合法' }
  let trash: string | undefined
  let marker: string | undefined
  let moved = false
  const restore = (): void => {
    if (moved && trash !== undefined && marker !== undefined && !existsSync(marker)) {
      renameSync(join(trash, 'SKILL.md'), marker)
      moved = false
    }
  }
  const result = updateSkillsLibrary(root, (config) => {
    const record = config.skills[id]
    if (record === undefined) throw new Error('技能不在受管库中')
    let entity = join(resolve(root), '.system')
    assertSkillDirectory(entity)
    for (const part of record.path.split('/')) { entity = join(entity, part); assertSkillDirectory(entity) }
    marker = join(entity, 'SKILL.md')
    const info = lstatSync(marker)
    if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1) throw new Error('技能标记不是独立普通文件')
    const recycle = join(resolve(root), '.system', '.trash')
    mkdirSync(recycle, { recursive: true })
    trash = mkdtempSync(join(recycle, 'skill-'))
    writeFileSync(join(trash, 'record.json'), JSON.stringify({ id, record, marker, deletedAt: new Date().toISOString(), content: readFileSync(marker, 'utf8') }), { flag: 'wx' })
    renameSync(marker, join(trash, 'SKILL.md'))
    moved = true
    delete config.skills[id]
    config.order = config.order.filter((item) => item !== id)
    return config
  }, undefined, { rollback: restore })
  if (!result.ok) {
    if (moved && trash !== undefined && marker !== undefined && !existsSync(marker)) {
      try { renameSync(join(trash, 'SKILL.md'), marker) } catch { /* 保留回收站证据 */ }
    }
    if (trash !== undefined && !moved) rmSync(trash, { recursive: true, force: true })
    return { ok: false, message: result.message }
  }
  return { ok: true, id, path: trash! }
}
