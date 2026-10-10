/**
 * anchor-match — 关键词锚定匹配引擎（纯函数，无状态，无依赖）。
 *
 * 规则条件、锚定词与上下文激活
 * 共用同一套匹配语义——主键/副键、大小写、整词、正则、组合逻辑。
 *
 * 规则条件逻辑：any=主副键任一命中，all=主键命中且副键全中，
 * not=主键命中且副键全不中，notAny=主键命中且至少一个副键未中。
 * 上下文激活的具名副键逻辑由候选选择器组合命中数，不借用这些名称。
 *
 * 模式：
 *   scan   = 全文扫描；
 *   prefix = 文本开头匹配（custom-fallback 首轮 reasoning 锚定确认：确认词集合任一
 *            前缀命中——ASCII 词边界前缀，非 ASCII 直 prefix）。
 */

/** 规则条件的组合逻辑。 */
export const MATCH_LOGIC = {
  ANY: 'any',
  ALL: 'all',
  NOT: 'not',
  NOT_ANY: 'notAny',
}

/** 正则转义（关键词原样匹配时用）。 */
export function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 键 → RegExp（仅 /pattern/flags 形态，模式内未转义 / 分隔符视为非法）；否则 undefined。 */
export function parseRegexFromString(key) {
  const m = /^\/([\s\S]+?)\/([gimsuy]*)$/u.exec(key)
  if (m === null) return undefined
  // ST 官方：模式内未转义的 / 分隔符非法（其它引擎无法解析该正则）。
  if (/(^|[^\\])\//.test(m[1])) return undefined
  try {
    return new RegExp(m[1].replaceAll('\\/', '/'), m[2])
  } catch {
    return undefined
  }
}

/** 单键正则编译（逐键匹配：any/all/not 需要精确的命中键数，捕获组会干扰 match 计数）。
 *  useRegex 三态：true=强制正则；false=强制字面；缺省=ST 语义自动检测。 */
function compileSingle(key, { caseSensitive, wholeWords, useRegex, wordBoundary }) {
  const flags = caseSensitive ? '' : 'i'
  if (useRegex === true) {
    // ST use_regex=true：键原样作为正则（作者负责合法性）。
    return new RegExp(key, flags)
  }
  if (useRegex === undefined) {
    const auto = parseRegexFromString(key)
    if (auto !== undefined) return auto
  }
  if (wholeWords) {
    if (wordBoundary === 'ascii-token') return new RegExp(key.split(/\s+/).length > 1 ? escapeRegExp(key) : `(?:^|\\W)(${escapeRegExp(key)})(?:$|\\W)`, flags)
    return new RegExp(`(^|[^\\p{L}\\p{N}])(${escapeRegExp(key)})(?![\\p{L}\\p{N}])`, `${flags}u`)
  }
  return new RegExp(escapeRegExp(key), flags)
}

/** 编译键列表 → [{ key, re }]（剔除空键）。 */
function compileKeyList(list, options) {
  return (Array.isArray(list) ? list : [])
    .map((key) => String(key).trim())
    .filter((key) => key.length > 0)
    .map((key) => ({ key, re: compileSingle(key, options) }))
}

/**
 * 创建锚定匹配器。
 * @param {object} options
 * @param {string[]} options.keys 主键
 * @param {string[]} [options.secondaryKeys] 副键
 * @param {boolean} [options.caseSensitive]
 * @param {boolean} [options.wholeWords]
 * @param {boolean} [options.useRegex] 三态：true=强制正则 / false=强制字面 / 缺省=自动检测（ST 语义）
 * @param {'any'|'all'|'not'|'notAny'} [options.logic] 组合逻辑（缺省 any）
 * @param {'scan'|'prefix'} [options.mode] 匹配模式（缺省 scan）
 * @param {'ascii-token'|'unicode'} [options.wordBoundary] 整词边界策略
 * @returns {{ scan: (text: string) => { primary: number, secondary: number, active: boolean } }}
 */
export function createAnchorMatcher(options = {}) {
  const {
    keys = [],
    secondaryKeys = [],
    caseSensitive = false,
    wholeWords = false,
    useRegex = undefined,
    logic = MATCH_LOGIC.ANY,
    mode = 'scan',
    wordBoundary = 'unicode',
  } = options
  if (Object.hasOwn(options, 'stWords')) throw new TypeError('stWords is retired; use wordBoundary')
  if (!['ascii-token', 'unicode'].includes(wordBoundary)) throw new TypeError('Unknown wordBoundary')
  const primaryList = compileKeyList(keys, { caseSensitive, wholeWords, useRegex, wordBoundary })
  const secondaryList = compileKeyList(secondaryKeys, { caseSensitive, wholeWords, useRegex, wordBoundary })

  const scan = (raw) => {
    const text = String(raw ?? '')
    if (mode === 'prefix') {
      // custom-fallback 锚定确认：确认词集合任一前缀命中（any 语义——deep 档
      // Let…/build 档 We…/自定义锚句首词都可作为确认信号）。
      const words = (Array.isArray(keys) ? keys : []).map((key) => String(key).trim())
        .filter((key) => key.length > 0)
      if (words.length === 0 || text.length === 0) return { primary: 0, secondary: 0, active: false }
      const hit = words.some((word) => /^[\x20-\x7E]+$/.test(word)
        ? new RegExp(`^${escapeRegExp(word.toLowerCase())}\\b`, 'i').test(text)
        : text.startsWith(word))
      return { primary: hit ? 1 : 0, secondary: 0, active: hit }
    }
    if (primaryList.length === 0 && secondaryList.length === 0) {
      return { primary: 0, secondary: 0, active: false }
    }
    const countHits = (list) => {
      let hits = 0
      for (const { re } of list) {
        re.lastIndex = 0
        if (re.test(text)) hits += 1
      }
      return hits
    }
    const primary = countHits(primaryList)
    const secondary = countHits(secondaryList)
    let active = false
    if (logic === MATCH_LOGIC.ALL) {
      active = primary > 0 && (secondaryList.length === 0 || secondary === secondaryList.length)
    } else if (logic === MATCH_LOGIC.NOT) {
      active = primary > 0 && secondary === 0
    } else if (logic === MATCH_LOGIC.NOT_ANY) {
      active = primary > 0 && secondaryList.length > 0 && secondary < secondaryList.length
    } else {
      active = primary > 0 || secondary > 0
    }
    return { primary, secondary, active }
  }

  return { scan }
}
