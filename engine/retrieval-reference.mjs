import { createHash } from 'node:crypto'

export const MAX_REFERENCE_CHARS = 8192

/** seq 是持久日志身份；不排序为数值区间，也不以相同正文替代。 */
export function sessionReferenceText(events, seqs) {
  if (!Array.isArray(seqs) || seqs.length === 0 || seqs.length > 2048 || new Set(seqs).size !== seqs.length || seqs.some(seq => !Number.isSafeInteger(seq) || seq < 0)) throw new Error('检索引用事件身份无效')
  const bySeq = new Map(events.map(event => [event.seq, event]))
  let bytes = 0
  return seqs.map(seq => {
    const event = bySeq.get(seq)
    if (!event) throw new Error('检索引用已失效')
    const text = JSON.stringify(event)
    bytes += Buffer.byteLength(text)
    if (bytes > 64 * 1024 * 1024) throw new Error('检索引用来源超过64 MiB上限')
    return text
  }).join('\n')
}

export function makeSessionReference(moduleId, sessionId, events, seqs, range = {}) {
  if (typeof moduleId !== 'string' || !moduleId || typeof sessionId !== 'string' || !sessionId) throw new Error('检索引用缺少真实来源身份')
  const text = sessionReferenceText(events, seqs)
  const start = range.start ?? 0, end = range.end ?? Math.min(text.length, start + MAX_REFERENCE_CHARS)
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > text.length || end - start > MAX_REFERENCE_CHARS) throw new Error('检索引用范围无效')
  return { kind: 'session', moduleId, sessionId, seqs: [...seqs], revision: createHash('sha256').update(text).digest('hex'), start, end }
}
