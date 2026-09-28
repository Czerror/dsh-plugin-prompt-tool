/** 会话变量工具预设模块。 */
export const name = "session-var-tools"

export function apply(ctx) {
  ctx.inject(["pt-session-var-tools"], (scopeCtx) => {
    scopeCtx.effect(() => scopeCtx.get("pt-session-var-tools").mount(scopeCtx), name + ": mount")
  })
}
