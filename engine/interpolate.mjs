/**
 * interpolate — 模板变量插值引擎（纯函数，无依赖）。
 *
 * 从 shared 拆出：{{key}} 插值是引擎官方对齐的核心语义（variables 优先 + 内置
 * 兜底），独立为纯能力包，与 anchor-match 同级；消费方（layers / executor /
 * fillers）按需引用。
 *
 * 插值规则：
 *   - {{key}}：配置 variables 有值 → 替换；否则内置变量（DSH_HOME / WORKSPACE /
 *     CWD）→ 替换；否则保留字面（宽容，未注册变量不抛错——与官方严格模式互补）。
 *   - 键字符集：字母数字、下划线、点、中文、连字符（与 ST setvar/getvar 一致）。
 */

/** 模板变量插值：配置 variables 优先，内置 {{DSH_HOME}} / {{WORKSPACE}} / {{CWD}}。 */
export function interpolateVariables(text, variables, session) {
  const builtins = {
    DSH_HOME: process.env.DSH_HOME ?? (process.env.USERPROFILE ? `${process.env.USERPROFILE}\\.dsh` : ''),
    WORKSPACE: process.env.DSH_WORKSPACE ?? session?.header?.cwd ?? process.cwd(),
    CWD: session?.header?.cwd ?? process.cwd(),
  }
  return text.replace(/\{\{([A-Za-z0-9_.\u4e00-\u9fff-]+)\}\}/g, (whole, key) => {
    if (Object.prototype.hasOwnProperty.call(variables, key)) return String(variables[key])
    return Object.prototype.hasOwnProperty.call(builtins, key) ? builtins[key] : whole
  })
}

/** 仅做配置级静态变量替换（无 session 上下文的层）。 */
export function interpolateStatic(text, variables) {
  return text.replace(/\{\{([A-Za-z0-9_.\u4e00-\u9fff-]+)\}\}/g, (whole, key) =>
    Object.prototype.hasOwnProperty.call(variables, key) ? String(variables[key]) : whole)
}
