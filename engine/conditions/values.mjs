export function optionalBoolean(value, field, fallback) {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new TypeError(`predicates: ${field} must be a boolean`)
  return value
}

/** 键集合归一化：非字符串数组 / 非数组一律 fail loud；空白键丢弃。 */
export function keyList(value, field) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new TypeError(`predicates: ${field} must be an array of strings when present`)
  }
  return value.map((item) => item.trim()).filter((item) => item.length > 0)
}

/** 名称集合：与 tool-filter 的 nameSet 同严格度（空串不是合法名称）。 */
export function nameList(value, field) {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new TypeError(`predicates: ${field} must be an array of non-empty strings`)
  }
  return [...new Set(value)]
}

/** 计数上下限：缺省 = 不设该侧；非安全非负整数一律 fail loud。 */
export function boundOf(value, field) {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`predicates: count ${field} must be an integer >= 0`)
  }
  return value
}
