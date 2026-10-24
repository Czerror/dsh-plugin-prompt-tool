/**
 * variable 谓词：把模块级持久变量接进规则条件。
 *
 * 适配器由挂载期绑定（`variableStore.read(moduleId)` → { module, global, effective, enabled }），
 * 与模板求值共用同一个 owner；编译期没有适配器，判定为 UNAVAILABLE（三值语义，不能经 not 反转）。
 */
import { UNAVAILABLE } from './availability.mjs'

const OPS = new Set(['eq', 'ne', 'in', 'gt', 'gte', 'lt', 'lte', 'present', 'absent'])
const SCOPES = new Set(['effective', 'module', 'global'])

/** 严格数字：空串与空白不算数字（`Number('')` 是 0，是陷阱）；非有限数不算数字。 */
function numeric(text) {
  if (text.trim().length === 0) return undefined
  const value = Number(text)
  return Number.isFinite(value) ? value : undefined
}

/**
 * @param {object} options
 * @param {string} options.key 变量名（模块声明，引擎不认前缀）
 * @param {'eq'|'ne'|'in'|'gt'|'gte'|'lt'|'lte'|'present'|'absent'} [options.op] 缺省 eq
 * @param {string|string[]} [options.value] in 用数组；present/absent 不收
 * @param {'effective'|'module'|'global'} [options.scope] 缺省 effective（模块覆盖全局）
 * @param {{ store?: { read: (moduleId: string) => { module?: Record<string, string>, global?: Record<string, string>, effective?: Record<string, string>, enabled?: boolean } }, moduleId?: string }} [context]
 */
export function createVariablePredicate(options = {}, context = {}) {
  const key = options.key
  if (typeof key !== 'string' || key.length === 0) {
    throw new TypeError('predicates: variable key must be a non-empty string')
  }
  const op = options.op ?? 'eq'
  if (!OPS.has(op)) {
    throw new TypeError(`predicates: variable op must be one of ${[...OPS].join(', ')}`)
  }
  const scope = options.scope ?? 'effective'
  if (!SCOPES.has(scope)) {
    throw new TypeError(`predicates: variable scope must be one of ${[...SCOPES].join(', ')}`)
  }
  let expected
  if (op === 'present' || op === 'absent') {
    if (options.value !== undefined) throw new TypeError(`predicates: variable ${op} does not take value`)
  } else if (op === 'in') {
    if (!Array.isArray(options.value) || options.value.length === 0
      || options.value.some((item) => typeof item !== 'string')) {
      throw new TypeError('predicates: variable in needs a non-empty array of strings')
    }
    expected = options.value
  } else {
    if (typeof options.value !== 'string') throw new TypeError('predicates: variable value must be a string')
    expected = options.value
  }
  const store = context.store
  const moduleId = context.moduleId
  const predicate = () => {
    // 适配器缺失（准备期、复制协议未接）是「缺事实」，不是「变量为假」。
    if (store === undefined || typeof store.read !== 'function') return UNAVAILABLE
    if (typeof moduleId !== 'string' || moduleId.length === 0) return UNAVAILABLE
    const state = store.read(moduleId)
    if (state === null || typeof state !== 'object' || state.enabled === false) return UNAVAILABLE
    const values = scope === 'global' ? state.global : scope === 'module' ? state.module : state.effective
    if (values === null || typeof values !== 'object' || Array.isArray(values)) return UNAVAILABLE
    const present = Object.hasOwn(values, key)
    if (op === 'present') return present
    if (op === 'absent') return !present
    // 键缺失不是错误：比较类按假处理（作者写 present 才能区分「没有」）。
    if (!present) return false
    const actual = values[key]
    if (typeof actual !== 'string') return false
    if (op === 'eq') return actual === expected
    if (op === 'ne') return actual !== expected
    if (op === 'in') return expected.includes(actual)
    const left = numeric(actual)
    const right = numeric(expected)
    if (left === undefined || right === undefined) return false
    if (op === 'gt') return left > right
    if (op === 'gte') return left >= right
    if (op === 'lt') return left < right
    return left <= right
  }
  predicate.kind = 'variable'
  return predicate
}
