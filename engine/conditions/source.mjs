import { optionalBoolean } from './values.mjs'
import { conditionInputAvailable, UNAVAILABLE } from './availability.mjs'

function sourceChannel(value, field) {
  if (value === undefined) return undefined
  if (typeof value === 'string' && value.length > 0) return [value]
  if (Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string' && item.length > 0)) {
    return [...new Set(value)]
  }
  throw new TypeError(`predicates: ${field} must be a non-empty string or an array of non-empty strings`)
}

/**
 * 来源判断：`source.kind` / `source.plugin` 的比较（context-gate 的 allowKinds 一族
 * 与 executor 的双通道去重都是这套比较）。
 *
 *  - **精确**（缺省）为 `===` 语义，且**大小写敏感**——现有四处调用
 *    （context-gate / executor / anchor-turn / instruction-hint）全是精确且区分大小写，
 *    统一不得放宽；大小写不敏感必须显式 `caseSensitive: false`。
 *  - **前缀**仅在 `match: 'prefix'` 时启用。
 *  - 声明了多个通道时是**合取**（都命中才算命中）；需要析取用
 *    `composite({ any: [source({kind}), source({plugin})] })`——不隐式二选一。
 *
 * @param {object} options
 * @param {string|string[]} [options.kind]
 * @param {string|string[]} [options.plugin]
 * @param {boolean} [options.caseSensitive] 缺省 true
 * @param {'exact'|'prefix'} [options.match] 缺省 exact
 * @returns {(payload: unknown) => boolean}
 */
export function createSourcePredicate(options = {}) {
  const kinds = sourceChannel(options.kind, 'kind')
  const plugins = sourceChannel(options.plugin, 'plugin')
  if (kinds === undefined && plugins === undefined) {
    throw new TypeError('predicates: a source predicate needs kind or plugin')
  }
  const caseSensitive = optionalBoolean(options.caseSensitive, 'caseSensitive', true)
  const match = options.match ?? 'exact'
  if (match !== 'exact' && match !== 'prefix') {
    throw new TypeError('predicates: source match must be "exact" or "prefix"')
  }
  const normalize = (value) => (caseSensitive ? value : value.toLowerCase())
  const asSet = (list) => (list === undefined ? undefined : new Set(list.map(normalize)))
  const kindSet = asSet(kinds)
  const pluginSet = asSet(plugins)
  const channelHit = (value, allowed) => {
    if (allowed === undefined) return true
    if (typeof value !== 'string' || value.length === 0) return false
    const normalized = normalize(value)
    if (match === 'exact') return allowed.has(normalized)
    for (const prefix of allowed) {
      if (normalized.startsWith(prefix)) return true
    }
    return false
  }
  const predicate = (payload) => {
    if (!conditionInputAvailable('source', options, payload)) return UNAVAILABLE
    const source = payload?.source
    return channelHit(source?.kind, kindSet) && channelHit(source?.plugin, pluginSet)
  }
  predicate.kind = 'source'
  return predicate
}
