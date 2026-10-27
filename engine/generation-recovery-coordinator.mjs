import { historyEvents } from './history.mjs'

const visible = content => Array.isArray(content) && content.some(block => block.type !== 'reasoning' && (block.type !== 'text' || block.text?.trim()))

/** 候选只在 durable turn/end 后发布；流与结算共用官方 turn/step。 */
export function recoveryCoordinator(ctx, agent, config, options, isActive) {
  let frame
  let emitted
  const offRequest = ctx.on('agent/request', (payload, next) => {
    if (payload.agent !== agent) return next()
    frame = { turn: payload.turn, step: payload.step, signal: payload.signal, visible: false }
    return next()
  })
  const offEvent = ctx.on('session/event', (session, event) => {
    if (!isActive() || session.id !== agent.session.id || !frame) return
    const data = event.data ?? {}
    if (event.type === 'assistant/message' && data.turn === frame.turn) {
      if (data.step !== frame.step) return
      frame.visible = visible(data.message?.content)
      if (data.interrupted) frame.interrupted = true
    }
    if (event.type !== 'turn/end' || data.turn !== frame.turn || frame.signal?.aborted || frame.interrupted) return
    if (data.reason?.kind !== 'completed' && data.reason?.kind !== 'no-visible-output') return
    const execution = `${frame.turn}:${frame.step}`
    if (execution === emitted || (!frame.reason && (!config.recoverEmpty || frame.visible))) return
    emitted = execution
    const candidate = { sessionId: session.id, execution, turn: frame.turn, step: frame.step, reason: frame.reason ?? 'empty-final-step', signal: frame.signal }
    options.onRecoveryCandidate?.(candidate)
    options.recover?.(candidate)
  })
  return {
    mark(reason) { if (frame && !frame.signal?.aborted) frame.reason = reason },
    dispose() { offRequest(); offEvent() },
    // 迟到idle回调不能跨过新的用户执行边界。
    unchanged(candidate) {
      const latest = historyEvents(agent.session).findLast(event => event.type === 'turn/start')
      return !latest || latest.data?.turn === candidate.turn
    },
  }
}
