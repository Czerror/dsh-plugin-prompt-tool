/**
 * interpolate — 模板变量插值引擎（纯函数，无依赖）。
 *
 * 从 shared 拆出：{{key}} 插值是引擎官方对齐的核心语义（variables 优先 + 内置
 * 兜底），独立为纯能力包，与 anchor-match 同级；消费方（layers / executor /
 * fillers）按需引用。
 *
 * 插值规则：
 *   - {{key}}：配置 variables 有值 → 替换；否则 ST 运行时宏（lastusermessage /
 *     lastcharmessage 等，大小写不敏感）→ 会话事件提取；否则动态宏（roll/random/
 *     pick/chance/time/date 等，支持 {{name::arg}} 参数）→ 运行时计算；否则内置
 *     变量（DSH_HOME / WORKSPACE / CWD）→ 替换；否则保留字面（宽容）。
 *   - 键字符集：字母数字、下划线、点、中文、连字符（与 ST setvar/getvar 一致）。
 */

import { sessionEvents } from './shared.mjs'
import { createHash } from 'node:crypto'

/** 会话事件中最后一条指定类型消息的文本（事件倒序扫描；无则空串）。 */
function lastMessageOf(session, type) {
  const events = sessionEvents(session)
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (event?.type !== type) continue
    const content = event.data?.message?.content
    if (!Array.isArray(content)) continue
    const text = content
      .map((block) => (block !== null && typeof block === 'object' && typeof block.text === 'string') ? block.text : '')
      .join('')
      .trim()
    if (text.length > 0) return text
  }
  return ''
}

/** ST 双冒号/逗号列表；有 seed 时稳定选择，否则每次采样。 */
function pickRandom(arg, seed) {
  const input = String(arg ?? '')
  const items = input.includes('::') ? input.split('::')
    : input.split(/(?<!\\),/).map(item => item.trim().replaceAll('\\,', ','))
  if (items.length === 0) return ''
  const random = seed === undefined ? Math.random() : createHash('sha256').update(seed).digest().readUInt32BE() / 2 ** 32
  return items[Math.floor(random * items.length)]
}

/** 骰子表达式（{{roll::2d6+3}} / {{roll::6}}；非法或不安全输入为空）。 */
function rollDice(arg) {
  const raw = String(arg ?? '').replace(/\s+/g, '').toLowerCase()
  const text = /^\d+$/.test(raw) ? `1d${raw}` : raw
  const match = text.match(/^(\d*)d(\d+)([+-]\d+)?$/)
  if (match === null) return ''
  const count = match[1] === '' ? 1 : Number.parseInt(match[1], 10)
  const sides = Number.parseInt(match[2], 10)
  const modifier = match[3] === undefined ? 0 : Number.parseInt(match[3], 10)
  if (!Number.isSafeInteger(count) || count <= 0 || count > 100 || !Number.isSafeInteger(sides) || sides <= 0 || !Number.isSafeInteger(modifier) || !Number.isSafeInteger(count * sides + Math.abs(modifier))) return ''
  let sum = 0
  for (let index = 0; index < count; index++) sum += 1 + Math.floor(Math.random() * sides)
  return String(sum + modifier)
}

/** 百分比概率（{{chance::50}} → true/false）。 */
function chancePercent(arg) {
  const value = Number(String(arg ?? '').replace('%', '').trim())
  if (!Number.isFinite(value)) return ''
  return Math.random() * 100 < value ? 'true' : 'false'
}

/** 本地 HH:MM（{{time}}）。 */
function formatTime(now) {
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
}

/** 本地 YYYY-MM-DD（{{date}}）；UTC 日期由 isodate 提供。 */
function formatDate(now) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

/** ST 动态宏（大小写不敏感；函数签名 (arg) => string；无会话上下文时同样可用）。 */
const DYNAMIC_MACROS = {
  lastusermessage: (_arg, session) => lastMessageOf(session, 'user/message'),
  lastcharmessage: (_arg, session) => lastMessageOf(session, 'assistant/message'),
  // charIfNotGroup：ST 群聊时空、单聊为角色名；dsh 会话 header 无角色名
  //（单角色会话），统一返回空串（不残留字面，也不注入错误内容）。
  charifnotgroup: () => '',
  random: (arg) => pickRandom(arg),
  pick: (arg) => pickRandom(arg),
  roll: (arg) => rollDice(arg),
  chance: (arg) => chancePercent(arg),
  time: () => formatTime(new Date()),
  date: () => formatDate(new Date()),
  weekday: () => '星期' + '日一二三四五六'[new Date().getDay()],
  isotime: () => new Date().toISOString().slice(11, 19),
  isodate: () => new Date().toISOString().slice(0, 10),
  newline: () => '\n',
  pipe: () => '|',
}

/** 内置变量：路径类事实（无会话上下文时回退进程 cwd）；两条插值通道同源。 */
function builtinVariables(session) {
  return {
    DSH_HOME: process.env.DSH_HOME ?? (process.env.USERPROFILE ? `${process.env.USERPROFILE}\\.dsh` : ''),
    WORKSPACE: process.env.DSH_WORKSPACE ?? session?.header?.cwd ?? process.cwd(),
    CWD: session?.header?.cwd ?? process.cwd(),
  }
}

/** 模板变量插值：配置 variables 优先，ST 运行时宏次之，内置 {{DSH_HOME}} / {{WORKSPACE}} / {{CWD}} 兜底。 */
export function interpolateVariables(text, variables, session, keep, sourceId = '') {
  const builtins = builtinVariables(session)
  const active = new Set()
  // 限制展开增加的字符数、递归深度与工作量；原始正文不截断，失败引用留给出口清洗。
  let remainingChars = 1024 * 1024
  let remainingExpansions = 4096
  function render(input, depth = 0) {
    return normalizeMacroSyntax(input).replace(REFERENCE_RE, (whole, key, arg, offset) => {
      if (arg === undefined && keep?.has(key)) return `{{${key}}}`
      if (active.has(key)) return whole
      let value
      if (Object.hasOwn(variables, key)) value = String(variables[key] ?? '')
      else if (key.toLowerCase() === 'pick') value = pickRandom(arg, JSON.stringify([session?.id ?? '', sourceId, input, offset]))
      else if (Object.hasOwn(DYNAMIC_MACROS, key.toLowerCase())) value = DYNAMIC_MACROS[key.toLowerCase()](arg, session)
      else if (Object.hasOwn(builtins, key)) value = builtins[key]
      else return whole
      const growth = Math.max(0, value.length - whole.length)
      const nested = value.includes('{{')
      if (growth > remainingChars || (nested && (depth >= 32 || remainingExpansions <= 0))) return whole
      remainingChars -= growth
      if (!nested) return value
      remainingExpansions--
      active.add(key)
      try {
        return render(value, depth + 1)
      } finally {
        active.delete(key)
      }
    })
  }
  return render(text)
}

/**
 * 静态层插值：配置 variables 优先，ST 运行时宏取空串，内置路径变量按无会话语义解析。
 * @param keep 需要交给官方变量通道按 assembly 求值的名字（运行时事实与已注册变量）——
 *   命中即原样保留引用，不做静态替换。
 */
export function interpolateStatic(text, variables, keep) {
  return interpolateVariables(text, variables, undefined, keep)
}

/**
 * 需要按 assembly 求值的运行时事实（官方变量注册用）。
 * random/pick/roll/chance 是「每次出现各算一次」的求值宏，newline/pipe 是字面宏，
 * 都不在其中——它们继续由 interpolate* 内联处理。
 */
export const RUNTIME_FACTS = new Set([
  'lastusermessage',
  'lastcharmessage',
  'charifnotgroup',
  'time',
  'date',
  'weekday',
  'isotime',
  'isodate',
])

/**
 * 运行时事实求值（大小写不敏感）。非事实名返回 undefined。
 * @param session 会话对象；缺省时按静态语义（运行时宏为空、时间取当前值）。
 */
export function runtimeFactValue(name, session) {
  const key = String(name ?? '').toLowerCase()
  if (!RUNTIME_FACTS.has(key)) return undefined
  return DYNAMIC_MACROS[key](undefined, session)
}

/**
 * 引用正则：键允许字母数字、下划线、点、中文与连字符（与 ST setvar/getvar 一致），
 * `::` 之后是本项目宏参数。官方插值语法更窄，故这两条通道各用各的。
 */
const REFERENCE_RE = /\{\{\s*([A-Za-z0-9_.\u4e00-\u9fff-]+)\s*(?:::([^{}]*?))?\}\}/g

/** ST 宏形态 → 本项目语法（幂等）。 */
const MACRO_ALIASES = 'roll|random|pick|chance'
/** 空格形态：{{roll 1d6}}（ST 语料常见，本项目语法要求 ::）。 */
const MACRO_SPACE_RE = new RegExp(`\\{\\{\\s*(${MACRO_ALIASES})\\s+([^{}]*?)\\s*\\}\\}`, 'gi')
/** 单冒号形态：{{roll:1d6}}（`::` 已是本项目语法，用负向断言排除）。 */
const MACRO_SINGLE_COLON_RE = new RegExp(`\\{\\{\\s*(${MACRO_ALIASES})\\s*:(?!:)\\s*([^{}]*?)\\s*\\}\\}`, 'gi')

/**
 * ST 宏写法归一：{{roll 1d6}} / {{roll:1d6}} → {{roll::1d6}}。
 * 与 `src/host/sillytavern.ts` 的导入期归一同源（两处物理隔离，改动需同步）。
 */
export function normalizeMacroSyntax(text) {
  return text
    .replace(MACRO_SPACE_RE, (_whole, macro, arg) => `{{${String(macro).toLowerCase()}::${arg}}}`)
    .replace(MACRO_SINGLE_COLON_RE, (_whole, macro, arg) => `{{${String(macro).toLowerCase()}::${arg}}}`)
}

/**
 * 官方插值通道（system-section / runtime-context）专用清洗。
 *
 * 官方 renderPrompt 对 section/context 文本做严格插值：畸形引用、`{{}}`、未注册名、
 * 值为 undefined 都抛错并让整轮 assembly 失败，而 runtime-context 在 0.1.6 没有
 * `interpolate:false`（PromptContext 无该字段）。因此交给官方之前必须保证文本里
 * 不再有本项目解析后残留的引用：
 *   - `{{…}}` 成组引用（含畸形名字）→ 整段剥离（决策：未命中引用剥离）；
 *   - 有 `{{` 却没成组、但后文存在 `}}` → 只移除 `{{`（官方判畸形），保留可见文本；
 *   - 只有 `{{` 且其后无 `}}` → 官方按字面处理，原样保留。
 * @returns 清洗后文本与已剥离片段（供调用方一次性告警）。
 */
export function stripUnresolvedRefs(text, keep) {
  const stripped = []
  let out = ''
  let index = 0
  while (index < text.length) {
    const open = text.indexOf('{{', index)
    if (open < 0) {
      out += text.slice(index)
      break
    }
    out += text.slice(index, open)
    const rest = text.slice(open)
    const group = /^\{\{([^{}]*)\}\}/.exec(rest)
    if (group !== null) {
      // 白名单（已注册的官方变量名）原样保留，交给官方按 assembly 求值。
      if (/^[a-z][a-z0-9_]*$/.test(group[1]) && keep?.has(group[1])) {
        out += group[0]
        index = open + group[0].length
        continue
      }
      stripped.push(group[0])
      index = open + group[0].length
      continue
    }
    if (rest.indexOf('}}', 2) >= 0) {
      stripped.push(rest.slice(0, 2))
      index = open + 2
      continue
    }
    out += '{{'
    index = open + 2
  }
  return { text: out, stripped }
}
