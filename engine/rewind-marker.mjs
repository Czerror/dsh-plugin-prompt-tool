import { historyEvents, currentEvents } from './history.mjs'

const markerId = /^rewind-pt-[0-9a-f-]{36}$/

/** Only this producer's empty, source-linked replacement is a rewind decision. */
export function isRewindMarker(event) {
  const data = event?.data, op = event?.surfaceOp, refs = event?.sourceEventSeqs
  return event?.type === 'user/message' && markerId.test(data?.id ?? '')
    && data?.role === 'user' && data?.source?.kind === 'user'
    && Array.isArray(data.content) && data.content.length === 0
    && op?.op === 'replace' && Number.isSafeInteger(op.startSeq) && op.startSeq >= 0
    && Number.isSafeInteger(op.endSeq) && op.endSeq >= op.startSeq && op.endSeq < event.seq
    && Array.isArray(refs) && refs.length > 0
    && refs[0] === op.startSeq && refs.at(-1) === op.endSeq
    && refs.every(seq => Number.isSafeInteger(seq) && seq >= 0 && seq < event.seq)
    && new Set(refs).size === refs.length
}

export function rewindPlan(session, mode = 'once', acceptsNotice = () => false) {
  const events = historyEvents(session), nodes = session.surface.nodes
  if (!Array.isArray(nodes)) throw new Error('当前会话缺少可验证的模型 surface')
  const bySeq = new Map(events.map(event => [event.seq, event]))
  const visible = currentEvents(session)
  if (visible.some(event => event === undefined)) throw new Error('会话 surface 不完整')
  let input = visible.findLast(event => event.type === 'user/message' && event.data?.source?.kind === 'user' && !isRewindMarker(event))
  if (!input) throw new Error('没有可回退的已接受用户输入')
  const turn = events.findLast(event => event.type === 'turn/start' && event.seq < input.seq)
  const latest = events.findLast(event => event.type === 'turn/start')
  if (!turn) throw new Error('当前轮尚无可回退的已接受用户输入')
  if (latest && latest.seq > input.seq && !events.some(event => isRewindMarker(event) && event.seq > latest.seq)) {
    const tails = events.filter(event => event.type === 'turn/start' && event.seq > input.seq)
    const automatic = mode === 'round' && tails.every((tail, index) => {
      const segment = events.filter(event => event.seq > tail.seq && event.seq < (tails[index + 1]?.seq ?? Infinity))
      const inputs = segment.filter(event => event.type === 'user/message')
      return segment.some(event => event.type === 'turn/end') && inputs.length > 0
        && !segment.some(event => event.type === 'subagent/catalog')
        && inputs.every(event => event.data?.source?.kind === 'subagent-settled' && acceptsNotice(event.data.source, turn.seq))
    })
    if (!automatic) throw new Error('当前轮尚无可回退的已接受用户输入')
  }
  const lastInputSeq = input.seq
  const inputs = mode === 'round' ? [...new Set(visible.filter(event => event.seq > turn.seq && event.seq <= lastInputSeq
    && event.type === 'user/message' && event.data?.source?.kind === 'user' && !isRewindMarker(event)))] : [input]
  input = inputs[0]
  const index = nodes.indexOf(input.seq)
  const refs = [...new Set(nodes.slice(index))]
  if (refs.length === 0 || refs.some(seq => seq < input.seq && !isRewindMarker(bySeq.get(seq)))) throw new Error('无法安全定位连续回退范围')
  return { session, turnSeq: turn.seq, observedTurnSeq: latest?.seq, lastInputSeq, turn: turn.data.turn, inputId: input.data.id, inputSeq: input.seq,
    text: inputs.map(event => event.data.content.filter(block => block.type === 'text').map(block => block.text).join('')).join('\n\n'), refs }
}

/** Keep raw loaded entries in the owner; replay and prepend interpret the same decisions. */
export function visibleRewindEntries(entries) {
  const sorted = [...entries].sort((a, b) => a.event.seq - b.event.seq)
  const hidden = new Set()
  for (const { event } of sorted) {
    if (!isRewindMarker(event)) continue
    hidden.add(event.seq)
    for (const seq of event.sourceEventSeqs) hidden.add(seq)
  }
  const cutTurns = new Set(), keptTurns = new Set(), cutSteps = new Set(), keptSteps = new Set()
  let turn, step
  for (const { event } of sorted) {
    if (event.type === 'turn/start') { turn = event.data.turn; step = undefined }
    if (event.type === 'step/start') step = event.data.step
    if (event.type.endsWith('/message') && !isRewindMarker(event)) {
      const turns = hidden.has(event.seq) ? cutTurns : keptTurns
      const steps = hidden.has(event.seq) ? cutSteps : keptSteps
      if (turn !== undefined) turns.add(turn)
      if (step !== undefined) steps.add(`${turn}:${step}`)
    }
  }
  turn = undefined
  step = undefined
  return sorted.filter(({ event }) => {
    if (event.type === 'turn/start') { turn = event.data.turn; step = undefined }
    if (event.type === 'step/start') step = event.data.step
    if (hidden.has(event.seq)) return false
    if (cutTurns.has(turn) && !keptTurns.has(turn) && (event.type.startsWith('turn/') || event.type.startsWith('step/') || event.type === 'agent/request')) return false
    if (cutSteps.has(`${turn}:${step}`) && !keptSteps.has(`${turn}:${step}`) && event.type.startsWith('step/')) return false
    // agent/inbox/spliced is a claim state chain, not a sent-message row.
    return true
  })
}
