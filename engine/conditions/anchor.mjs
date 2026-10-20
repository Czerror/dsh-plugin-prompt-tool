import { MATCH_LOGIC, createAnchorMatcher } from '../anchor-match.mjs'
import { findActionDelivery, visibleMessages } from '../delivery.mjs'
import { sessionOf } from './subject.mjs'
import { keyList, optionalBoolean } from './values.mjs'
import { UNAVAILABLE } from './availability.mjs'

const SUBJECTS = ['userMessage', 'assistantReasoning', 'assistantText', 'toolResult']
const FIELDS = new Set(['subject', 'keys', 'secondaryKeys', 'caseSensitive', 'wholeWords', 'useRegex', 'logic', 'mode', 'wordBoundary', 'fallbackAfter', 'after'])

/** 按所选来源取正文；缺少该来源的内容块不算一次相应输出。 */
function outputText(subject, event, message) {
  if (subject === 'userMessage') {
    if (event.type !== 'user/message' || message.role !== 'user' || message.source?.kind !== 'user' || message.source?.plugin !== undefined) return undefined
  } else if (subject === 'toolResult') {
    if (event.type !== 'tool/result') return undefined
  } else if (event.type !== 'assistant/message' || event.data?.interrupted === true) return undefined
  const type = subject === 'assistantReasoning' ? 'reasoning' : 'text'
  const blocks = (Array.isArray(message.content) ? message.content : []).filter(block => block?.type === type)
  return blocks.length === 0 ? undefined : blocks.map(block => typeof block.text === 'string' ? block.text : '').join('\n')
}

/** 从当前可见、已结算消息重建确认；关联只从目标实际投递的日志序号之后开始。 */
export function createAnchorPredicate(options = {}, context = {}) {
  for (const key of Object.keys(options)) if (!FIELDS.has(key)) throw new TypeError(`anchor: unknown field ${key}`)
  const subject = options.subject ?? 'assistantReasoning'
  if (!SUBJECTS.includes(subject)) throw new TypeError(`anchor.subject must be one of ${SUBJECTS.join(', ')}`)
  const mode = options.mode ?? 'prefix'
  if (!['prefix', 'scan'].includes(mode)) throw new TypeError('anchor.mode must be prefix or scan')
  if (mode === 'prefix' && ['secondaryKeys', 'caseSensitive', 'wholeWords', 'useRegex', 'logic', 'wordBoundary'].some(key => options[key] !== undefined)) {
    throw new TypeError('anchor prefix matches literal keys only; use scan for other matching options')
  }
  if (options.logic !== undefined && !Object.values(MATCH_LOGIC).includes(options.logic)) throw new TypeError('anchor.logic is invalid')
  const fallbackAfter = options.fallbackAfter
  if (fallbackAfter !== undefined && (!Number.isSafeInteger(fallbackAfter) || fallbackAfter <= 0)) throw new TypeError('anchor.fallbackAfter must be a positive integer')
  if (options.after !== undefined && (options.after === null || typeof options.after !== 'object' || Array.isArray(options.after)
    || Object.keys(options.after).some(key => key !== 'action') || typeof options.after.action !== 'string' || options.after.action.trim().length === 0)) {
    throw new TypeError('anchor.after must be { action: non-empty string }')
  }
  const matcher = createAnchorMatcher({
    keys: keyList(options.keys, 'anchor.keys'),
    secondaryKeys: keyList(options.secondaryKeys, 'anchor.secondaryKeys'),
    caseSensitive: optionalBoolean(options.caseSensitive, 'anchor.caseSensitive', false),
    wholeWords: optionalBoolean(options.wholeWords, 'anchor.wholeWords', false),
    useRegex: optionalBoolean(options.useRegex, 'anchor.useRegex', undefined),
    logic: options.logic,
    wordBoundary: options.wordBoundary,
    mode,
  })
  const predicate = payload => {
    const session = sessionOf(payload)
    if (typeof session?.snapshotEvents !== 'function') return UNAVAILABLE
    const messages = visibleMessages(session)
    let start
    if (options.after !== undefined) {
      const target = context.resolveAction?.(options.after.action)
      if (target === undefined) return UNAVAILABLE
      start = findActionDelivery(session, target, messages)
      if (start === undefined) return UNAVAILABLE
    }
    let outputs = 0
    for (const { event, seq, message } of messages) {
      if (start !== undefined && seq <= start.seq) continue
      const text = outputText(subject, event, message)
      if (text === undefined) continue
      if (matcher.scan(text).active) return true
      if (fallbackAfter !== undefined && ++outputs >= fallbackAfter) return true
    }
    return false
  }
  predicate.kind = 'anchor'
  return predicate
}
