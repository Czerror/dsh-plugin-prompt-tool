/**
 * pt-builtin-tools — 内置模型工具桥接行（per-session 工具面）。
 *
 * 由 writePreset 按 preset.yml 顶层 builtinTools 段渲染进 agent.cordis.yml；
 * 组合行挂载时向宿主平面的 prompt-tool 插件取 pt-builtin-tools 服务，在
 * 本行 scope 上注册角色卡/世界书/会话变量工具——官方 tools.register 在
 * 组合行 ctx 调用即只对挂载该预设的会话可见（宿主平面注册则全进程可见）。
 *
 * 懒取而非 inject 声明：插件被禁用/异常卸载时服务缺失只降级为「无工具」，
 * 不让组合行 pending 卡死会话挂载（空组合修复的同一教训）。
 *
 * config（writePreset 渲染；缺省视为 true，与 preset.yml 缺省语义一致）：
 *   character  — character_list/import/apply/delete 四件套
 *   worldBook  — world_book_list/upsert/delete 三件套
 *   sessionVar — session_var 会话变量工具
 */

/** Cordis 插件名，供 loader 诊断使用。 */
export const name = 'pt-builtin-tools'

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx 组合行 scope 上下文。
 * @param {Record<string, unknown> | undefined} config 工具组开关。
 */
export function apply(ctx, config) {
  const service = ctx.get('pt-builtin-tools')
  if (service === null || service === undefined || typeof service.mount !== 'function') {
    ctx.logger?.warn(`${name}: pt-builtin-tools service unavailable; builtin model tools not mounted for this preset`)
    return
  }
  ctx.effect(() => service.mount(ctx, config ?? {}), `${name}: mount`)
}
