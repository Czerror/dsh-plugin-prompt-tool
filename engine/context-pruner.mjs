import { makeSessionReference } from './retrieval-reference.mjs'

const PRUNE_MARKER = '\n\n[... tool result middle pruned ...]\n\n'

/** 官方裁剪算法不变，只在本次生成marker的Unicode位置附来源。 */
function referencedContent(content, headChars, reference) {
  const result = [...content]
  let consumed = 0
  for (let index = 0; index < result.length; index++) {
    const block = result[index]
    if (block.type !== 'text') continue
    const points = [...block.text]
    if (consumed + points.length <= headChars) { consumed += points.length; continue }
    const offset = headChars - consumed
    if (points.slice(offset, offset + [...PRUNE_MARKER].length).join('') !== PRUNE_MARKER) return null
    result[index] = { ...block, text: points.slice(0, offset).join('') + PRUNE_MARKER + `[source: ${JSON.stringify(reference)}]\n` + points.slice(offset + [...PRUNE_MARKER].length).join('') }
    return result
  }
  return null
}

export function createProvenancePruner(PrunerClass, { sourceModuleId, isActive = () => true, signalOf = () => undefined, makeReference = makeSessionReference } = {}) {
  return class ProvenancePruner extends PrunerClass {
    pruneSession(session, signal = signalOf()) {
      const check = () => {
        signal?.throwIfAborted()
        if (!isActive()) throw new Error('context-provenance: pruner released')
      }
      check()
      const events = session.snapshotEvents()
      const bySeq = new Map(events.map(event => [event.seq, event]))
      const candidates = [...new Set(session.surface.nodes)].map(seq => bySeq.get(seq)).filter(event => event?.type === 'tool/result')
      const pruned = []
      let charsRemoved = 0
      for (const event of candidates) {
        check()
        const seq = event.seq, original = session.deriveEventMessage(event)
        let content = super.pruneContent(original.content)
        if (content === null) continue
        const charsBefore = this.measureContent(original.content)
        try {
          const reference = makeReference(sourceModuleId, session.id, events, [seq])
          const cited = referencedContent(content, this.config.headChars, reference)
          if (!cited || this.measureContent(cited) > this.config.thresholdChars || this.measureContent(cited) >= charsBefore) throw new Error('reference exceeds pruning budget')
          content = cited
        } catch (error) {
          this.ctx.logger?.warn?.(`context-provenance: pruned without reference (${String(error?.message ?? error)})`)
        }
        const charsAfter = this.measureContent(content)
        if (charsAfter > this.config.thresholdChars || charsAfter >= charsBefore) throw new Error('context-provenance: invalid prune result')
        const shadowedTokenCount = this.ctx.tokenMeter.estimateMessage(original)
        check()
        session.append('compaction/prune', { shadowedRange: { start: seq, end: seq }, shadowedSeqs: [seq], shadowedTokenCount })
        check()
        const replacement = session.append('tool/result', { ...event.data, message: { ...original, content } }, {
          surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq],
        })
        pruned.push({ originalSeq: seq, replacementSeq: replacement.seq, callId: original.source.callId, charsBefore, charsAfter })
        charsRemoved += charsBefore - charsAfter
      }
      return { pruned, charsRemoved }
    }
  }
}
