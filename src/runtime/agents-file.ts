/** AGENTS.md 常驻规则的受管块读写（保留文件其余内容）。 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'

const RESIDENT_AGENTS_BEGIN = '# === prompt-tool managed block begin ==='
const RESIDENT_AGENTS_END = '# === prompt-tool managed block end ==='
const BOM = '\uFEFF'

interface ManagedBlockEdit {
  /** 去掉受管块与 BOM 之后的原文（保持原换行风格）。 */
  body: string
  /** 原文件是否带 BOM（写回时恢复到文件头）。 */
  bom: boolean
  /** 是否确实删除了一个完整的受管块。 */
  found: boolean
}

/** 原子写文件（tmp + rename）：受管块写盘防截断与半写，失败保留旧文件。 */
function atomicWriteTextFile(file: string, content: string): void {
  const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`
  writeFileSync(tmp, content, 'utf8')
  renameSync(tmp, file)
}

/**
 * 从正文中删除成对的受管标记块。
 * 只承认文件头部的块（写入端永远置顶）、标记必须整行精确相等：正文里缩进或
 * 同形的行不参与边界判定；标记不成对时保持原样，避免误删用户内容。
 */
function stripManagedBlock(source: string): ManagedBlockEdit {
  const bom = source.startsWith(BOM)
  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  const body = source.slice(bom ? BOM.length : 0)
  const normalized = body.replace(/\r\n/g, '\n')
  const lines = normalized.split('\n')
  if (lines[0] !== RESIDENT_AGENTS_BEGIN) return { body, bom, found: false }
  const end = lines.indexOf(RESIDENT_AGENTS_END, 1)
  if (end < 0) return { body, bom, found: false }
  lines.splice(0, end + 1)
  return { body: lines.join(eol), bom, found: true }
}

/** 生成要放到文件头部的受管块；正文含同形标记行时加反斜杠前缀，避免下次被当块边界。 */
function buildManagedBlock(text: string, eol: '\n' | '\r\n'): string {
  const content = text.replace(/\r\n/g, '\n').trim()
    .split('\n')
    .map((line) => (line === RESIDENT_AGENTS_BEGIN || line === RESIDENT_AGENTS_END ? `\\${line}` : line))
    .join(eol)
  return [RESIDENT_AGENTS_BEGIN, content, RESIDENT_AGENTS_END].join(eol)
}

/** 把 AGENTS.md 内容作为受管块写到目标文件头部，保留文件其余内容。 */
export function writeAgents(text: string, targetPath: string): boolean {
  try {
    mkdirSync(dirname(targetPath), { recursive: true })
    const existing = existsSync(targetPath) ? readFileSync(targetPath, 'utf8') : ''
    const eol: '\n' | '\r\n' = existing.includes('\r\n') ? '\r\n' : '\n'
    const stripped = stripManagedBlock(existing)
    const bom = stripped.bom ? BOM : ''
    const content = text.trim()
    if (content.length === 0) {
      // 关闭或空内容：只删除受管块；本来没有块时不做任何写入。
      if (!stripped.found) return true
      atomicWriteTextFile(targetPath, bom + stripped.body)
      return true
    }
    const rest = stripped.body.replace(/^[\r\n]+/, '')
    const managed = buildManagedBlock(content, eol)
    const next = bom + (rest.length > 0 ? managed + eol + rest : managed + eol)
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
    atomicWriteTextFile(targetPath, (stripped.bom ? BOM : '') + stripped.body)
    return true
  } catch {
    return false
  }
}

