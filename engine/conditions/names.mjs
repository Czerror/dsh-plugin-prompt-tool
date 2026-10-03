import { nameList, optionalBoolean } from './values.mjs'
import { conditionInputAvailable, UNAVAILABLE } from './availability.mjs'

export function createNameListPredicate(options = {}) {
  const allow = nameList(options.allow, 'allow')
  const deny = nameList(options.deny, 'deny')
  const caseSensitive = optionalBoolean(options.caseSensitive, 'caseSensitive', true)
  const normalize = (name) => (caseSensitive ? name : name.toLowerCase())
  const allowSet = allow === undefined ? undefined : new Set(allow.map(normalize))
  const denySet = deny === undefined ? undefined : new Set(deny.map(normalize))
  const predicate = (payload) => {
    if (!conditionInputAvailable('names', options, payload)) return UNAVAILABLE
    const name = typeof payload === 'string' ? payload : payload?.name
    const value = normalize(name)
    if (denySet !== undefined && denySet.has(value)) return false
    if (allowSet !== undefined && !allowSet.has(value)) return false
    return true
  }
  predicate.kind = 'names'
  return predicate
}
