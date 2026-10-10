/** 有界模板解析与原生求值；只返回正文和变更，不持有或写入持久状态。 */
import { Buffer } from 'node:buffer'
import { interpolateVariables, isReservedInterpolationName, normalizeMacroSyntax } from './interpolate.mjs'

const MAX_BYTES = 1024 * 1024
const MAX_DEPTH = 32
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function byteLength(text) {
  const size = Buffer.byteLength(text, 'utf8')
  if (size > MAX_BYTES) throw new RangeError('Template text exceeds 1 MiB')
  return size
}

/** JSON 单花括号及字符串内的右括号不构成模板边界。 */
function macroEnd(text, start, depth = 0) {
  const frames = [{ braces: 0, brackets: 0, quote: false, escape: false }]
  if (depth >= MAX_DEPTH) throw new RangeError('Template depth exceeds 32')
  for (let index = start + 2; index < text.length; index++) {
    const frame = frames.at(-1), char = text[index]
    if (frame.escape) { frame.escape = false; continue }
    if (frame.quote && char === '\\') { frame.escape = true; continue }
    if (char === '"' && (frame.quote || frame.braces > 0 || frame.brackets > 0)) { frame.quote = !frame.quote; continue }
    if (text.startsWith('{{', index)) {
      if (depth + frames.length >= MAX_DEPTH) throw new RangeError('Template depth exceeds 32')
      frames.push({ braces: 0, brackets: 0, quote: false, escape: false }); index++; continue
    }
    if (frame.quote) continue
    if (char === '{') frame.braces++
    else if (char === '}' && frame.braces > 0) frame.braces--
    else if (text.startsWith('}}', index)) {
      frames.pop()
      if (!frames.length) return index + 2
      index++
    } else if (char === '[') frame.brackets++
    else if (char === ']') frame.brackets = Math.max(0, frame.brackets - 1)
  }
  return -1
}

/** ST 编辑残片不是可执行表达式；只保留顶层尾部未知裸名，不放宽操作或嵌套语法。 */
function isLiteralFragment(text) {
  const match = /^\{\{\s*([A-Za-z0-9_.\u4e00-\u9fff-]+)\s*\}?$/.exec(text.trimEnd())
  if (!match) return false
  const key = match[1]
  return !FORBIDDEN_KEYS.has(key) && !isReservedInterpolationName(key)
    && !/^(?:(?:module|global)(?:\.|$)|(?:set|add|get|inc|dec)(?:global)?var$|char$|charifnotgroup$|user$|trim$|ERA$)/i.test(key)
}

/** 转换端和求值端共用边界与预算；出现身份不含正文字符偏移。 */
export function transformTemplate(text, macro) {
  let work = 0, occurrence = 0
  function walk(source, depth = 0) {
    work += byteLength(source)
    if (work > MAX_BYTES * MAX_DEPTH) throw new RangeError('Template expansion work limit exceeded')
    const chunks = []
    let size = 0, cursor = 0
    const append = value => {
      size += byteLength(value)
      if (size > MAX_BYTES) throw new RangeError('Template output exceeds 1 MiB')
      chunks.push(value)
    }
    while (cursor < source.length) {
      const start = source.indexOf('{{', cursor)
      if (start < 0) { append(source.slice(cursor)); break }
      append(source.slice(cursor, start))
      const end = macroEnd(source, start, depth)
      if (end < 0) {
        const rest = source.slice(start)
        if (depth === 0 && isLiteralFragment(rest)) { append(rest); break }
        throw new TypeError('Unclosed template expression')
      }
      append(macro(source.slice(start + 2, end - 2), value => walk(value, depth + 1), occurrence++))
      cursor = end
    }
    return chunks.join('')
  }
  return walk(text)
}

/** 当前层第一个分隔符；嵌套表达式里的分隔符属于子表达式。 */
export function splitTemplateArgument(text) {
  for (let index = 0; index < text.length; index++) {
    if (text.startsWith('{{', index)) {
      const end = macroEnd(text, index)
      if (end < 0) throw new TypeError('Unclosed template expression')
      index = end - 1
    } else if (text.startsWith('::', index)) return [text.slice(0, index), text.slice(index + 2)]
  }
  return [text, undefined]
}

function addValue(value, increment) {
  const current = value || '0'
  let parsed
  try { parsed = JSON.parse(current) } catch { /* 非 JSON 继续按数值或文本处理。 */ }
  if (Array.isArray(parsed)) { parsed.push(increment); return JSON.stringify(parsed) }
  if (Number.isNaN(Number(increment)) || Number.isNaN(Number(current))) return (value || '') + increment
  const result = Number(current) + Number(increment)
  if (!Number.isFinite(result)) throw new RangeError('Template variable number is not finite')
  return String(result)
}

export function evaluateTemplate(text, { module = {}, global = {}, session, sourceId = '', readOnly = false, samples = new Map() } = {}) {
  const tables = { module: { ...module }, global: { ...global } }
  const reads = new Set(), resolving = new Set(), values = {}
  let scope, pick = 0
  const keyOf = key => {
    if (!key || FORBIDDEN_KEYS.has(key) || isReservedInterpolationName(key)) throw new TypeError(`Template variable key blocked: ${key}`)
    return key
  }
  const raw = (domain, key) => {
    reads.add(domain)
    if (Object.hasOwn(tables[domain], key)) return { domain, value: tables[domain][key] }
    if (domain === 'module') {
      reads.add('global')
      if (Object.hasOwn(tables.global, key)) return { domain: 'global', value: tables.global[key] }
    }
    return undefined
  }
  const read = (found, key, expand) => {
    if (!found) return ''
    const id = `${found.domain}:${key}`
    if (resolving.has(id)) throw new RangeError(`Template variable cycle: ${id}`)
    resolving.add(id)
    try { return expand(String(found.value)) } finally { resolving.delete(id) }
  }
  const write = (domain, key, value) => {
    if (readOnly) throw new TypeError('Read-only template cannot write variables')
    if (scope !== undefined && scope !== domain) throw new TypeError('One template may write only one variable scope')
    byteLength(value)
    scope = domain
    tables[domain][key] = value
    values[key] = value
  }
  const output = transformTemplate(text, (body, expand, occurrence) => {
    const [name, args] = splitTemplateArgument(body)
    const operation = /^(module|global)\.(set|get|add|inc|dec)$/.exec(name.trim())
    if (operation) {
      if (args === undefined) throw new TypeError(`Missing arguments for ${name}`)
      const [rawKey, rawValue] = splitTemplateArgument(args)
      const key = keyOf(expand(rawKey).trim()), domain = operation[1], action = operation[2]
      if (readOnly && (action !== 'get' || rawValue !== undefined)) throw new TypeError('Read-only template cannot write variables')
      if (action === 'get') {
        const found = raw(domain, key)
        if (found) return read(found, key, expand)
        const fallback = rawValue === undefined ? '' : expand(rawValue)
        if (fallback !== '') write(domain, key, fallback)
        return fallback
      }
      if ((action === 'set' || action === 'add') && rawValue !== undefined) {
        const value = expand(rawValue)
        write(domain, key, action === 'set' ? value : addValue(read(raw(domain, key), key, expand), value))
        return ''
      }
      if ((action === 'inc' || action === 'dec') && rawValue === undefined) {
        const value = addValue(read(raw(domain, key), key, expand), action === 'inc' ? '1' : '-1')
        write(domain, key, value)
        return value
      }
      throw new TypeError(`Invalid arguments for ${name}`)
    }
    if (/^(set|add|get|inc|dec)(global)?var$/i.test(name.trim())) throw new TypeError('ST variable operations are retired; reimport or explicitly convert to module/global operations')
    const whole = normalizeMacroSyntax(`{{${expand(body)}}}`)
    const [key] = splitTemplateArgument(whole.slice(2, -2))
    if (FORBIDDEN_KEYS.has(key)) throw new TypeError(`Template variable key blocked: ${key}`)
    if (args === undefined && !isReservedInterpolationName(key)) {
      const found = raw('module', key)
      if (found) return read(found, key, expand)
    }
    if (whole.slice(2, -2).includes('{{')) return whole
    const identity = key.toLowerCase() === 'pick' ? `pick:${pick++}` : String(occurrence)
    const sample = `${identity}:${whole}`
    if (!samples.has(sample)) samples.set(sample, interpolateVariables(whole, {}, session, undefined, `${sourceId}:${identity}`))
    return samples.get(sample)
  })
  return { text: output, reads: [...reads], ...(scope === undefined ? {} : { changes: { scope, values } }) }
}
