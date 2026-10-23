/** 技能描述与正文编辑：保留其余 frontmatter，按完整原文摘要拒绝覆盖外部修改。 */
import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { MAX_SKILL_CONTENT_BYTES, type SkillCatalogEntry, type SkillContentSnapshot } from '../shared/skills.ts'
import { parseSkillBoolean } from './skills-parse.ts'
import { SKILL_NAME_PATTERN } from './skills-config.ts'
import { skillWriteRestriction } from './skills-scan.ts'
import { readSkillMarker, type SkillMarkerFile } from './skills-marker.ts'
import { replaceVersionedText } from './versioned-text.ts'

export type SkillContentResult =
  | ({ ok: true; changed?: boolean } & SkillContentSnapshot)
  | { ok: false; message: string }

type Catalog = () => readonly SkillCatalogEntry[]
const revisionOf = (content: string): string => createHash('sha256').update(content).digest('hex')
const failure = (error: unknown): SkillContentResult => ({ ok: false, message: error instanceof Error ? error.message : String(error) })

/** catalog 身份与可编辑性；文件级校验与解析走 `readSkillMarker` 同一份。 */
function assertTarget(catalog: Catalog, name: string, path: string, writable = false): void {
  if (typeof name !== 'string' || name.length === 0 || typeof path !== 'string' || !isAbsolute(path)) throw new Error('技能名与绝对路径必填')
  const entry = catalog().find((skill) => skill.name === name && skill.path === path)
  if (entry === undefined) throw new Error('技能或引用目录已变化，请刷新后重试')
  if (writable && entry.canEdit !== true) throw new Error(entry.readonlyReason ?? '该技能只读')
  if (writable) {
    const restriction = skillWriteRestriction(path)
    if (restriction !== undefined) throw new Error(restriction)
  }
}

function parseMarker(marker: SkillMarkerFile) {
  if (!marker.parse.ok) throw new Error(marker.parse.issue)
  const { raw } = marker
  const { doc, bom, body, boundaries } = marker.parse.source
  const declared = doc.get('name')
  if (typeof declared !== 'string' || !SKILL_NAME_PATTERN.test(declared)) throw new Error('技能名须为 kebab-case')
  // 缺描述的条目在清单中回退目录名；只修改描述，不重写原文里的合法 name。
  const description = doc.get('description') ?? ''
  if (typeof description !== 'string') throw new Error('技能描述必须是字符串')
  for (const key of ['disable-model-invocation', 'user-invocable']) {
    if (doc.has(key)) parseSkillBoolean(doc.get(key), key)
  }
  const spacing = /^(?:[\t ]*\r?\n)*/.exec(body)![0]
  return {
    doc, description,
    // 原 frontmatter 块（含 BOM 与分隔线）＝ 原文去掉正文；其余片段由边界原文派生。
    head: raw.slice(0, raw.length - body.length),
    start: bom + boundaries.open,
    newline: boundaries.open.slice(3),
    separator: /\r?\n/.exec(boundaries.tail)?.[0] ?? '',
    spacing,
    content: body.slice(spacing.length),
  }
}

export function readSkillContent(catalog: Catalog, name: string, path: string): SkillContentResult {
  try {
    assertTarget(catalog, name, path)
    const marker = readSkillMarker(path)
    const { content, description } = parseMarker(marker)
    return { ok: true, content, description, revision: revisionOf(marker.raw) }
  } catch (error) { return failure(error) }
}

export function writeSkillContent(catalog: Catalog, name: string, path: string, content: string, description: string, expectedRevision: string): SkillContentResult {
  try {
    if (typeof expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(expectedRevision)) throw new Error('缺少有效的技能内容版本')
    if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > MAX_SKILL_CONTENT_BYTES) throw new Error('技能内容必须是字符串且不能超过 1 MiB')
    if (typeof description !== 'string' || description.trim().length === 0 || description.length > 8192) throw new Error('技能描述必填且不能超过 8192 字符')
    assertTarget(catalog, name, path, true)
    const beforeMarker = readSkillMarker(path, { writable: true })
    const before = beforeMarker.raw
    if (revisionOf(before) !== expectedRevision) throw new Error('技能内容版本冲突，请重新读取后重试')
    const parsed = parseMarker(beforeMarker)
    let head = parsed.head
    if (description !== parsed.description) {
      parsed.doc.set('description', description)
      head = `${parsed.start}${parsed.doc.toString().replace(/\n/g, parsed.newline)}---${parsed.separator}`
    }
    // 原头没有末尾换行时，新增正文仍须与 --- 分隔线隔开。
    const raw = head + (content.length > 0 && parsed.separator === '' ? parsed.newline : '') + parsed.spacing + content
    if (Buffer.byteLength(raw, 'utf8') > MAX_SKILL_CONTENT_BYTES) throw new Error('技能文件不能超过 1 MiB')
    if (raw === before) return { ok: true, content, description, revision: expectedRevision, changed: false }
    replaceVersionedText({
      file: path,
      expectedRevision,
      read: () => {
        assertTarget(catalog, name, path, true)
        const current = readSkillMarker(path, { writable: true })
        return { revision: revisionOf(current.raw), value: current.raw, text: current.raw, mode: current.mode }
      },
      prepare: () => raw,
      recheck: current => {
        if (current !== before) throw new Error('技能内容版本冲突，请重新读取后重试')
      },
      conflict: () => new Error('技能内容版本冲突，请重新读取后重试'),
    })
    return { ok: true, content, description, revision: revisionOf(raw), changed: true }
  } catch (error) { return failure(error) }
}
