/** 世界书管理工具预设模块。 */
export const name = "world-book-tools"

export function apply(ctx) {
  ctx.inject(["pt-world-book-tools"], (scopeCtx) => {
    scopeCtx.effect(() => scopeCtx.get("pt-world-book-tools").mount(scopeCtx), name + ": mount")
  })
}
