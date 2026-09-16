/** ST 文本预处理与顺序求值；状态只归调用方传入的 local/global 所有。 */
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { interpolateVariables, normalizeMacroSyntax } from './interpolate.mjs'

const MAX_BYTES = 1024 * 1024
const MAX_DEPTH = 32
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const DISCARDED_MACRO = /^\s*(?:\/\/|(?:trim|ERA)(?=$|[:\s]))/i

function byteLength(text) {
  const size = Buffer.byteLength(text, 'utf8')
  if (size > MAX_BYTES) throw new RangeError('ST macro text exceeds 1 MiB')
  return size
}

/** 双花括号是宏边界；JSON 单花括号及字符串内的右括号不是。 */
function macroEnd(text, start, depth = 0) {
  const frames = [{ braces: 0, brackets: 0, quote: false, escape: false }]
  if (depth >= MAX_DEPTH) throw new RangeError('ST macro depth exceeds 32')
  for (let index = start + 2; index < text.length; index++) {
    const frame = frames.at(-1)
    const char = text[index]
    if (frame.escape) {
      frame.escape = false
      continue
    }
    if (frame.quote && char === '\\') {
      frame.escape = true
      continue
    }
    if (char === '"' && (frame.quote || frame.braces > 0 || frame.brackets > 0)) {
      frame.quote = !frame.quote
      continue
    }
    if (text.startsWith('{{', index)) {
      if (depth + frames.length >= MAX_DEPTH) throw new RangeError('ST macro depth exceeds 32')
      frames.push({ braces: 0, brackets: 0, quote: false, escape: false })
      index++
      continue
    }
    if (frame.quote) continue
    if (char === '{') frame.braces++
    else if (char === '}' && frame.braces > 0) frame.braces--
    else if (text.startsWith('}}', index)) {
      frames.pop()
      if (frames.length === 0) return index + 2
      index++
    } else if (char === '[') frame.brackets++
    else if (char === ']') frame.brackets = Math.max(0, frame.brackets - 1)
  }
  return -1
}

/** 先找到完整边界再求值，未闭合宏的内部指令不会被意外执行。 */
function transformText(text, macro) {
  let work = 0
  function walk(source, depth = 0, path = '') {
    work += byteLength(source)
    // 零输出的重复变量展开也必须有界，不能只限制最终输出。
    if (work > MAX_BYTES * MAX_DEPTH) throw new RangeError('ST macro expansion work limit exceeded')
    const chunks = []
    let size = 0
    const append = (value) => {
      size += byteLength(value)
      if (size > MAX_BYTES) throw new RangeError('ST macro output exceeds 1 MiB')
      chunks.push(value)
    }
    let cursor = 0
    while (cursor < source.length) {
      const start = source.indexOf('{{', cursor)
      if (start < 0) {
        append(source.slice(cursor))
        break
      }
      append(source.slice(cursor, start))
      const end = macroEnd(source, start, depth)
      if (end < 0) {
        if (!DISCARDED_MACRO.test(source.slice(start + 2))) append(source.slice(start))
        break
      }
      append(macro(source.slice(start + 2, end - 2), (value) => walk(value, depth + 1, `${path}/${start}`), `${path}/${start}`))
      cursor = end
    }
    return chunks.join('')
  }
  return walk(text)
}

/** 只分割当前层的第一个 ::，嵌套宏中的分隔符属于嵌套宏。 */
function splitArgument(text) {
  for (let index = 0; index < text.length; index++) {
    if (text.startsWith('{{', index)) {
      const end = macroEnd(text, index)
      if (end < 0) break
      index = end - 1
    } else if (text.startsWith('::', index)) {
      return [text.slice(0, index), text.slice(index + 2)]
    }
  }
  return [text, undefined]
}

/** 对齐 ST getVariable 的数值转换；空白文本仍是文本。 */
function stValue(value) {
  return (typeof value === 'string' && value.trim() === '') || Number.isNaN(Number(value))
    ? (value || '')
    : Number(value)
}

function addValue(value, increment) {
  const current = stValue(value) || 0
  byteLength(String(current))
  let parsed
  try { parsed = JSON.parse(current) } catch { /* 非 JSON 值继续按数字或文本处理。 */ }
  if (Array.isArray(parsed)) {
    parsed.push(increment)
    return JSON.stringify(parsed)
  }
  const amount = Number(increment)
  if (Number.isNaN(amount) || Number.isNaN(Number(current))) return String(current || '') + increment
  const result = Number(current) + amount
  return Number.isNaN(result) ? undefined : result
}

/** 不求值变量/动态宏，不执行 ERA 内容；未知角色名留给运行时。 */
export function prepareStText(text, cardName = '') {
  const name = cardName.trim()
  return transformText(text, (body, expand) => {
    if (DISCARDED_MACRO.test(body)) return ''
    if (/^char$/i.test(body) && name) return name
    if (/^user$/i.test(body)) return '用户'
    return normalizeMacroSyntax(`{{${expand(body)}}}`)
  }).replace(/(?:\r?\n){3,}/g, '\n\n').trim()
}

/** 按出现顺序求值；variables/session 只读，不持久化或缓存任何状态。 */
export function renderStText(text, { variables = {}, local = {}, global = {}, session, sourceId = '', warn = () => {} } = {}) {
  const sourceKey = createHash('sha256').update(sourceId).update(text).digest('hex')
  const tables = { local, global, variables }
  const resolving = new Set()
  const allowed = (key) => {
    if (key && !FORBIDDEN_KEYS.has(key)) return true
    warn(`ST variable key blocked: ${key}`)
    return false
  }
  const write = (table, key, value) => {
    if (value === undefined) return
    byteLength(String(value))
    // 禁止危险键，并显式定义 own 数据属性，避免触发继承的 setter。
    Object.defineProperty(table, key, { value, writable: true, enumerable: true, configurable: true })
  }
  const read = (scope, key, expand, numeric = false) => {
    const id = `${scope}:${key}`
    if (resolving.has(id)) throw new RangeError(`ST variable cycle: ${id}`)
    resolving.add(id)
    try {
      const value = tables[scope][key]
      return expand(String((numeric ? stValue(value) : value) ?? ''))
    } finally {
      resolving.delete(id)
    }
  }

  return transformText(text, (body, expand, path) => {
    if (DISCARDED_MACRO.test(body)) return ''
    const [name, args] = splitArgument(body)
    const operation = /^(set|add|get|inc|dec)(global)?var$/i.exec(name.trim())
    if (operation && args !== undefined) {
      const [rawKey, rawValue] = splitArgument(args)
      const key = expand(rawKey).trim()
      if (!allowed(key)) return ''
      const action = operation[1].toLowerCase()
      const scope = operation[2] ? 'global' : 'local'
      const table = tables[scope]
      const exists = Object.hasOwn(table, key)
      if (action === 'get') {
        if (exists) return read(scope, key, expand, true)
        if (scope === 'local' && Object.hasOwn(variables, key)) return read('variables', key, expand, true)
        if (rawValue === undefined) return ''
        const fallback = expand(rawValue)
        if (fallback !== '') write(table, key, fallback)
        return fallback
      }
      if ((action === 'set' || action === 'add') && rawValue !== undefined) {
        const value = expand(rawValue)
        write(table, key, action === 'set' ? value : addValue(exists ? table[key] : '', value))
        return ''
      }
      if ((action === 'inc' || action === 'dec') && rawValue === undefined) {
        const value = addValue(exists ? table[key] : '', action === 'inc' ? 1 : -1)
        write(table, key, value)
        return String(value ?? '')
      }
      return `{{${body}}}`
    }

    const whole = normalizeMacroSyntax(`{{${expand(body)}}}`)
    const [key] = splitArgument(whole.slice(2, -2))
    if (!allowed(key)) return whole
    if (Object.hasOwn(local, key)) return read('local', key, expand)
    if (Object.hasOwn(variables, key)) return read('variables', key, expand)
    if (/^user$/i.test(key)) return '用户'
    // 未解析的嵌套引用交给官方出口清洗，不让扁平插值器截断它。
    if (whole.slice(2, -2).includes('{{')) return whole
    return interpolateVariables(whole, {}, session, undefined, `${sourceKey}:${path}`)
  })
}
