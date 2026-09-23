/** 技能描述与正文编辑：保留其余 frontmatter，按完整原文摘要拒绝覆盖外部修改。 */
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { basename, isAbsolute } from 'node:path'
import { isMap, parseDocument, visit } from 'yaml'
import { MAX_SKILL_CONTENT_BYTES, SKILL_MARKER, type SkillCatalogEntry, type SkillContentSnapshot } from '../shared/skills.ts'
import { parseSkillBoolean } from '../runtime/skills-parse.ts'
import { assertUnlinkedPath } from './skills-actions.ts'
import { SKILL_NAME_PATTERN } from './skills-config.ts'
import { skillWriteRestriction } from './skills-scan.ts'
import { atomicWriteTextFile } from './text-file.ts'

export type SkillContentResult =
  | ({ ok: true; changed?: boolean } & SkillContentSnapshot)
  | { ok: false; message: string }

type Catalog = () => readonly SkillCatalogEntry[]
const revisionOf = (content: string): string => createHash('sha256').update(content).digest('hex')
const failure = (error: unknown): SkillContentResult => ({ ok: false, message: error instanceof Error ? error.message : String(error) })
const FRONTMATTER = /^(\ufeff?---(\r?\n))([\s\S]*?)\r?\n---(\r?\n|$)/

function assertTarget(catalog: Catalog, name: string, path: string, writable = false): void {
  if (typeof name !== 'string' || name.length === 0 || typeof path !== 'string' || !isAbsolute(path)) throw new Error('技能名与绝对路径必填')
  const entry = catalog().find((skill) => skill.name === name && skill.path === path)
  if (entry === undefined) throw new Error('技能或引用目录已变化，请刷新后重试')
  if (writable && entry.canEdit !== true) throw new Error(entry.readonlyReason ?? '该技能只读')
  const filename = basename(path)
  if (filename !== SKILL_MARKER && !(filename.endsWith('.md') && SKILL_NAME_PATTERN.test(filename.slice(0, -3)))) throw new Error('不是受支持的技能文件')
  assertUnlinkedPath(path)
  const info = lstatSync(path)
  if (!info.isFile()) throw new Error('技能标记不是普通文件')
  if (info.size > MAX_SKILL_CONTENT_BYTES) throw new Error('技能文件不能超过 1 MiB')
  if (writable) {
    const restriction = skillWriteRestriction(path)
    if (restriction !== undefined) throw new Error(restriction)
  }
}

function readContent(path: string): string {
  const content = readFileSync(path, 'utf8')
  if (Buffer.byteLength(content, 'utf8') > MAX_SKILL_CONTENT_BYTES) throw new Error('技能文件不能超过 1 MiB')
  return content
}

function parseMarker(raw: string) {
  const match = FRONTMATTER.exec(raw)
  if (match === null) throw new Error('技能文件缺少有效 frontmatter')
  const doc = parseDocument(match[3]!)
  if (doc.errors.length > 0) throw new Error(`frontmatter 不是合法 YAML：${doc.errors[0]?.message ?? '解析失败'}`)
  if (!isMap(doc.contents)) throw new Error('frontmatter 必须是 YAML 映射')
  visit(doc, { Alias() { throw new Error('frontmatter 不支持 YAML 别名') } })
  const declared = doc.get('name')
  if (typeof declared !== 'string' || !SKILL_NAME_PATTERN.test(declared)) throw new Error('技能名须为 kebab-case')
  // 缺描述的条目在清单中回退目录名；只修改描述，不重写原文里的合法 name。
  const description = doc.get('description') ?? ''
  if (typeof description !== 'string') throw new Error('技能描述必须是字符串')
  for (const key of ['disableModelInvocation', 'modelInvocable', 'userInvocable']) {
    if (doc.has(key)) throw new Error(`frontmatter field "${key}" is unsupported`)
  }
  for (const key of ['disable-model-invocation', 'user-invocable']) {
    if (doc.has(key)) parseSkillBoolean(doc.get(key), key)
  }
  const body = raw.slice(match[0].length)
  const spacing = /^(?:[\t ]*\r?\n)*/.exec(body)![0]
  return { doc, description, head: match[0], start: match[1]!, newline: match[2]!, separator: match[4]!, spacing, content: body.slice(spacing.length) }
}

export function readSkillContent(catalog: Catalog, name: string, path: string): SkillContentResult {
  try {
    assertTarget(catalog, name, path)
    const raw = readContent(path)
    const { content, description } = parseMarker(raw)
    return { ok: true, content, description, revision: revisionOf(raw) }
  } catch (error) { return failure(error) }
}

export function writeSkillContent(catalog: Catalog, name: string, path: string, content: string, description: string, expectedRevision: string): SkillContentResult {
  try {
    if (typeof expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(expectedRevision)) throw new Error('缺少有效的技能内容版本')
    if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > MAX_SKILL_CONTENT_BYTES) throw new Error('技能内容必须是字符串且不能超过 1 MiB')
    if (typeof description !== 'string' || description.trim().length === 0 || description.length > 8192) throw new Error('技能描述必填且不能超过 8192 字符')
    assertTarget(catalog, name, path, true)
    const before = readContent(path)
    if (revisionOf(before) !== expectedRevision) throw new Error('技能内容版本冲突，请重新读取后重试')
    const parsed = parseMarker(before)
    let head = parsed.head
    if (description !== parsed.description) {
      parsed.doc.set('description', description)
      head = `${parsed.start}${parsed.doc.toString().replace(/\n/g, parsed.newline)}---${parsed.separator}`
    }
    // 原头没有末尾换行时，新增正文仍须与 --- 分隔线隔开。
    const raw = head + (content.length > 0 && parsed.separator === '' ? parsed.newline : '') + parsed.spacing + content
    if (Buffer.byteLength(raw, 'utf8') > MAX_SKILL_CONTENT_BYTES) throw new Error('技能文件不能超过 1 MiB')
    if (raw === before) return { ok: true, content, description, revision: expectedRevision, changed: false }
    atomicWriteTextFile(path, raw, {
      mode: lstatSync(path).mode & 0o777,
      beforeReplace: () => {
        assertTarget(catalog, name, path, true)
        if (readContent(path) !== before) throw new Error('技能内容版本冲突，请重新读取后重试')
      },
    })
    return { ok: true, content, description, revision: revisionOf(raw), changed: true }
  } catch (error) { return failure(error) }
}
