/** 角色卡库工具预设模块。 */
export const name = "character-tools"

export function apply(ctx) {
  ctx.inject(["pt-character-tools"], (scopeCtx) => {
    scopeCtx.effect(() => scopeCtx.get("pt-character-tools").mount(scopeCtx), name + ": mount")
  })
}
