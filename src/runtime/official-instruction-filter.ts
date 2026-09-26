/** 官方待注入消息的逐文件过滤；不读取或改写会话历史。 */
const isRecord = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

interface Change {
  path: string
  action: 'set' | 'replace' | 'remove'
  [key: string]: unknown
}

const actionForHeading = (heading: string): Change['action'] =>
  heading === 'Updated instructions from:' ? 'replace'
    : heading === 'Instructions removed:' ? 'remove' : 'set'

/**
 * 路径来自 source.changes；标题仅用于定位正文，不用于恢复官方加载状态。
 * 重复标题、未知包装或来源与段落不一致时原样放行，避免误删其他文件。
 */
export function filterOfficialInstructionMessages(
  messages: unknown[],
  isDisabled: (path: string, source: Record<string, unknown>) => boolean,
): { messages: unknown[]; diagnostics: string[] } {
  const diagnostics: string[] = []
  let changed = false
  const filtered = messages.flatMap((message) => {
    if (!isRecord(message) || !isRecord(message.source) || message.source.kind !== 'agent-instructions') return [message]
    const source = message.source
    if (!Array.isArray(source.changes)) return [message]
    const changes = source.changes as unknown[]
    const disabled = new Set(changes.flatMap(change =>
      isRecord(change) && typeof change.path === 'string' && isDisabled(change.path, source) ? [change.path] : []))
    if (disabled.size === 0) return [message]
    const keepOriginal = () => {
      diagnostics.push(`无法可靠分段官方指令消息 ${String(message.id ?? '')}，已原样放行`)
      return [message]
    }
    if (!changes.every(change => isRecord(change) && typeof change.path === 'string'
      && ['set', 'replace', 'remove'].includes(change.action)) || !Array.isArray(message.content)) return keepOriginal()
    const entries = changes as Change[]
    // 替代基线的移除由共同引言表达，没有逐文件正文区间；不能把正文示例当移除段落。
    if (source.baseline === true && entries.some(entry => entry.action === 'remove')) return keepOriginal()
    const counts = new Map<string, number>()
    const keyOf = (path: string, action: string) => `${action}\0${path}`
    for (const entry of entries) {
      const key = keyOf(entry.path, entry.action)
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    const paths = new Set(entries.map(entry => entry.path))
    const observed = new Map<string, number>()
    const content: unknown[] = []
    for (const block of message.content) {
      if (!isRecord(block) || block.type !== 'text' || typeof block.text !== 'string') return keepOriginal()
      const text = block.text as string
      const close = text.lastIndexOf('\n</system-reminder>')
      if (!text.startsWith('<system-reminder>\n') || close < 0
        || text.slice(close) !== '\n</system-reminder>'
        || text.indexOf('</system-reminder>') !== close + 1) return keepOriginal()
      const headings = [...text.matchAll(/^(Instructions from:|Additional instructions from:|Updated instructions from:|Instructions removed:) ([^\r\n]+)\r?$/gm)]
        .filter(match => paths.has(match[2]!))
      for (const heading of headings) {
        const key = keyOf(heading[2]!, actionForHeading(heading[1]!))
        const count = (observed.get(key) ?? 0) + 1
        if (count > (counts.get(key) ?? 0)) return keepOriginal()
        observed.set(key, count)
      }
      if (!headings.some(heading => disabled.has(heading[2]!))) {
        content.push(block)
        continue
      }
      const kept: string[] = []
      for (const [index, heading] of headings.entries()) {
        const next = headings[index + 1]?.index
        if (next !== undefined && text.slice(next - 2, next) !== '\n\n') return keepOriginal()
        if (!disabled.has(heading[2]!)) kept.push(text.slice(heading.index, next === undefined ? close : next - 2))
      }
      if (kept.length > 0) {
        const body = text.slice(0, headings[0]!.index) + kept.join('\n\n')
        content.push({ ...block, text: body + text.slice(close) })
      }
    }
    for (const [key, count] of counts) {
      if (observed.get(key) !== count) return keepOriginal()
    }
    const remaining = entries.filter(entry => !disabled.has(entry.path))
    changed = true
    if (remaining.length === 0) return []
    return [{ ...message, content, source: { ...source, changes: remaining } }]
  })
  return { messages: changed ? filtered : messages, diagnostics }
}
