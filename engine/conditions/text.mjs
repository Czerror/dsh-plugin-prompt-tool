import { MATCH_LOGIC, createAnchorMatcher } from '../anchor-match.mjs'
import { subjectTextOf } from '../condition.mjs'
import { keyList } from './values.mjs'
import { conditionInputAvailable, UNAVAILABLE } from './availability.mjs'
const MATCH_FLAGS = ['caseSensitive', 'wholeWords', 'useRegex']
const MATCH_MODES = ['scan', 'prefix']

export function createTextPredicate(options = {}) {
  if (options.stWords !== undefined) throw new TypeError('stWords 已退役，请显式转换为 wordBoundary')
  if (options.wordBoundary !== undefined && !['ascii-token', 'unicode'].includes(options.wordBoundary)) throw new TypeError('wordBoundary 必须是 ascii-token 或 unicode')
  const keys = keyList(options.keys, 'keys')
  const secondaryKeys = keyList(options.secondaryKeys, 'secondaryKeys')
  if (keys.length === 0 && secondaryKeys.length === 0) {
    throw new TypeError('predicates: a text predicate needs at least one non-empty key')
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
  const predicate = (payload) => conditionInputAvailable('text', options, payload)
    ? matcher.scan(typeof payload === 'string' ? payload : subjectTextOf(subject, payload)).active === true
    : UNAVAILABLE
  predicate.kind = 'text'
  return predicate
}
