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

/** 会话事件中最后一条指定类型消息的文本（事件倒序扫描；无则空串）。 */
function lastMessageOf(session, type) {
  const events = session?.events
  if (!Array.isArray(events)) return ''
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

/** 逗号分隔随机选一个（{{random::a,b,c}} / {{pick::a,b,c}}）。 */
function pickRandom(arg) {
  const items = String(arg ?? '').split(',').map((item) => item.trim()).filter((item) => item.length > 0)
  if (items.length === 0) return ''
  return items[Math.floor(Math.random() * items.length)]
}

/** 骰子表达式（{{roll::2d6+3}} / {{roll::1d20}}；非法表达式原样返回）。 */
function rollDice(arg) {
  const text = String(arg ?? '').replace(/\s+/g, '').toLowerCase()
  const match = text.match(/^(\d*)d(\d+)([+-]\d+)?$/)
  if (match === null) return text
  const count = match[1] === '' ? 1 : Number.parseInt(match[1], 10)
  const sides = Number.parseInt(match[2], 10)
  const modifier = match[3] === undefined ? 0 : Number.parseInt(match[3], 10)
  if (!Number.isSafeInteger(count) || count <= 0 || count > 100 || !Number.isSafeInteger(sides) || sides <= 0) return text
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

/** UTC YYYY-MM-DD（{{date}}）。 */
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

/** 模板变量插值：配置 variables 优先，ST 运行时宏次之，内置 {{DSH_HOME}} / {{WORKSPACE}} / {{CWD}} 兜底。 */
export function interpolateVariables(text, variables, session) {
  const builtins = {
    DSH_HOME: process.env.DSH_HOME ?? (process.env.USERPROFILE ? `${process.env.USERPROFILE}\\.dsh` : ''),
    WORKSPACE: process.env.DSH_WORKSPACE ?? session?.header?.cwd ?? process.cwd(),
    CWD: session?.header?.cwd ?? process.cwd(),
  }
  return text.replace(/\{\{([A-Za-z0-9_.\u4e00-\u9fff-]+)(?:::(.*?))?\}\}/g, (whole, key, arg) => {
    if (Object.prototype.hasOwnProperty.call(variables, key)) return String(variables[key])
    const dynamic = DYNAMIC_MACROS[key.toLowerCase()]
    if (dynamic !== undefined) return dynamic(arg, session)
    return Object.prototype.hasOwnProperty.call(builtins, key) ? builtins[key] : whole
  })
}

/** 仅做配置级静态变量替换（无 session 上下文的层）。 */
export function interpolateStatic(text, variables) {
  return text.replace(/\{\{([A-Za-z0-9_.\u4e00-\u9fff-]+)(?:::(.*?))?\}\}/g, (whole, key, arg) => {
    if (Object.prototype.hasOwnProperty.call(variables, key)) return String(variables[key])
    // ST 运行时宏在无会话上下文（system-section 注册期）时替换为空串——
    // 不残留字面，也不触发官方 unknown variable 渲染报错。
    const dynamic = DYNAMIC_MACROS[key.toLowerCase()]
    return dynamic !== undefined ? dynamic(arg, undefined) : whole
  })
}
