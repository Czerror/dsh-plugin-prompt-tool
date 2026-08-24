/**
 * anchor-match — 关键词锚定匹配引擎（纯函数，无状态，无依赖）。
 *
 * 从 strategies 拆解：custom-fallback（自定义锚定词）与 world-book（关键词触发）
 * 共用同一套匹配语义——主键/副键、大小写、整词、正则、组合逻辑。
 *
 * 逻辑对齐 ST world_info_logic：
 *   any  = AND_ANY(0)：主键或副键任一命中即激活（world-book 默认 / custom-fallback 单锚）；
 *   all     = AND_ALL(3)：主键命中且副键全部命中；
 *   not     = NOT_ALL(1)：主键命中且副键全部未命中（排除）；
 *   notAny  = NOT_ANY(2)：主键命中且至少一个副键未命中（部分排除）。
 *
 * 模式：
 *   scan   = 全文扫描（world-book 消息批匹配）；
 *   prefix = 文本开头匹配（custom-fallback 首轮 reasoning 锚定确认：ASCII 词边界前缀，
 *            非 ASCII 直 prefix）。
 */

/** 组合逻辑（ST world_info_logic 映射）。 */
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

/** ST 正则键检测（对齐 world-info.js parseRegexFromString）：
 *  仅 /pattern/flags 显式包裹的键按正则匹配，其余一律字面（含 {{user}} 等
 *  含花括号/正则特殊字符的普通键——ST 不做特殊字符自动检测）。 */
export function isRegexKey(key) {
  return parseRegexFromString(key) !== undefined
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
function compileSingle(key, { caseSensitive, wholeWords, useRegex }) {
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
  } = options
  const primaryList = compileKeyList(keys, { caseSensitive, wholeWords, useRegex })
  const secondaryList = compileKeyList(secondaryKeys, { caseSensitive, wholeWords, useRegex })

  const scan = (raw) => {
    const text = String(raw ?? '')
    if (mode === 'prefix') {
      // custom-fallback 锚定确认：仅主键首词，文本开头匹配。
      const word = (Array.isArray(keys) ? keys : []).map((key) => String(key).trim())
        .find((key) => key.length > 0)
      if (word === undefined || text.length === 0) return { primary: 0, secondary: 0, active: false }
      const hit = /^[\x20-\x7E]+$/.test(word)
        ? new RegExp(`^${escapeRegExp(word.toLowerCase())}\\b`, 'i').test(text)
        : text.startsWith(word)
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
