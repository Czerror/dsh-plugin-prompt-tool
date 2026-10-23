/**
 * 技能文件的读取前校验：路径、marker 名、祖先链、普通文件、可写位与 1 MiB 上限。
 *
 * content 与 policy 两个写者共用这一份；业务切片（正文 vs 逐字 frontmatter）仍各留各的。
 */
import { lstatSync, readFileSync } from 'node:fs'
import { basename, isAbsolute } from 'node:path'
import { MAX_SKILL_CONTENT_BYTES, SKILL_MARKER } from '../shared/skills.ts'
import { parseFrontmatter, type SkillFrontmatterParse } from './skills-parse.ts'
import { assertUnlinkedPath } from './skills-actions.ts'
import { SKILL_NAME_PATTERN } from './skills-config.ts'

export interface SkillMarkerFile {
  /** 原文（含 BOM）；冲突比较与写回都按逐字保留。 */
  raw: string
  /** 唯一一份 frontmatter 解析的结果；失败由调用方决定先报冲突还是先报解析。 */
  parse: SkillFrontmatterParse
  /** 权限位（0o777）；写盘时原样保留。 */
  mode: number
}

/** 读技能文件并完成所有文件级校验；读写共用同一判据，上限不可关闭。 */
export function readSkillMarker(file: string, options: { writable?: boolean } = {}): SkillMarkerFile {
  if (typeof file !== 'string' || file.length === 0 || !isAbsolute(file)) throw new Error('技能文件必须是绝对路径')
  const name = basename(file)
  if (name !== SKILL_MARKER && !(name.endsWith('.md') && SKILL_NAME_PATTERN.test(name.slice(0, -3)))) {
    throw new Error(`技能文件必须是 ${SKILL_MARKER} 或合法的 <name>.md：${file}`)
  }
  // assertUnlinkedPath 已拒绝目标与祖先中的链接；这里只判普通文件。
  assertUnlinkedPath(file)
  const info = lstatSync(file)
  if (!info.isFile()) throw new Error(`技能文件不是普通文件：${file}`)
  if (info.size > MAX_SKILL_CONTENT_BYTES) throw new Error('技能文件不能超过 1 MiB')
  if (options.writable === true && (info.mode & 0o222) === 0) throw new Error(`技能文件只读：${file}`)
  const raw = readFileSync(file, 'utf8')
  // stat 与读后字节都查：多字节文本的字节数与字符数不同，读后再确认一次。
  if (Buffer.byteLength(raw, 'utf8') > MAX_SKILL_CONTENT_BYTES) throw new Error('技能文件不能超过 1 MiB')
  return { raw, parse: parseFrontmatter(raw), mode: info.mode & 0o777 }
}
