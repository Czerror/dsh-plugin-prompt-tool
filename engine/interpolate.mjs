/**
 * interpolate — 模板变量插值引擎（纯函数，无依赖）。
 *
 * 从 shared 拆出：{{key}} 插值是引擎官方对齐的核心语义（variables 优先 + 内置
 * 兜底），独立为纯能力包，与 anchor-match 同级；消费方（layers / executor /
 * fillers）按需引用。
 *
 * 插值规则：
 *   - {{key}}：配置 variables 有值 → 替换；否则 ST 运行时宏（lastusermessage /
 *     lastcharmessage 等，大小写不敏感）→ 会话事件提取；否则内置变量（DSH_HOME /
 *     WORKSPACE / CWD）→ 替换；否则保留字面（宽容，未注册变量不抛错）。
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

/** ST 运行时宏（会话上下文，大小写不敏感；无会话上下文时为空串——不残留字面）。 */
const DYNAMIC_MACROS = {
  lastusermessage: (session) => lastMessageOf(session, 'user/message'),
  lastcharmessage: (session) => lastMessageOf(session, 'assistant/message'),
  // charIfNotGroup：ST 群聊时空、单聊为角色名；dsh 会话 header 无角色名
  //（单角色会话），统一返回空串（不残留字面，也不注入错误内容）。
  charifnotgroup: () => '',
}

/** 模板变量插值：配置 variables 优先，ST 运行时宏次之，内置 {{DSH_HOME}} / {{WORKSPACE}} / {{CWD}} 兜底。 */
export function interpolateVariables(text, variables, session) {
  const builtins = {
    DSH_HOME: process.env.DSH_HOME ?? (process.env.USERPROFILE ? `${process.env.USERPROFILE}\\.dsh` : ''),
    WORKSPACE: process.env.DSH_WORKSPACE ?? session?.header?.cwd ?? process.cwd(),
    CWD: session?.header?.cwd ?? process.cwd(),
  }
  return text.replace(/\{\{([A-Za-z0-9_.\u4e00-\u9fff-]+)\}\}/g, (whole, key) => {
    if (Object.prototype.hasOwnProperty.call(variables, key)) return String(variables[key])
    const dynamic = DYNAMIC_MACROS[key.toLowerCase()]
    if (dynamic !== undefined) return dynamic(session)
    return Object.prototype.hasOwnProperty.call(builtins, key) ? builtins[key] : whole
  })
}

/** 仅做配置级静态变量替换（无 session 上下文的层）。 */
export function interpolateStatic(text, variables) {
  return text.replace(/\{\{([A-Za-z0-9_.\u4e00-\u9fff-]+)\}\}/g, (whole, key) => {
    if (Object.prototype.hasOwnProperty.call(variables, key)) return String(variables[key])
    // ST 运行时宏在无会话上下文（system-section 注册期）时替换为空串——
    // 不残留字面，也不触发官方 unknown variable 渲染报错。
    const dynamic = DYNAMIC_MACROS[key.toLowerCase()]
    return dynamic !== undefined ? dynamic(undefined) : whole
  })
}
