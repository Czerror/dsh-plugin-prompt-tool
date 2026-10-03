import { MATCH_LOGIC } from '../anchor-match.mjs'
import { UNAVAILABLE } from './availability.mjs'
const COMPOSITE_OPERATORS = Object.values(MATCH_LOGIC)

export function composite(node) {
  if (typeof node === 'function') return node
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    throw new TypeError(`predicates: a composite must be a predicate or { ${COMPOSITE_OPERATORS.join(' | ')} }`)
  }
  const unknown = Object.keys(node).filter((key) => !COMPOSITE_OPERATORS.includes(key))
  if (unknown.length > 0) {
    throw new TypeError(`predicates: unknown composite key(s) ${unknown.join(', ')} — allowed: ${COMPOSITE_OPERATORS.join(', ')}`)
  }
  const declared = COMPOSITE_OPERATORS.filter((key) => node[key] !== undefined)
  if (declared.length !== 1) {
    throw new TypeError(`predicates: a composite node must declare exactly one of ${COMPOSITE_OPERATORS.join(', ')}`)
  }
  const operator = declared[0]
  if (operator === MATCH_LOGIC.NOT) {
    const child = composite(node[operator])
    const predicate = (payload) => {
      const result = child(payload)
      return result === UNAVAILABLE ? UNAVAILABLE : !result
    }
    predicate.kind = 'composite'
    if (typeof child.observe === 'function') {
      predicate.observe = (session, event) => child.observe(session, event)
    }
    return predicate
  }
  const list = node[operator]
  if (!Array.isArray(list) || list.length === 0) {
    throw new TypeError(`predicates: composite ${operator} needs a non-empty array of predicates`)
  }
  const children = list.map(composite)
  const predicates = {
    [MATCH_LOGIC.ANY]: (payload) => {
      let unknown = false
      for (const child of children) {
        const result = child(payload)
        if (result === UNAVAILABLE) unknown = true
        else if (result) return true
      }
      return unknown ? UNAVAILABLE : false
    },
    [MATCH_LOGIC.ALL]: (payload) => {
      let unknown = false
      for (const child of children) {
        const result = child(payload)
        if (result === UNAVAILABLE) unknown = true
        else if (!result) return false
      }
      return unknown ? UNAVAILABLE : true
    },
    [MATCH_LOGIC.NOT_ANY]: (payload) => {
      let unknown = false
      for (const child of children) {
        const result = child(payload)
        if (result === UNAVAILABLE) unknown = true
        else if (result) return false
      }
      return unknown ? UNAVAILABLE : true
    },
  }
  const predicate = predicates[operator]
  if (predicate === undefined) {
    throw new TypeError(`predicates: composite ${operator} is not a supported operator`)
  }
  predicate.kind = 'composite'
  // 组合层必须**转发子谓词的 observe**（B7 T1 的跨能力缺口修复）：两条挂载路径的观察器
  // 接线都按 `when.observe` 过滤（`trigger.mjs` 的 `wireTriggerObservers`），被组合包住的
  // phase / count / session 谓词否则永远收不到活的 `session/event`——状态按 `session.id`
  // 缓存后不再重扫（`shared.mjs` 的 `sessionMapGet`），判定会停在冷扫那一刻（计数恒旧值、
  // 相位永不晋升）。`phase` 有 `subscribe: false` 可绕（代价是每次判定冷扫），
  // `count` / `session` 没有该档，所以这条转发是它们唯一的活路。
  const observers = children.filter((child) => typeof child.observe === 'function')
  if (observers.length > 0) {
    predicate.observe = (session, event) => {
      for (const child of observers) child.observe(session, event)
    }
  }
  return predicate
}
