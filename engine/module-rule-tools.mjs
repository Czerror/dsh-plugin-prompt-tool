/** 完整模块规则工具，按声明等待宿主 provider。 */
export const name = 'module-rule-tools'

export function apply(ctx) {
  ctx.inject(['pt-module-rule-tools'], scopeCtx => {
    scopeCtx.effect(() => scopeCtx.get('pt-module-rule-tools').mount(scopeCtx), name + ': mount')
  })
}
