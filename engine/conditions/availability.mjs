import { agentOf, sessionOf } from './subject.mjs'
import { SUBJECT_FIELDS } from '../condition.mjs'

/** 缺少真实事件事实不是 false；尤其不能经 not 反转成允许。 */
export const UNAVAILABLE = Symbol('condition-input-unavailable')

export function conditionInputAvailable(kind, options, payload) {
  const agent = agentOf(payload)
  const session = sessionOf(payload)
  if (['phase', 'count', 'session', 'anchor'].includes(kind)) {
    return session != null && typeof session.snapshotEvents === 'function' && (kind !== 'phase' || agent?.session != null)
  }
  if (kind === 'preset') return agent?.ctx != null
  if (kind === 'names') {
    const name = typeof payload === 'string' ? payload : payload?.name
    return typeof name === 'string' && name.length > 0
  }
  if (kind === 'source') return payload?.source !== null && typeof payload?.source === 'object' && !Array.isArray(payload.source)
  if (kind === 'text') {
    if (typeof payload === 'string') return true
    const field = Object.hasOwn(SUBJECT_FIELDS, options.subject) ? SUBJECT_FIELDS[options.subject] : undefined
    if (field === undefined || typeof payload?.[field] !== 'string') return false
    // 归一化器可把缺载荷投影为空文本；保留原参数表时必须区分缺事实与确实为空。
    if (Array.isArray(payload.args)) {
      if (options.subject === 'toolArgs') return payload.args[0] != null && Object.hasOwn(payload.args[0], 'arguments')
      if (options.subject === 'toolResult') return payload.args.length > 1 && payload.args[1] !== undefined
      if (options.subject === 'userMessage' && payload.channel === 'agent/pre-step') return Array.isArray(payload.args[0]?.messages)
      if (options.subject === 'userMessage' && payload.channel === 'agent/inbox/inserted') return payload.args[0]?.message != null
      if (options.subject === 'assistantText') return typeof session?.snapshotEvents === 'function'
      if (options.subject === 'subagentInfo') return payload.args[0] != null
    }
    return true
  }
  if (kind === 'scope') {
    if (options.audience !== undefined && session == null) return false
    const model = payload?.model ?? agent?.options?.model
    if (options.modelScope !== undefined && options.modelScope !== 'all' && (typeof model !== 'string' || model.length === 0)) return false
  }
  return true
}

export function withAvailableInput(kind, options, predicate) {
  const wrapped = payload => conditionInputAvailable(kind, options, payload) ? predicate(payload) : UNAVAILABLE
  wrapped.kind = predicate.kind
  if (typeof predicate.observe === 'function') wrapped.observe = (session, event) => predicate.observe(session, event)
  return wrapped
}
