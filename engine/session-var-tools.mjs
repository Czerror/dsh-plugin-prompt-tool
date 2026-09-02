/** 会话变量工具预设模块。 */
export const name = "session-var-tools"

export function apply(ctx) {
  const service = ctx.get("pt-session-var-tools")
  if (service === null || service === undefined || typeof service.mount !== "function") {
    ctx.logger?.warn(name + ": service unavailable; session-var tools not mounted for this preset")
    return
  }
  ctx.effect(() => service.mount(ctx), name + ": mount")
}
