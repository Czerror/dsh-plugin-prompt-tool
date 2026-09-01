/** AGENTS.md 常驻规则的受管块读写（保留文件其余内容）。 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'

const RESIDENT_AGENTS_BEGIN = '# === prompt-tool managed block begin ==='
const RESIDENT_AGENTS_END = '# === prompt-tool managed block end ==='

interface ManagedBlockEdit {
  /** 去掉受管块之后的原文（保持原换行风格）。 */
  body: string
  /** 是否确实删除了一个完整的受管块。 */
  found: boolean
}

/** 原子写文件（tmp + rename）：受管块写盘防截断与半写，失败保留旧文件。 */
function atomicWriteTextFile(file: string, content: string): void {
  const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`
  writeFileSync(tmp, content, 'utf8')
  renameSync(tmp, file)
}

/** 从正文中删除成对的受管标记块；标记不成对时保持原样，避免误删。 */
function stripManagedBlock(source: string): ManagedBlockEdit {
  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  const normalized = source.replace(/\r\n/g, '\n')
  const lines = normalized.split('\n')
  const start = lines.findIndex((line) => line.trim() === RESIDENT_AGENTS_BEGIN)
  if (start < 0) return { body: source, found: false }
  const end = lines.findIndex((line, index) => index > start && line.trim() === RESIDENT_AGENTS_END)
  if (end < 0) return { body: source, found: false }
  lines.splice(start, end - start + 1)
  return { body: lines.join(eol), found: true }
}

/** 生成要放到文件头部的受管块。 */
function buildManagedBlock(text: string, eol: '\n' | '\r\n'): string {
  const content = text.replace(/\r\n/g, '\n').trim()
  return [RESIDENT_AGENTS_BEGIN, content, RESIDENT_AGENTS_END].join(eol)
}

/** 把 AGENTS.md 内容作为受管块写到目标文件头部，保留文件其余内容。 */
export function writeAgents(text: string, targetPath: string): boolean {
  try {
    mkdirSync(join(targetPath, '..'), { recursive: true })
    const existing = existsSync(targetPath) ? readFileSync(targetPath, 'utf8') : ''
    const eol: '\n' | '\r\n' = existing.includes('\r\n') ? '\r\n' : '\n'
    const stripped = stripManagedBlock(existing)
    const content = text.trim()
    if (content.length === 0) {
      // 关闭或空内容：只删除受管块；本来没有块时不做任何写入。
      if (!stripped.found) return true
      atomicWriteTextFile(targetPath, stripped.body)
      return true
    }
    const rest = stripped.body.replace(/^[\r\n]+/, '')
    const managed = buildManagedBlock(content, eol)
    const next = rest.length > 0 ? managed + eol + rest : managed + eol
    if (next === existing) return true
    atomicWriteTextFile(targetPath, next)
    return true
  } catch {
    return false
  }
}

/** 关闭写入开关后，从目标文件删除本插件的受管块。 */
export function removeResidentAgentsBlock(targetPath: string): boolean {
  try {
    if (!existsSync(targetPath)) return true
    const existing = readFileSync(targetPath, 'utf8')
    const stripped = stripManagedBlock(existing)
    if (!stripped.found) return true
    atomicWriteTextFile(targetPath, stripped.body)
    return true
  } catch {
    return false
  }
}

