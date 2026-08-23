/**
 * session-vars — 会话变量（ST setvar/getvar 运行时语义）。
 *
 * 变量挂在 session 对象上（SESSION_VARS_KEY 属性），因此 .engine 引擎实例与
 * 插件进程工具实例（不同模块副本）操作同一 session 即共享同一份数据——
 * 无跨实例状态同步问题。WeakMap 不需要：session 释放后属性随对象回收。
 *
 * 插值优先级：resolved 运行时 > 会话变量 > 配置 params > 配置 variables（含预设）。
 */

/** session 对象上的变量属性键（字符串常量，跨模块实例一致）。 */
export const SESSION_VARS_KEY = '__pt_session_vars__'

function varsOf(session) {
  if (session === null || typeof session !== 'object') return undefined
  let vars = session[SESSION_VARS_KEY]
  if (vars === undefined) {
    vars = {}
    session[SESSION_VARS_KEY] = vars
  }
  return vars
}

/** 会话变量快照（无会话/未设置 → 空对象）。 */
export function sessionVarsSnapshot(session) {
  const vars = varsOf(session)
  return vars === undefined ? {} : { ...vars }
}

/** 读取单个会话变量（未设置 → undefined）。 */
export function getSessionVar(session, key) {
  const vars = varsOf(session)
  return vars === undefined ? undefined : vars[String(key)]
}

/** 设置会话变量（值转字符串；空值仍记录）。 */
export function setSessionVar(session, key, value) {
  const vars = varsOf(session)
  if (vars === undefined) return
  vars[String(key)] = String(value ?? '')
}

/** 清除会话变量；key 缺省时清空全部。 */
export function clearSessionVars(session, key) {
  const vars = varsOf(session)
  if (vars === undefined) return
  if (key === undefined || key === '') {
    for (const name of Object.keys(vars)) delete vars[name]
  } else {
    delete vars[String(key)]
  }
}
