import { makeSessionReference } from './retrieval-reference.mjs'

// shortcut: Basic alpha.2 未公开导出frameSummary，升级官方framing时同步此版本化快照。
const CHECKPOINT_OPEN = 'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.\n\n<compacted-summary>'
export function frameSummary(summary) {
  return [{ type: 'text', text: CHECKPOINT_OPEN }, ...summary, { type: 'text', text: '</compacted-summary>' }]
}
const framed = summary => ({
  id: 'context-provenance-budget', role: 'user', source: { kind: 'compact-checkpoint', compactionId: 'context-provenance-budget' },
  content: frameSummary(summary),
})

function sourceSnapshot(input, session, meter) {
  const events = session.snapshotEvents(), bySeq = new Map(events.map(event => [event.seq, event]))
  const nodes = session.surface.nodes.map(seq => {
    const event = bySeq.get(seq)
    if (!event) throw new Error('source event missing')
    return { seq, message: session.deriveEventMessage(event) }
  })
  let messages = input.messages
  const head = nodes[0]?.message
  // Basic 把system头作为缓存前缀再加一次；真正选中system时后面仍保留它。
  if (head?.role === 'system' && messages[0]?.id === head.id) messages = messages.slice(1)
  if (!messages.length || messages.some(message => typeof message.id !== 'string' || !message.id)) throw new Error('source message identity unavailable')
  const matches = []
  for (let start = 0; start < nodes.length; start++) {
    if (nodes[start].message?.id !== messages[0].id) continue
    let position = 0
    for (let end = start; end < nodes.length; end++) {
      const message = nodes[end].message
      if (message !== null) {
        if (message?.id !== messages[position]?.id) break
        position++
      }
      if (position !== messages.length) continue
      // 空投影可能属于区间也可能不属于；没有真实事务端点时不猜。
      if (nodes[start - 1]?.message === null || nodes[end + 1]?.message === null) throw new Error('source span ambiguous')
      matches.push(nodes.slice(start, end + 1).map(node => node.seq))
      break
    }
  }
  if (matches.length !== 1) throw new Error('source span unavailable or ambiguous')
  const seqs = matches[0], measured = meter.measure(session).nodes
  if (measured.length !== nodes.length || measured.some((node, index) => node.seq !== nodes[index].seq)) throw new Error('source token surface changed')
  const selected = new Set(seqs)
  const tokens = measured.filter(node => selected.has(node.seq)).reduce((total, node) => total + node.tokens, 0)
  if (!Number.isFinite(tokens) || tokens <= 0) throw new Error('source token budget unavailable')
  return { events, seqs, tokens }
}

export function createProvenanceCompaction(BasicClass, { sourceModuleId, isActive = () => true, signalOf = () => undefined, makeReference = makeSessionReference } = {}) {
  return class ProvenanceCompaction extends BasicClass {
    async summarize(input, agent, signal = signalOf(agent)) {
      const check = () => {
        signal?.throwIfAborted()
        if (!isActive(agent)) throw new DOMException('context-provenance: compaction released', 'AbortError')
      }
      const warn = message => { try { this.ctx.logger?.warn?.('context-provenance: summary without reference (' + message + ')') } catch { /* 诊断不能使原本可用的压缩失败。 */ } }
      check()
      let snapshot
      try { snapshot = sourceSnapshot(input, agent.session, this.ctx.tokenMeter) } catch (error) { warn(String(error?.message ?? error)) }
      const result = await super.summarize(input, agent, signal)
      check()
      if (!snapshot) return result
      try {
        const reference = makeReference(sourceModuleId, agent.session.id, snapshot.events, snapshot.seqs)
        const summary = [{ type: 'text', text: `[source: ${JSON.stringify(reference)}]\n` }, ...result.summary]
        const tokens = this.ctx.tokenMeter.estimateMessage(framed(summary))
        if (!Number.isFinite(tokens) || tokens >= snapshot.tokens) {
          warn('reference exceeds shrink budget')
          return result
        }
        return { ...result, summary }
      } catch (error) {
        warn(String(error?.message ?? error))
        return result
      }
    }
  }
}
