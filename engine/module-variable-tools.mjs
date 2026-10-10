/** 两级持久模块变量工具，按声明等待宿主 provider。 */
export const name = 'module-variable-tools'

export function apply(ctx) {
  ctx.inject(['pt-module-variable-tools'], scopeCtx => {
    scopeCtx.effect(() => scopeCtx.get('pt-module-variable-tools').mount(scopeCtx), name + ': mount')
  })
}
