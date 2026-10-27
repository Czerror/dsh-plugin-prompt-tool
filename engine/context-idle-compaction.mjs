import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { importHostCapability } from './host-package.mjs'
import { frameSummary } from './context-summary.mjs'
import { historyEvents } from './history.mjs'

/** 已领取idle维护窗口内的局部事务；Basic.compactRegion仅允许打开的turn。 */
export async function compactIdleRegion({ agent, range, signal, meter, sessions, compaction, pairing }) {
  signal.throwIfAborted()
  const { createUserMessage, errorChain } = await importHostCapability('@deepseek-ai/dsh-llm')
  signal.throwIfAborted()
  const session = agent.session, nodes = session.surface.nodes
  const start = nodes.indexOf(range.start), end = nodes.indexOf(range.end)
  if (start < 0 || end < start || !pairing.toolPairingBalancedBefore(session, range.start)
    || !pairing.toolPairingBalancedAfter(session, range.end)) throw new Error('idle compaction: invalid balanced range')
  const history = historyEvents(session), bySeq = new Map(history.map(event => [event.seq, event]))
  const turn = history.findLast(event => event.type === 'turn/start' || event.type === 'turn/end')
  if (turn?.type === 'turn/start') throw new Error('idle compaction: turn is open')
  const lock = history.findLast(event => ['compaction/start', 'compaction/end', 'session/end-seed'].includes(event.type))
  if (lock?.type === 'compaction/start') throw new Error('idle compaction: already running')
  const seqs = nodes.slice(start, end + 1)
  const selected = meter.measure(session).nodes.slice(start, end + 1)
  if (!isDeepStrictEqual(selected.map(n => n.seq), seqs)) throw new Error('idle compaction: stale pricing')
  const original = seqs.map(seq => bySeq.get(seq))
  if (original.some(event => !event)) throw new Error('idle compaction: source event missing')
  if (original.some(event => event.type === 'system/message')) throw new Error('idle compaction: system head cannot be replaced')
  const messages = original.map(event => session.deriveEventMessage(event)).filter(Boolean)
  const head = bySeq.get(nodes[0])
  if (head?.type === 'system/message') messages.unshift(session.deriveEventMessage(head))
  const header = session.requestHeader()
  const lifecycle = { compactionId: randomUUID(), turn: null }
  const startEvent = session.append('compaction/start', lifecycle)
  let closing = false
  try {
    const summary = await compaction.summarize({ messages, ...(header?.tools ? { tools: header.tools } : {}) }, agent, signal)
    signal.throwIfAborted()
    const current = session.surface.nodes, first = current.indexOf(range.start)
    const currentEvents = new Map(historyEvents(session).map(event => [event.seq, event]))
    if (!isDeepStrictEqual(current.slice(first, first + seqs.length), seqs)
      || !isDeepStrictEqual(seqs.map(seq => currentEvents.get(seq)), original)
      || !isDeepStrictEqual(meter.measure(session).nodes.slice(first, first + seqs.length), selected)) throw new Error('idle compaction: selected surface changed')
    const checkpoint = createUserMessage({ content: frameSummary(summary.summary), source: pairing.compactCheckpointSource(lifecycle.compactionId) })
    if (meter.estimateMessage(checkpoint) >= selected.reduce((sum, node) => sum + node.tokens, 0)) throw new Error('idle compaction: summary is not smaller')
    const shadowedTokenCount = selected.reduce((sum, node) => sum + node.heuristicTokens, 0)
    const summaryEvent = session.append('compaction/summary', { ...summary, compactionId: lifecycle.compactionId,
      shadowedRange: range, shadowedSeqs: seqs, shadowedTokenCount })
    signal.throwIfAborted()
    session.append('user/message', checkpoint, { surfaceOp: { op: 'replace', startSeq: range.start, endSeq: range.end }, sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...seqs] })
    signal.throwIfAborted()
    closing = true
    const endEvent = session.append('compaction/end', lifecycle)
    return { compactionId: lifecycle.compactionId, startSeq: startEvent.seq, summarySeq: summaryEvent.seq, endSeq: endEvent.seq,
      summary: summary.summary, shadowedRange: range, shadowedSeqs: seqs, shadowedTokenCount }
  } catch (error) {
    if (!closing) { closing = true; session.append('compaction/end', { ...lifecycle, error: errorChain(error) }) }
    throw error
  } finally { await sessions.flush(session) }
}
