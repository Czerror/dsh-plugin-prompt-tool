import { MATCH_LOGIC, createAnchorMatcher } from '../anchor-match.mjs'
import { subjectTextOf } from '../condition-facts.mjs'
import { keyList } from './values.mjs'
import { conditionInputAvailable, UNAVAILABLE } from './availability.mjs'
const MATCH_FLAGS = ['caseSensitive', 'wholeWords', 'useRegex']
const MATCH_MODES = ['scan', 'prefix']

export function createTextPredicate(options = {}) {
  if (options.stWords !== undefined) throw new TypeError('stWords 已退役，请显式转换为 wordBoundary')
  if (options.wordBoundary !== undefined && !['ascii-token', 'unicode'].includes(options.wordBoundary)) throw new TypeError('wordBoundary 必须是 ascii-token 或 unicode')
  const keys = keyList(options.keys, 'keys')
  const secondaryKeys = keyList(options.secondaryKeys, 'secondaryKeys')
  const bounds = ['minChars', 'maxChars'].map(field => {
    const value = options[field]
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw new TypeError(`predicates: ${field} must be a non-negative safe integer`)
    }
    return value
  })
  const [minChars, maxChars] = bounds
  if (minChars !== undefined && maxChars !== undefined && minChars > maxChars) {
    throw new TypeError('predicates: minChars cannot exceed maxChars')
  }
  const hasKeys = keys.length > 0 || secondaryKeys.length > 0
  if (!hasKeys && minChars === undefined && maxChars === undefined) {
    throw new TypeError('predicates: a text predicate needs a non-empty key or minChars/maxChars')
  }
  const logic = options.logic ?? MATCH_LOGIC.ANY
  if (!Object.values(MATCH_LOGIC).includes(logic)) {
    throw new TypeError(`predicates: logic must be one of ${Object.values(MATCH_LOGIC).join(', ')}`)
  }
  const mode = options.mode ?? 'scan'
  if (!MATCH_MODES.includes(mode)) {
    throw new TypeError(`predicates: mode must be one of ${MATCH_MODES.join(', ')}`)
  }
  for (const field of MATCH_FLAGS) {
    if (options[field] !== undefined && typeof options[field] !== 'boolean') {
      throw new TypeError(`predicates: ${field} must be a boolean when present`)
    }
  }
  // 与 anchor-match 逐例等价的关键：匹配器就是 anchor-match 的匹配器，本层不加也不减语义。
  const matcher = createAnchorMatcher({
    keys,
    secondaryKeys,
    caseSensitive: options.caseSensitive === true,
    wholeWords: options.wholeWords === true,
    useRegex: options.useRegex,
    logic,
    mode,
    wordBoundary: options.wordBoundary,
  })
  const subject = options.subject
  const predicate = (payload) => {
    if (!conditionInputAvailable('text', options, payload)) return UNAVAILABLE
    const text = typeof payload === 'string' ? payload : subjectTextOf(subject, payload)
    return (minChars === undefined || text.length >= minChars)
      && (maxChars === undefined || text.length <= maxChars)
      && (!hasKeys || matcher.scan(text).active === true)
  }
  predicate.kind = 'text'
  return predicate
}
