/** 世界书管理工具预设模块。 */
export const name = "world-book-tools"

export function apply(ctx) {
  const service = ctx.get("pt-world-book-tools")
  if (service === null || service === undefined || typeof service.mount !== "function") {
    ctx.logger?.warn(name + ": service unavailable; world-book tools not mounted for this preset")
    return
  }
  ctx.effect(() => service.mount(ctx), name + ": mount")
}
