/** 角色卡库工具预设模块。 */
export const name = "character-tools"

export function apply(ctx) {
  const service = ctx.get("pt-character-tools")
  if (service === null || service === undefined || typeof service.mount !== "function") {
    ctx.logger?.warn(name + ": service unavailable; character tools not mounted for this preset")
    return
  }
  ctx.effect(() => service.mount(ctx), name + ": mount")
}
