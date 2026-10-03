import { createAnchorMatcher } from '../anchor-match.mjs'
import { sessionEvents, sessionState } from '../shared.mjs'
import { sessionOf } from './subject.mjs'
import { boundOf, keyList } from './values.mjs'

/** 首条 assistant reasoning 的确认事实；未到达时不缓存，无 id 会话不共享状态。 */
export function createAnchorState(options = {}) {
  const matcher = createAnchorMatcher({ keys: keyList(options.keys, 'anchor.keys'), mode: 'prefix' })
  const confirmedBySession = sessionState(undefined, () => false)
  return session => {
    const assistants = sessionEvents(session).filter(event => event.type === 'assistant/message')
    let confirmed = confirmedBySession.peek(session)
    if (confirmed === undefined && assistants.length > 0) {
      const reasoning = (assistants[0].data?.message?.content ?? []).find(block => block.type === 'reasoning')
      confirmed = reasoning !== undefined && matcher.scan(String(reasoning.text ?? '')).active
      confirmedBySession.set(session, confirmed)
    }
    return { confirmed: confirmed === true, assistantRounds: assistants.length }
  }
}

/** 确认即命中；可选 fallbackAfter 表示超过指定 assistant 消息数后也允许。 */
export function createAnchorPredicate(options = {}) {
  const inspect = createAnchorState(options)
  const fallbackAfter = boundOf(options.fallbackAfter, 'anchor.fallbackAfter')
  const predicate = payload => {
    const status = inspect(sessionOf(payload))
    return status.confirmed || (fallbackAfter !== undefined && status.assistantRounds > fallbackAfter)
  }
  predicate.kind = 'anchor'
  return predicate
}
