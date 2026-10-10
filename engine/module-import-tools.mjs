/** 角色卡库工具预设模块。 */
export const name = "module-import-tools"

export function apply(ctx) {
  ctx.inject(["pt-module-import-tools"], (scopeCtx) => {
    scopeCtx.effect(() => scopeCtx.get("pt-module-import-tools").mount(scopeCtx), name + ": mount")
  })
}
